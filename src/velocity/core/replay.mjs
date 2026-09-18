// ═══ VELOCITY — Capture and replay (T2 support) ═══
// Any feed can be captured to JSONL; a ReplayFeed re-emits the capture with the
// original observation times so decisions are byte-for-byte reproducible.

import fs from "node:fs";
import path from "node:path";
import { Feed } from "./feed.mjs";
import { validateEvent } from "./events.mjs";

export function captureFeed(feed, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handler = e => fs.appendFileSync(file, JSON.stringify(e) + "\n");
  feed.on("event", handler);
  return () => feed.off("event", handler);
}

export function writeCapture(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join("\n") + "\n");
}

export function readCapture(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    const errors = validateEvent(e);
    if (errors.length) throw new Error(`capture ${file}: ${errors.join("; ")}`);
    out.push(e);
  }
  return out;
}

export class ReplayFeed extends Feed {
  constructor({ venue, events, ...rest }) {
    super({ venue, name: `${venue}-replay`, ...rest });
    this.events = events.filter(e => e.venue === venue);
  }
  async start() {
    this.running = true;
    this.healthy = true;
    for (const e of this.events) {
      if (!this.running) break;
      if (e.kind === "feed_health") continue;
      this.emitEvent({ kind: e.kind, id: e.id, payload: e.payload, t_venue: e.t_venue, t_observed: e.t_observed });
    }
  }
}
