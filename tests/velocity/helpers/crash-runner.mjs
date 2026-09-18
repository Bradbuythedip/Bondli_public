// Child process for T9: opens a paper position, prints POSITION_OPEN, keeps ticking
// until killed. The store snapshot interval is long so the kill lands before the
// first snapshot: the ledger and the paper book are the only truth left.
import path from "node:path";
import { Engine } from "../../../src/velocity/core/engine.mjs";
import { loadRiskEnvelope } from "../../../src/velocity/core/risk.mjs";
import { ScriptedFeed } from "../../../src/velocity/core/feed.mjs";
import { makePumpfunEdge } from "../../../src/velocity/venues/pumpfun/edge.mjs";
import { PumpfunPaperRouter } from "../../../src/velocity/venues/pumpfun/router.mjs";
import { goodCandidatePayload, tickPayload } from "./fixtures.mjs";

const dataDir = process.argv[2];
const envelope = loadRiskEnvelope(path.resolve("src/velocity/config/risk.example.json"));
const feed = new ScriptedFeed({ venue: "pumpfun", loop: true, script: [
  { delayMs: 20, kind: "candidate", id: "MintCrash", payload: goodCandidatePayload("MintCrash"), lagMs: 100 },
  { delayMs: 150, kind: "tick", id: "MintCrash", payload: tickPayload("MintCrash", 18_500), lagMs: 50 },
] });
const engine = new Engine({ dataDir, envelope, venues: { pumpfun: { mode: "paper", feed, edge: makePumpfunEdge(), router: new PumpfunPaperRouter({ bookFile: path.join(dataDir, "paper-book-pumpfun.json"), latencyMs: 0 }) } }, config: { saveMs: 600_000, governorMs: 600_000 } });
engine.on("position", p => { process.stdout.write(`POSITION_OPEN ${p.id}\n`); });
await engine.start({ reconcile: false });
setInterval(() => {}, 1000);
