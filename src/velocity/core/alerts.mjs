// ═══ VELOCITY — Alerts (E9) ═══
// Every alert lands in the store and the ledger first; delivery is a bonus.
// Each alert ends with a halt link and a status link. Three retries, then the
// failure itself is written to the status banner.

// A glance-readable prefix: the operator is reading this on a phone, at speed.
const SIGIL = Object.freeze({ error: "\u{1F534} ", warn: "\u{1F7E1} ", info: "" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Alerter {
  constructor({ store, ledger, webhookUrl = null, statusUrl = "", fetchImpl = globalThis.fetch, retries = 3, sleepImpl = null } = {}) {
    this.store = store; this.ledger = ledger; this.webhookUrl = webhookUrl; this.statusUrl = statusUrl; this.fetch = fetchImpl; this.retries = retries;
    if (sleepImpl) this.sleep = sleepImpl;
  }
  async send(level, text) {
    const a = this.store?.alert(level, text);
    const links = this.statusUrl
      ? `\nstatus: ${this.statusUrl}/status\nhalt:   ${this.statusUrl}/halt (POST {"mode":"freeze"})`
      : "";
    const body = `${SIGIL[level] || ""}${level.toUpperCase()}: ${text}${links}`;
    let delivered = false, error = null;
    if (this.webhookUrl) {
      // One pasted URL should work whatever it points at. Slack reads `text`, Discord reads
      // `content`, ntfy and most self-hosted receivers take the raw body -- and each ignores the
      // keys it does not know, so sending all three costs nothing and saves the operator finding out
      // by watching alerts silently fail. Slack rejects a body over 40k; nothing here approaches it.
      const payload = JSON.stringify({ text: body, content: body, message: body, title: `bondli ${level}`, level, priority: level === "error" ? 4 : 3 });
      for (let i = 0; i < this.retries && !delivered; i++) {
        try {
          const res = await this.fetch(this.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(5_000) });
          delivered = res.ok;
          if (!res.ok) error = `webhook ${res.status}`;
        } catch (err) { error = err.message; }
        // A receiver that is briefly down should not lose the alert on the first try.
        if (!delivered && i < this.retries - 1) await (this.sleep || sleep)(500 * (i + 1));
      }
      if (!delivered) this.store?.alert("error", `alert delivery failed: ${error}`);
    }
    this.ledger?.append({ kind: "alert", level, text, delivered, error });
    return { ...a, delivered, error };
  }
}
