#!/usr/bin/env node
// ═══ The test suite needs the frontend's dependencies, so `npm test` installs them ═══
//
// One API test reads the shipped palette and the shipped dictionary as modules rather than as text,
// because a colour contrast and a translation are worth checking as values. Both of those modules
// are React modules, and React lives in app/package.json, not in the root one. So `npm ci && npm
// test` -- the first two commands anyone runs on a repository that ships a lockfile -- used to fail
// at import time on a fresh clone, and the suite silently dropped a whole file.
//
// This runs as `pretest`. If the frontend's dependencies are already there it does nothing at all,
// so the offline guarantee holds: a suite that has been installed once never reaches the network
// again. If they are missing it installs them, and if that install fails it says exactly what to run
// rather than leaving a stack trace from inside a test file.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "app");

if (existsSync(path.join(APP, "node_modules", "react"))) process.exit(0);
if (!existsSync(path.join(APP, "package.json"))) process.exit(0); // nothing to install

console.log("[pretest] the frontend's dependencies are not installed; installing them once");
const cmd = existsSync(path.join(APP, "package-lock.json")) ? "ci" : "install";
const r = spawnSync("npm", [cmd, "--prefix", APP, "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit", shell: process.platform === "win32" });

if (r.status !== 0 || !existsSync(path.join(APP, "node_modules", "react"))) {
  console.error(
    "\n[pretest] could not install the frontend's dependencies.\n" +
    "  Run this yourself and then `npm test` again:\n\n" +
    "    npm install --prefix app\n"
  );
  process.exit(1);
}
