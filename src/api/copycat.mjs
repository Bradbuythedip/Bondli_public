// ═══ Copycat launches: same name and ticker, minutes apart ═══
// When several tokens launch with one name and ticker, the later ones are advertisements for the
// first (or the one that already has the market cap): a wallet spams the launch feed so people
// searching the name land on the real one. Two consequences for the radar:
//   1. a copy is never bought - it is a billboard, not a trade
//   2. the original being copied is a token somebody is spending money to promote, which is a
//      real (if small) reason it pumps; the count is exposed as _copies for the scorer
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Same name AND ticker after normalisation; a short name alone is too generic to key on. */
export function copycatKey(name, ticker) {
  const n = norm(name), t = norm(ticker);
  if (!n || !t || n.length < 2) return null;
  return `${n}|${t}`;
}

export class CopycatIndex {
  /** @param windowMs how long after a launch a same-name launch still counts as its copy */
  constructor({ windowMs = 60 * 60_000 } = {}) { this.windowMs = windowMs; this.byKey = new Map(); }

  /**
   * Record a launch. Returns null for the first of its name; otherwise { copyOf } naming the
   * original (the earliest launch of that name still inside the window).
   */
  note({ ca, name, ticker, createdAt }) {
    const key = copycatKey(name, ticker);
    if (!key || !ca) return null;
    const now = createdAt || Date.now();
    let list = this.byKey.get(key);
    if (list) { list = list.filter(e => now - e.createdAt <= this.windowMs); this.byKey.set(key, list); }
    else { list = []; this.byKey.set(key, list); }
    const original = list.find(e => e.ca !== ca && !e.copyOf);
    const entry = { ca, createdAt: now, copyOf: original ? original.ca : null };
    if (!list.some(e => e.ca === ca)) list.push(entry);
    if (!original) return null;
    original.copies = (original.copies || 0) + 1;
    original.lastCopyAt = now;
    // When each copy landed, so the wave's pace can be read later; bounded, a wave of hundreds is a wave.
    (original.copyAt ||= []).push(now); if (original.copyAt.length > 60) original.copyAt.shift();
    return { copyOf: original.ca, copies: original.copies, key };
  }

  _find(ca) { for (const list of this.byKey.values()) for (const e of list) if (e.ca === ca) return e; return null; }

  /** Copies recorded against an original, and when the latest landed. */
  copiesOf(ca) {
    const e = this._find(ca);
    return e ? { copies: e.copies || 0, lastCopyAt: e.lastCopyAt || 0 } : { copies: 0, lastCopyAt: 0 };
  }

  /**
   * The narrative wave behind an original: how many copies, how fast they are landing now against
   * the window before, and which way that is going. Copies are a billboard for the first launch of
   * a name, and the RATE of copying is the leading indicator: rising means the narrative is still
   * being discovered, fading means the crowd that would buy the leader has already arrived. A copy
   * has no wave of its own, and an original nobody copied has none yet (null, not zeros).
   */
  wave(ca, now = Date.now(), { windowMs = 3 * 60_000 } = {}) {
    const e = this._find(ca);
    if (!e || e.copyOf || !(e.copies > 0)) return null;
    const at = e.copyAt || [];
    const recent = at.filter(t => now - t <= windowMs).length;
    const prior = at.filter(t => now - t > windowMs && now - t <= 2 * windowMs).length;
    return { copies: e.copies, recent, prior, perMin: +(recent / (windowMs / 60_000)).toFixed(2), rising: recent > prior, fading: recent === 0 && prior > 0, lastCopyAt: e.lastCopyAt || 0, windowMs };
  }

  prune(now = Date.now()) {
    for (const [k, list] of this.byKey) { const live = list.filter(e => now - e.createdAt <= this.windowMs); if (live.length) this.byKey.set(k, live); else this.byKey.delete(k); }
  }
}
