// ═══ VELOCITY — Perps venue (disabled stub) ═══
// Adapter slots exist so enabling perps later costs a feed, an edge model and a
// router, and nothing in the core. Until then every entry point refuses.

import { Feed } from "../../core/feed.mjs";

const DISABLED = "perps venue is disabled: adapter stub only (see prompts/VELOCITY_TRADER_ONESHOT.md Part G)";

export class PerpsFeed extends Feed {
  constructor(opts = {}) { super({ venue: "perps", name: "perps-stub", ...opts }); }
  async start() { throw new Error(DISABLED); }
}

export class PerpsRouter {
  constructor() { this.venue = "perps"; this.mode = "off"; }
  async submit() { throw new Error(DISABLED); }
  async submitLegs() { throw new Error(DISABLED); }
  async close() { throw new Error(DISABLED); }
  async health() { return { ok: false, latencyMs: null, detail: DISABLED }; }
  async positions() { return []; }
}

export const perpsEdge = { venue: "perps", gates: [], estimate: () => { throw new Error(DISABLED); } };
