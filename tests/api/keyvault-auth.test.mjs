// Keys at rest and proof of ownership: the two things hosted money needs before anything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeVault, loadVaultKey, isSealed } from "../../src/middleware/keyvault.mjs";
import { makeRequireOwner, generateChallenge, verifySolanaSignature, issueAuthToken } from "../../src/middleware/wallet-auth.mjs";

const quiet = { warn() {} };
const key = crypto.randomBytes(32).toString("hex");

test("keyvault: seals and opens, rejects tampering, passes legacy plaintext through, migrates on save", () => {
  const v = makeVault({ key: loadVaultKey({ WALLET_ENCRYPTION_KEY: key }), production: true, log: quiet });
  const sealed = v.seal("5dRVku29secret");
  assert.ok(isSealed(sealed)); assert.notEqual(sealed.ct, "5dRVku29secret");
  assert.equal(v.open(sealed), "5dRVku29secret");
  assert.equal(v.open("legacyplain"), "legacyplain", "a record written before the vault still reads");
  const rec = v.sealRecord({ pubkey: "P", secret: "s1", createdAt: "t" });
  assert.ok(isSealed(rec.secret)); assert.equal(v.openRecord(rec).secret, "s1");
  assert.deepEqual(v.sealRecord([{ secret: "a" }, { secret: "b" }]).map(r => isSealed(r.secret)), [true, true]);
  assert.equal(v.seal(sealed), sealed, "sealing twice does not double-wrap");
  const bad = { ...sealed, ct: Buffer.from("x" + Buffer.from(sealed.ct, "base64").toString("binary").slice(1), "binary").toString("base64") };
  assert.throws(() => v.open(bad), /auth|Unsupported state|bad decrypt/i, "a flipped byte fails authentication");
  const other = makeVault({ key: loadVaultKey({ WALLET_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex") }), production: true, log: quiet });
  assert.throws(() => other.open(sealed), /auth|Unsupported state|bad decrypt/i, "another server's key cannot read it");
  assert.equal(v.canCreate(), true);
});

test("keyvault: without a key it is a pass-through that refuses new custodial keys in production", () => {
  assert.equal(loadVaultKey({}), null);
  assert.throws(() => loadVaultKey({ WALLET_ENCRYPTION_KEY: "tooshort" }), /64 hex/);
  const prod = makeVault({ key: null, production: true, log: quiet });
  assert.equal(prod.enabled, false); assert.equal(prod.canCreate(), false);
  assert.equal(prod.seal("x"), "x"); assert.equal(prod.open("x"), "x");
  assert.throws(() => prod.open({ enc: "gcm1", iv: "", tag: "", ct: "" }), /not set/);
  const dev = makeVault({ key: null, production: false, log: quiet });
  assert.equal(dev.canCreate(), true);
});

test("requireOwner: a signed challenge for the same wallet passes; anything else is refused", () => {
  const kp = crypto.generateKeyPairSync("ed25519");
  const raw = kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const { default: bs58 } = { default: null };
  const b58 = s => { const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let x = BigInt("0x" + Buffer.from(s).toString("hex")); let out = ""; while (x > 0n) { out = A[Number(x % 58n)] + out; x /= 58n; } for (const b of s) { if (b === 0) out = "1" + out; else break; } return out; };
  const wallet = b58(raw);
  const { message } = generateChallenge(wallet);
  const sig = crypto.sign(null, Buffer.from(message), kp.privateKey);
  assert.equal(verifySolanaSignature(wallet, b58(sig), message), true, "the real signer verifies");
  assert.equal(verifySolanaSignature(wallet, b58(sig), message + "x"), false, "a different message does not");
  const token = issueAuthToken(wallet, "free");
  const requireOwner = makeRequireOwner({ adminSecret: "adm" });
  const run = (req) => new Promise(resolve => { const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } }; requireOwner(req, res, () => resolve({ code: 200, user: req.user })); });
  return (async () => {
    assert.deepEqual((await run({ headers: {}, body: { wallet } })).body, { error: "Sign in with your wallet first", auth_required: true });
    assert.equal((await run({ headers: { "x-wallet": wallet }, body: { wallet } })).code, 401, "a header is not ownership");
    assert.equal((await run({ headers: { authorization: "Bearer " + token }, body: { wallet: "SomeoneElse" } })).code, 403);
    assert.equal((await run({ headers: { authorization: "Bearer " + token }, body: { wallet } })).code, 200);
    assert.equal((await run({ headers: { authorization: "Bearer " + token }, query: { wallet } })).code, 200, "query wallets are checked too");
    assert.equal((await run({ headers: { authorization: "Bearer " + token + "x" }, body: { wallet } })).code, 401, "a forged token fails");
    assert.equal((await run({ headers: { "x-admin-secret": "adm" }, body: { wallet } })).user.admin, true);
  })();
});
