# The public mirror: what it leaves out, and why

[`Bondli_public`](https://github.com/Bradbuythedip/Bondli_public) is a mirror of Bondli's working
repository, produced by `tools/sync-public.mjs`. The rule it follows is the one that makes the mirror
worth reading: **everything is published unless it is on a named exclusion list**, and the list is
short enough to print here in full.

That direction matters. A mirror built by copying selected files drifts the moment someone adds a
file and forgets to copy it; this one drifts only if someone adds a file and deliberately excludes
it. The consequence is that `npm test` in the public repository runs the same suite, against the same
engine, that the hosted service runs.

## What is left out

**Operator tooling for launching a token** — `launch/`, `GAME_THEORY.md`, `tests/robinhood/`,
`tests/launch/`.

A fleet launcher for our own token launches, run by hand from a terminal. It is not part of the
product: nothing under `src/`, `app/` or `deploy/` imports it, and the dependency runs one way only
(the launcher imports the PONS curve helpers, never the reverse). The hosted bot excludes fleet
wallets and manufactured volume by constraint — see the note at the top of
[`src/velocity/README.md`](../src/velocity/README.md) — and the mirror holds that same line.

**The pump.fun fleet engine** — `src/engine/fleet-trader.mjs`, `fleet-brains.mjs`,
`volume-engine.mjs`, `launch-orchestrator.mjs`, `anti-detection.mjs`, `orchestrator.mjs`,
`exit.mjs`, `recover.mjs`, `wallet-optimizer.mjs`, `wallet-saver.mjs`, and the legacy development
server `src/api/server.mjs` that drove them.

Same reason. `fleet-trader.mjs` is replaced in the mirror by a stub whose every method refuses, so
the production server still imports and boots cleanly and the legacy routes behind it answer that the
feature is unavailable. Those routes are behind an admin credential in both repositories, and the
shipped frontend calls none of them.

**The adversarial audit journal** — `docs/audit/`.

Thirty-two agents over sixteen dimensions, 109 confirmed findings and 17 refuted ones, against a
service with live user funds in it. The findings that were fixed are summarised in the appendix of
[`GRANT-ARC.md`](GRANT-ARC.md); the ones that are still open are in the open list at the bottom of
[`AXIOMS.md`](AXIOMS.md). Publishing the unresolved half as a document, with reproduction steps
against a running deployment, is not something we are willing to do while the money is real.

That is the whole list. The README, every document under `docs/` except the audit journal, the
engine, the venues, the tests, the frontend and the deployment files are all published.

## What is changed on the way out

Four transformations, each asserted by the sync script so that a change on the private side fails the
sync rather than drifting silently:

| File | Change |
|---|---|
| `src/engine/config.mjs` | the fleet's volume, auto-rug and wallet-role settings are dropped; nothing published reads them, and the script verifies that |
| `package.json` | scripts that point at excluded files are removed, the test glob loses the excluded suites, and `repository` names the public repo |
| `deploy/Dockerfile` | boots the production server, since the legacy development server is not published |
| `docs/AXIOMS.md` | one operational note about rotating our own credentials is dropped |

## What the mirror owns

The sync owns the entire public checkout, not a set of directories inside it: any file the run did
not write is removed. A file deleted here therefore disappears there on the next sync, which is what
stops the two trees from diverging quietly — a stale script or a document about a product that no
longer exists cannot outlive its deletion. `.git`, `node_modules` and `dist` are never touched.

## What is checked before anything is written

The sync refuses to run if any published file imports an excluded one. That check walks every
relative import in every published `.mjs`, `.js` and `.jsx` file and resolves it against the
exclusion list, so the mirror cannot be published in a state that fails to load.

Every transformed and stubbed module is then parsed with `node --check` before the sync reports
success.

## Keeping it honest

Nothing in this arrangement is a substitute for not committing secrets. The script publishes what
git tracks; `.env` and every runtime data directory are ignored in both repositories, and the
environment file that *is* published, `.env.example`, carries names and explanations with no values.

To reproduce the mirror from the working repository:

```bash
node tools/sync-public.mjs --to ../Bondli_public --dry   # prints the plan and the exclusion list
node tools/sync-public.mjs --to ../Bondli_public
```
