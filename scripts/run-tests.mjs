#!/usr/bin/env node
/**
 * infinity-harness — the test runner.
 *
 * There is no test framework here on purpose: every file under `tests/` is a
 * plain Node program that asserts with `node:assert/strict` and exits non-zero
 * when something is wrong. This runner is the thin thing that finds them, runs
 * each in its own process, and reports.
 *
 * One process per file matters. These tests mutate `process.env`, bind ports,
 * and write temp projects; sharing a process would let one file's leftovers
 * decide whether the next one passes.
 *
 * Usage:
 *   node scripts/run-tests.mjs                 # every tests/*.test.ts
 *   node scripts/run-tests.mjs loop config     # only files matching a filter
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(repoRoot, "tests");

/** Per-file wall-clock cap, so one hung test cannot wedge the whole run. */
const TIMEOUT_MS = 120_000;

function discover(filters) {
  let entries;
  try {
    entries = readdirSync(testsDir);
  } catch (e) {
    console.error(`cannot read ${relative(repoRoot, testsDir)}: ${e.message}`);
    process.exit(1);
  }
  const files = entries.filter((f) => f.endsWith(".test.ts")).sort();
  if (filters.length === 0) return files;
  return files.filter((f) => filters.some((needle) => f.includes(needle)));
}

function runOne(file) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", join(testsDir, file)],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    let timedOut = false;
    const capture = (d) => {
      output += d.toString();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    const finish = (code, spawnError) => {
      clearTimeout(timer);
      resolvePromise({
        file,
        ok: !timedOut && spawnError === null && code === 0,
        code,
        output,
        timedOut,
        spawnError,
        ms: Date.now() - started,
      });
    };

    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code, null));
  });
}

function indent(text) {
  const body = text.replace(/\s+$/, "");
  if (body === "") return "    (no output)";
  return body
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}

const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = discover(filters);

if (files.length === 0) {
  console.error(
    filters.length ? `no test files match: ${filters.join(", ")}` : `no *.test.ts files in ${relative(repoRoot, testsDir)}`,
  );
  process.exit(1);
}

console.log(`running ${files.length} test file${files.length === 1 ? "" : "s"}\n`);

const results = [];
const runStarted = Date.now();

for (const file of files) {
  const r = await runOne(file);
  results.push(r);
  const status = r.ok ? "PASS" : "FAIL";
  console.log(`${status}  ${file.padEnd(28)} ${String(r.ms).padStart(6)}ms`);
  if (!r.ok) {
    const why = r.timedOut
      ? `timed out after ${TIMEOUT_MS}ms`
      : r.spawnError
        ? `could not start: ${r.spawnError}`
        : `exited ${r.code}`;
    console.log(`      ${why}`);
    console.log(indent(r.output));
    console.log("");
  }
}

const failed = results.filter((r) => !r.ok);
const totalMs = Date.now() - runStarted;

console.log("");
console.log("─".repeat(52));
if (failed.length === 0) {
  console.log(`${results.length} passed, 0 failed  (${totalMs}ms)`);
  process.exit(0);
}
console.log(`${results.length - failed.length} passed, ${failed.length} failed  (${totalMs}ms)`);
for (const f of failed) console.log(`  FAIL  ${f.file}`);
process.exit(1);
