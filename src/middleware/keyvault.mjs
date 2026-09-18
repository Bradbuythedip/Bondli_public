// BONDLI — keys at rest
// AES-256-GCM with a server-side key (WALLET_ENCRYPTION_KEY, 64 hex chars). A sealed secret is
// { enc: "gcm1", iv, tag, ct } in base64; anything else is treated as a legacy plaintext secret
// and migrates the next time it is saved. Without the key the vault is a pass-through so that a
// development box still works, but production refuses to mint new custodial keys unsealed.
import crypto from "node:crypto";

const HEX64 = /^[0-9a-f]{64}$/i;

export function loadVaultKey(env = process.env) {
  const raw = (env.WALLET_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  if (!HEX64.test(raw)) throw new Error("WALLET_ENCRYPTION_KEY must be 64 hex characters (32 bytes): node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  return Buffer.from(raw, "hex");
}

export function isSealed(v) { return !!v && typeof v === "object" && v.enc === "gcm1" && typeof v.ct === "string"; }

export function makeVault({ key = loadVaultKey(), production = process.env.NODE_ENV === "production", log = console } = {}) {
  if (!key) log.warn?.(`[KEYVAULT] WALLET_ENCRYPTION_KEY is not set: trading-wallet secrets are stored in PLAINTEXT${production ? "; creating new custodial wallets is refused" : ""}`);
  return {
    enabled: !!key,
    /** True when a new custodial key may be created. */
    canCreate() { return !!key || !production; },
    seal(plain) {
      if (!key) return plain;
      if (isSealed(plain)) return plain;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
      return { enc: "gcm1", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
    },
    open(v) {
      if (!isSealed(v)) return v; // legacy plaintext
      if (!key) throw new Error("sealed secret but WALLET_ENCRYPTION_KEY is not set");
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(v.iv, "base64"));
      d.setAuthTag(Buffer.from(v.tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(v.ct, "base64")), d.final()]).toString("utf8");
    },
    /** Seal every `secret` field in a trading-wallet record (or list of them). */
    sealRecord(tw) {
      if (Array.isArray(tw)) return tw.map(x => this.sealRecord(x));
      if (!tw || typeof tw !== "object") return tw;
      const out = tw.secret == null ? tw : { ...tw, secret: this.seal(tw.secret) };
      return out.evmSecret == null ? out : { ...out, evmSecret: this.seal(out.evmSecret) };
    },
    openRecord(tw) {
      if (Array.isArray(tw)) return tw.map(x => this.openRecord(x));
      if (!tw || typeof tw !== "object") return tw;
      const out = tw.secret == null ? tw : { ...tw, secret: this.open(tw.secret) };
      return out.evmSecret == null ? out : { ...out, evmSecret: this.open(out.evmSecret) };
    },
  };
}
