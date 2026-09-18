// ═══ The suite runs offline, and this is what proves it ═══
//
//   node --import ./tests/helpers/offline-guard.mjs --test tests/**/*.test.mjs
//   npm run test:offline
//
// Every chain the tests touch is a fake built inside the test file, so the suite should never reach
// the internet. "Should" is worth nothing without a check: a single `fetch` in a code path a test
// happens to exercise makes the whole suite pass or fail on somebody else's uptime, and it fails
// *silently* on the machine where the call is blocked, which is exactly where it looks green.
//
// That is not hypothetical. The PONS router turns an unknown revert selector into a name by asking
// a public signature database. A test asserted the "nobody can name it" case and passed on a build
// box with no egress -- then failed in CI, where 0xdeadbeef resolves to a real function name. Both
// EVM routers now take an injectable `fetchImpl`, and this guard is here so the next one is caught
// by the suite instead of by a red pipeline.
//
// A test that starts its own HTTP server on localhost is not the internet, so loopback passes
// through. Everything else throws, and the exit summary names what tried.

const real = globalThis.fetch;
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/;
const outside = new Set();

globalThis.fetch = async (url, ...rest) => {
  const u = String(url?.url ?? url ?? "");
  if (LOOPBACK.test(u)) return real(url, ...rest);
  outside.add(u);
  throw new Error(`offline guard: the test suite must not call the network (${u})`);
};

process.on("exit", (code) => {
  if (!outside.size) return;
  console.error(`\noffline guard: ${outside.size} call(s) to the outside world:`);
  for (const u of outside) console.error(`  ${u}`);
  console.error("Inject a fetch in the test instead (both EVM routers take fetchImpl).");
  if (code === 0) process.exitCode = 1;
});
