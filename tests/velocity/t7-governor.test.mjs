// T7: an injected losing streak produces a throttle, then a halt, before the
// daily limit is reached; the governor never amplifies.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../../src/velocity/core/ledger.mjs";
import { Governor } from "../../src/velocity/core/governor.mjs";
import { loadRiskEnvelope } from "../../src/velocity/core/risk.mjs";

const env = loadRiskEnvelope(path.resolve("src/velocity/config/risk.example.json")); // daily limit 100

function mkLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t7-"));
  return new Ledger(path.join(dir, "ledger.jsonl"), { fsync: false });
}

test("T7: losing streak throttles at 3, cuts at 4, halts at 5, all before the daily limit", () => {
  const ledger = mkLedger();
  let t = 1_700_000_000_000;
  const gov = new Governor({ ledger, envelope: env, clock: () => t });
  let realized = 0;
  const seen = [];
  for (let i = 1; i <= 6; i++) {
    t += 5 * 60_000;
    realized -= 8;
    ledger.append({ kind: "fill", venue: "pumpfun", side: "BUY", notional_usd: 10, ts: t - 60_000 });
    ledger.append({ kind: "outcome", venue: "pumpfun", pnl_usd: -8, pnl_pct: -80, stake_usd: 10, p_win: 0.35, confidence: 0.6, held_ms: 60_000, ts: t });
    const v = gov.evaluate({ regime: "RISK_ON", realized_today_usd: realized, open: [] });
    seen.push({ i, throttle: v.throttle, halt: v.halt, reason: v.haltReason, realized });
    assert.ok(v.throttle <= 1);
  }
  // A losing streak is information, never a brake: no throttle, no halt, until the daily limit says so.
  for (const s of seen) if (Math.abs(s.realized) < env.daily_loss_limit_usd * 0.5) { assert.equal(s.throttle, 1, `${s.i} losses: no throttle`); assert.equal(s.halt, false, `${s.i} losses: no halt`); }
  assert.equal(gov.last.streak, 6);
  assert.equal(gov.last.blindSpots.losing_streak?.triggered, false, "shown as informational");
});

test("T7: the daily loss limit tapers the stake instead of halting; only a 3x day is a hard stop", () => {
  const ledger = mkLedger();
  const gov = new Governor({ ledger, envelope: env });
  let t = 1_700_000_000_000;
  const pnls = [20, -30, 15, -40, 10, -45];
  let realized = 0;
  let verdict;
  for (const p of pnls) {
    t += 60_000;
    ledger.append({ kind: "outcome", venue: "polymarket", pnl_usd: p, stake_usd: 50, p_win: 0.9, ts: t });
    realized += p;
    verdict = gov.evaluate({ realized_today_usd: realized, open: [] });
  }
  assert.equal(realized, -70);
  assert.equal(verdict.halt, false);
  // The taper runs from half the limit (full size) to the limit (the floor), so 70% of 100 is 0.7.
  assert.equal(verdict.throttle, 0.7, "past half the limit: smoothly smaller, not stopped");
  // Losing more always means betting less, at every point -- no step, and no lockout.
  const at80 = gov.evaluate({ realized_today_usd: -80, open: [] });
  assert.equal(at80.halt, false, "the limit is a taper now, not a gate");
  assert.equal(at80.throttle, 0.55);
  assert.ok(at80.throttle < verdict.throttle, "monotone: a worse day is never a bigger stake");
  // Past the limit it flattens at the floor and never reaches zero: the bot can still trade back.
  const past = gov.evaluate({ realized_today_usd: -150, open: [] });
  assert.equal(past.halt, false);
  assert.equal(past.throttle, 0.25);
  // Money still at risk counts against the taper the same as money already lost.
  const v3 = gov.evaluate({ realized_today_usd: -30, open: [{ notional_usd: 80, worst_case_fraction: 1 }] });
  assert.equal(v3.throttle, 0.25, "realized plus open worst case past the limit sits at the floor");
  // The one hard stop left is a fault, not a drawdown: 3x the daily limit in one day.
  const broken = gov.evaluate({ realized_today_usd: -300, open: [] });
  assert.equal(broken.halt, true);
  assert.equal(broken.haltReason, "daily_breaker");
});

test("T7: regime caps, overconfidence, revenge, and never above 1", () => {
  const ledger = mkLedger();
  const gov = new Governor({ ledger, envelope: env });
  assert.equal(gov.evaluate({ regime: "PVP" }).throttle, 0.4);
  assert.equal(gov.evaluate({ regime: "EUPHORIA" }).throttle, 1, "euphoria never amplifies");
  assert.equal(gov.evaluate({ regime: "DEAD" }).halt, true);

  let t = 1_700_000_000_000;
  // 24 outcomes stating p_win 0.8, winning 30%: overconfident.
  for (let i = 0; i < 24; i++) {
    t += 10 * 60_000;
    ledger.append({ kind: "outcome", venue: "pumpfun", pnl_usd: i % 10 < 3 ? 12 : -5, stake_usd: 10, p_win: 0.8, ts: t });
  }
  const v = gov.evaluate({ regime: "RISK_ON", realized_today_usd: 0 });
  assert.ok(v.blindSpots.overconfidence?.triggered, JSON.stringify(v.blindSpots));
  assert.ok(v.throttle <= 0.5);

  // Revenge: bigger buys right after losses.
  const l2 = mkLedger();
  const g2 = new Governor({ ledger: l2, envelope: env });
  t = 1_700_000_000_000;
  for (let i = 0; i < 3; i++) {
    t += 30 * 60_000;
    l2.append({ kind: "outcome", venue: "pumpfun", pnl_usd: -5, stake_usd: 10, p_win: 0.35, ts: t });
    l2.append({ kind: "fill", venue: "pumpfun", side: "BUY", notional_usd: 25, ts: t + 30_000 });
  }
  const r = g2.evaluate({ regime: "RISK_ON" });
  assert.ok(r.blindSpots.revenge_trading?.triggered);
  assert.equal(r.throttle, 0.5);
});

test("T7: a paper venue's losses cannot halt live trading, nor fund it", async () => {
  const { Engine } = await import("../../src/velocity/core/engine.mjs");
  const { loadRiskEnvelope } = await import("../../src/velocity/core/risk.mjs");
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { PumpfunPaperRouter } = await import("../../src/velocity/venues/pumpfun/router.mjs");
  const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperlive-"));
  const base = JSON.parse(fs.readFileSync(path.resolve("src/velocity/config/risk.example.json"), "utf8"));
  const cfg = { ...base, bankroll_usd: 200, per_trade_max_usd: 25, portfolio_max_exposure_usd: 100, daily_loss_limit_usd: 20, max_concurrent_positions: 4 };
  cfg.venues = { ...base.venues, pumpfun: { ...base.venues.pumpfun, max_exposure_usd: 100, min_stake_usd: 5 }, polymarket: { ...base.venues.polymarket, max_exposure_usd: 0 } };
  fs.writeFileSync(path.join(dir, "risk.json"), JSON.stringify(cfg));
  const env = loadRiskEnvelope(path.join(dir, "risk.json"));
  const edge = makePumpfunEdge({ aggression: 1 });
  const mk = () => new Engine({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pl-")), envelope: env,
    venues: { pumpfun: { mode: "paper", edge, router: new PumpfunPaperRouter({ bookFile: path.join(dir, "b.json"), latencyMs: 0 }) } } });

  const e = mk();
  const book = (pnl, paper) => e._bookExit(
    { id: `p${Math.abs(pnl)}${paper}`, venue: "pumpfun", instrument: "M", status: "open", paper, qty: 1, remaining_qty: 1,
      cost_usd: 25, proceeds_usd: 0, stake_usd: 25, entryTime: 0, plan: { key: 2 } },
    { ok: true, fill: { price: 1, qty: 1, notional_usd: 25 + pnl, fee_usd: 0, t_filled: 1, paper } }, 100, "TEST");

  // A simulated $30 loss is more than the whole $20 daily limit.
  book(-30, true);
  assert.equal(e.store.state.day.realizedUsd, 0, "no real money lost");
  assert.equal(e.store.state.day.paperRealizedUsd, -30);
  // Nothing is live, so the simulation runs against its own limit -- the promote gate needs that.
  assert.equal(e.realizedToday(), -30);
  // Turn a venue live: the real budget is untouched by what the simulation did.
  e.store.setVenueMode?.("pumpfun", "live");
  if (e.store.venueMode("pumpfun") === "live") {
    assert.equal(e.realizedToday(), 0, "a live venue counts only real money");
    book(-5, false);
    assert.equal(e.realizedToday(), -5);
    assert.equal(e.store.state.day.paperRealizedUsd, -30, "the paper tally is kept, just not spent");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T7: a simulated position does not hold a real concurrency slot", async () => {
  const { Engine } = await import("../../src/velocity/core/engine.mjs");
  const { loadRiskEnvelope } = await import("../../src/velocity/core/risk.mjs");
  const { makePumpfunEdge } = await import("../../src/velocity/venues/pumpfun/edge.mjs");
  const { PumpfunPaperRouter } = await import("../../src/velocity/venues/pumpfun/router.mjs");
  const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slots-"));
  const base = JSON.parse(fs.readFileSync(path.resolve("src/velocity/config/risk.example.json"), "utf8"));
  const cfg = { ...base, bankroll_usd: 200, per_trade_max_usd: 25, portfolio_max_exposure_usd: 100, daily_loss_limit_usd: 50, max_concurrent_positions: 2 };
  cfg.venues = { ...base.venues, pumpfun: { ...base.venues.pumpfun, max_exposure_usd: 100, min_stake_usd: 5 }, polymarket: { ...base.venues.polymarket, max_exposure_usd: 0 } };
  fs.writeFileSync(path.join(dir, "risk.json"), JSON.stringify(cfg));
  const edge = makePumpfunEdge({ aggression: 1 });
  const e = new Engine({ dataDir: dir, envelope: loadRiskEnvelope(path.join(dir, "risk.json")),
    venues: { pumpfun: { mode: "paper", edge, router: new PumpfunPaperRouter({ bookFile: path.join(dir, "b.json"), latencyMs: 0 }) } } });

  const add = (id, paper) => e.store.upsertPosition({ id, venue: "pumpfun", instrument: id, status: "open", paper,
    qty: 1, remaining_qty: 1, notional_usd: 25, cost_usd: 25, stake_usd: 25, entryTime: 0, worst_case_fraction: 1 });
  add("sim1", true); add("sim2", true);
  // Everything is paper: the simulation is held to the same caps, or the promote gate means nothing.
  assert.equal(e.portfolioSnapshot().open.length, 2);
  // One venue goes live. The two simulated positions must not be occupying its two slots.
  e.store.setVenueMode("pumpfun", "live");
  assert.equal(e.portfolioSnapshot().open.length, 0, "no real money is at risk, so no real slot is taken");
  add("real1", false);
  assert.equal(e.portfolioSnapshot().open.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
