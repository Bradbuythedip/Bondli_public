// T3: random GOs and random open books never breach any cap; the envelope
// cannot be raised at runtime; a bad risk file is refused with the field named.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRiskEnvelope, validateRisk, Sizer, deepFreeze, kellyFraction } from "../../src/velocity/core/risk.mjs";

const EXAMPLE = path.resolve("src/velocity/config/risk.example.json");

function lcg(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; }

test("T3: example envelope validates and loads frozen", () => {
  const env = loadRiskEnvelope(EXAMPLE);
  assert.ok(Object.isFrozen(env));
  assert.ok(Object.isFrozen(env.venues.pumpfun.latency_budget_ms));
  assert.throws(() => { env.per_trade_max_usd = 9999; }, TypeError);
  assert.throws(() => { env.venues.pumpfun.max_exposure_usd = 1e9; }, TypeError);
  assert.equal(env.per_trade_max_usd, 50);
  const v = validateRisk(JSON.parse(fs.readFileSync(EXAMPLE, "utf8")));
  assert.equal(v.ok, true);
  assert.equal(v.summary.daily_loss_limit_usd, 100);
  assert.equal(v.summary.venues.perps.enabled, false);
});

test("T3: bad risk files are refused with the field named", () => {
  const base = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
  const bad1 = { ...base, per_trade_max_usd: 5000 };
  assert.ok(validateRisk(bad1).errors.some(e => e.startsWith("per_trade_max_usd")));
  const bad2 = JSON.parse(JSON.stringify(base)); bad2.venues.pumpfun.kelly_fraction = 0.9;
  assert.ok(validateRisk(bad2).errors.some(e => e.includes("venues.pumpfun.kelly_fraction")));
  const bad3 = JSON.parse(JSON.stringify(base)); delete bad3.venues.polymarket;
  assert.ok(validateRisk(bad3).errors.some(e => e.includes("venues.polymarket")));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velocity-t3-"));
  const f = path.join(dir, "risk.json");
  fs.writeFileSync(f, JSON.stringify(bad1));
  assert.throws(() => loadRiskEnvelope(f), /per_trade_max_usd/);
  assert.throws(() => loadRiskEnvelope(path.join(dir, "missing.json")), /not found/);
  fs.writeFileSync(f, "{not json");
  assert.throws(() => loadRiskEnvelope(f), /not valid JSON/);
});

test("T3: property test, 5000 random sizings never breach a cap", () => {
  const env = loadRiskEnvelope(EXAMPLE);
  const sizer = new Sizer(env);
  const rnd = lcg(7);
  const venues = ["pumpfun", "polymarket", "perps"];
  const groups = ["g1", "g2", "g3", null];
  let nonZero = 0;
  for (let i = 0; i < 5000; i++) {
    const venue = venues[Math.floor(rnd() * venues.length)];
    const open = [];
    const nOpen = Math.floor(rnd() * 8);
    for (let k = 0; k < nOpen; k++) {
      const v = venues[Math.floor(rnd() * 2)];
      open.push({ venue: v, group: groups[Math.floor(rnd() * groups.length)], notional_usd: +(rnd() * 60).toFixed(2), worst_case_fraction: v === "pumpfun" ? 1 : rnd() < 0.5 ? 1 : 0.15 });
    }
    const realized = +((rnd() - 0.7) * 150).toFixed(2); // mostly losses, sometimes gains
    const decision = { venue, p_win: rnd(), payoff: rnd() * 5, group: groups[Math.floor(rnd() * groups.length)], stop_fraction: rnd() < 0.5 ? 1 : 0.15 };
    const throttle = rnd() < 0.2 ? 0 : rnd();
    const portfolio = { open, realized_today_usd: realized };
    const r = sizer.size({ decision, portfolio, throttle, halted: rnd() < 0.05 });
    const stake = r.stake_usd;
    assert.ok(stake >= 0 && Number.isFinite(stake));
    if (stake === 0) continue;
    nonZero++;
    const vc = env.venues[venue];
    const totalOpen = open.reduce((s, p) => s + p.notional_usd, 0);
    const venueOpen = open.filter(p => p.venue === venue).reduce((s, p) => s + p.notional_usd, 0);
    const openRisk = open.reduce((s, p) => s + p.notional_usd * p.worst_case_fraction, 0);
    const stop = Math.max(decision.stop_fraction, vc.worst_case_fraction);
    assert.ok(stake <= env.per_trade_max_usd + 1e-9, "per trade");
    assert.ok(stake + venueOpen <= vc.max_exposure_usd + 1e-9, "venue exposure");
    assert.ok(stake + totalOpen <= env.portfolio_max_exposure_usd + 1e-9, "portfolio exposure");
    assert.ok(stake * stop + openRisk + Math.max(0, -realized) <= env.daily_loss_limit_usd + 1e-6, `daily: ${stake * stop + openRisk + Math.max(0, -realized)}`);
    assert.ok(open.length < env.max_concurrent_positions, "concurrency");
    assert.ok(open.filter(p => p.venue === venue).length < vc.max_concurrent, "venue concurrency");
    if (decision.group) assert.ok(open.filter(p => p.group === decision.group).length < env.max_per_group, "group");
    assert.ok(stake >= vc.min_stake_usd, "min stake");
    assert.ok(kellyFraction(decision.p_win, decision.payoff) > 0, "edge");
    assert.equal(venue !== "perps", true, "disabled venue never sizes");
    assert.ok(throttle > 0);
  }
  assert.ok(nonZero > 300, `expected a healthy share of non-zero stakes, got ${nonZero}`);
});

test("T3: throttle only shrinks and zero-edge or halted always sizes zero", () => {
  const env = loadRiskEnvelope(EXAMPLE);
  const sizer = new Sizer(env);
  const decision = { venue: "polymarket", p_win: 0.98, payoff: 0.05, stop_fraction: 1 };
  const portfolio = { open: [], realized_today_usd: 0 };
  const full = sizer.size({ decision, portfolio, throttle: 1 }).stake_usd;
  const half = sizer.size({ decision, portfolio, throttle: 0.5 }).stake_usd;
  const over = sizer.size({ decision, portfolio, throttle: 7 }).stake_usd;
  assert.ok(half <= full && half > 0);
  assert.equal(over, full, "throttle above 1 is clamped, never amplifies");
  assert.equal(sizer.size({ decision: { ...decision, p_win: 0.2 }, portfolio }).reasons[0], "NO_EDGE");
  assert.equal(sizer.size({ decision, portfolio, halted: true }).reasons[0], "HALTED");
  assert.equal(sizer.size({ decision, portfolio: { open: [], realized_today_usd: -100 } }).reasons[0], "DAILY_BUDGET_EXHAUSTED");
  assert.throws(() => new Sizer({ ...env }), /frozen/);
  assert.ok(Object.isFrozen(deepFreeze({ a: { b: 1 } }).a));
});
