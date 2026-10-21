import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nextVersion, readStamped, stamp } from "./version.mjs";

const scriptPath = fileURLToPath(new URL("./version.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");

const TARGETS = {
  conf: "src-tauri/tauri.conf.json",
  cargo: "src-tauri/Cargo.toml",
  pkg: "package.json",
  lock: "src-tauri/Cargo.lock",
};

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "version-"));
after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

let tmpCount = 0;
function copyTargets({ eol, overrides = {} } = {}) {
  const root = path.join(tmpBase, String(tmpCount++));
  for (const rel of Object.values(TARGETS)) {
    let text =
      overrides[rel] ?? fs.readFileSync(path.join(repoRoot, rel), "utf8");
    if (eol === "\n") text = text.replace(/\r\n/g, "\n");
    if (eol === "\r\n") text = text.replace(/\r?\n/g, "\r\n");
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const lines = (text) => text.split("\n");

function changedLines(before, after) {
  const a = lines(before);
  const b = lines(after);
  assert.equal(b.length, a.length, "line count changed");
  return a.flatMap((line, i) =>
    line === b[i] ? [] : [{ index: i, before: line, after: b[i] }],
  );
}

const snapshot = (root) =>
  Object.fromEntries(
    Object.values(TARGETS).map((rel) => [rel, read(root, rel)]),
  );

test("first release on a base is jw.1", () =>
  assert.equal(nextVersion("0.9.9", ["v0.9.8-jw.2"]), "0.9.9-jw.1"));

test("increments past the highest N, ignoring other bases", () =>
  assert.equal(
    nextVersion("0.9.8", ["v0.9.8-jw.1", "v0.9.8-jw.3", "v0.9.7-jw.9"]),
    "0.9.8-jw.4",
  ));

test("ignores non-fork tags", () =>
  assert.equal(nextVersion("0.9.8", ["v0.9.8"]), "0.9.8-jw.1"));

test("compares N numerically and ignores look-alike tags", () => {
  assert.equal(
    nextVersion("0.9.8", ["v0.9.8-jw.9", "v0.9.8-jw.10", "v0.9.8-jw.2"]),
    "0.9.8-jw.11",
  );
  assert.equal(
    nextVersion("0.9.8", [
      "v10.9.8-jw.7",
      "v0.9.80-jw.7",
      "v0x9x8-jw.7",
      "v0.9.8-jw.7x",
      "v0.9.8-jw.",
      "v0.9.8-rc.7",
    ]),
    "0.9.8-jw.1",
  );
});

test("nextVersion rejects a malformed base version", () => {
  for (const base of ["", "0.9", "v0.9.8", "0.9.8-jw.1", "0.9.8 ", "a.b.c"]) {
    assert.throws(() => nextVersion(base, []), /base version/, base);
  }
});

test("stamp writes all three files and readStamped agrees", () => {
  const root = copyTargets();
  const before = snapshot(root);
  stamp(root, "1.2.3-jw.4");

  assert.deepEqual(readStamped(root), {
    conf: "1.2.3-jw.4",
    cargo: "1.2.3-jw.4",
    pkg: "1.2.3-jw.4",
    lock: "1.2.3-jw.4",
  });
  assert.equal(JSON.parse(read(root, TARGETS.conf)).version, "1.2.3-jw.4");
  assert.equal(JSON.parse(read(root, TARGETS.pkg)).version, "1.2.3-jw.4");
  for (const rel of Object.values(TARGETS)) {
    const diff = changedLines(before[rel], read(root, rel));
    assert.equal(diff.length, 1, `${rel} should change exactly one line`);
    assert.match(diff[0].after, /1\.2\.3-jw\.4/);
  }
});

test("stamp leaves Cargo.toml dependency versions untouched", () => {
  const root = copyTargets();
  const before = read(root, TARGETS.cargo);
  stamp(root, "1.2.3-jw.4");
  const diff = changedLines(before, read(root, TARGETS.cargo));

  assert.equal(diff.length, 1);
  assert.match(diff[0].before, /^version = "[^"]+"\r?$/);
  const packageHeader = lines(before).findIndex((line) =>
    /^\[package\]\r?$/.test(line),
  );
  const nextHeader = lines(before).findIndex(
    (line, i) => i > packageHeader && /^\[/.test(line),
  );
  assert.ok(diff[0].index > packageHeader && diff[0].index < nextHeader);
  assert.ok(
    lines(before).filter((line) => /version\s*=/.test(line)).length > 1,
    "fixture should carry dependency version lines",
  );
});

test("stamp leaves version lines in [dependencies.*] tables untouched", () => {
  const cargo =
    fs.readFileSync(path.join(repoRoot, TARGETS.cargo), "utf8") +
    '\n[dependencies.extra]\nversion = "1.0.0"\nfeatures = ["x"]\n';
  const root = copyTargets({ overrides: { [TARGETS.cargo]: cargo } });
  stamp(root, "1.2.3-jw.4");
  const diff = changedLines(cargo, read(root, TARGETS.cargo));

  assert.equal(diff.length, 1);
  assert.match(diff[0].after, /^version = "1\.2\.3-jw\.4"\r?$/);
  assert.match(
    read(root, TARGETS.cargo),
    /\[dependencies\.extra\]\nversion = "1\.0\.0"\n/,
  );
});

test("stamp changes only the handy package in the real Cargo.lock", () => {
  const root = copyTargets();
  const before = read(root, TARGETS.lock);
  stamp(root, "1.2.3-jw.4");
  const diff = changedLines(before, read(root, TARGETS.lock));

  assert.equal(diff.length, 1);
  assert.match(lines(before)[diff[0].index - 1], /^name = "handy"\r?$/);
  assert.match(diff[0].after, /^version = "1\.2\.3-jw\.4"\r?$/);
});

test("stamp skips lock packages whose name only starts with handy", () => {
  const lock = [
    "version = 4",
    "",
    "[[package]]",
    'name = "handy-keys"',
    'version = "0.1.0"',
    "",
    "[[package]]",
    'name = "handy_app_lib"',
    'version = "0.2.0"',
    "",
    "[[package]]",
    'name = "handy"',
    'version = "0.9.8"',
    "dependencies = [",
    ' "handy-keys",',
    "]",
    "",
    "[[package]]",
    'name = "handyman"',
    'version = "0.3.0"',
    "",
  ].join("\n");
  const root = copyTargets({ overrides: { [TARGETS.lock]: lock } });
  stamp(root, "1.2.3-jw.4");
  const diff = changedLines(lock, read(root, TARGETS.lock));

  assert.deepEqual(diff, [
    {
      index: 12,
      before: 'version = "0.9.8"',
      after: 'version = "1.2.3-jw.4"',
    },
  ]);
});

test("stamp preserves CRLF and LF line endings", () => {
  for (const eol of ["\r\n", "\n"]) {
    const root = copyTargets({ eol });
    const before = snapshot(root);
    stamp(root, "1.2.3-jw.4");
    for (const rel of Object.values(TARGETS)) {
      const text = read(root, rel);
      const crlf = (text.match(/\r\n/g) ?? []).length;
      const lf = (text.match(/\n/g) ?? []).length;
      assert.equal(lf, (before[rel].match(/\n/g) ?? []).length, rel);
      assert.equal(
        crlf,
        eol === "\r\n" ? lf : 0,
        `${rel} with ${JSON.stringify(eol)}`,
      );
      assert.equal(changedLines(before[rel], text).length, 1, rel);
    }
  }
});

test("stamp rejects a malformed version and writes nothing", () => {
  const root = copyTargets();
  const before = snapshot(root);
  for (const version of [
    "",
    "0.9.8",
    "v0.9.8-jw.1",
    "0.9.8-jw",
    "0.9.8-jw.1 ",
    "0.9.8-rc.1",
    '0.9.8-jw.1"',
  ]) {
    assert.throws(() => stamp(root, version), /version/, version);
  }
  assert.deepEqual(snapshot(root), before);
});

test("stamp writes nothing when any target lacks its version", () => {
  const lock = '[[package]]\nname = "handy-keys"\nversion = "0.1.0"\n';
  const root = copyTargets({ overrides: { [TARGETS.lock]: lock } });
  const before = snapshot(root);
  assert.throws(() => stamp(root, "1.2.3-jw.4"), /Cargo\.lock/);
  assert.deepEqual(snapshot(root), before);
});

function cliRoot() {
  const root = copyTargets();
  const dest = path.join(root, "fork/scripts/version.mjs");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(scriptPath, dest);
  return { root, script: dest };
}

const runCli = (script, args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("CLI stamp prints the line-ending-independent SHA-256 of version.mjs", () => {
  const { root, script } = cliRoot();
  const result = runCli(script, ["stamp", "1.2.3-jw.4"]);

  assert.equal(result.status, 0, result.stderr);
  const expected = crypto
    .createHash("sha256")
    .update(fs.readFileSync(scriptPath, "utf8").replace(/\r\n/g, "\n"))
    .digest("hex");
  assert.equal(result.stdout.trim(), expected);
  assert.equal(readStamped(root).conf, "1.2.3-jw.4");
  assert.equal(readStamped(root).lock, "1.2.3-jw.4");
});

test("CLI exits non-zero on a malformed version or command", () => {
  const { root, script } = cliRoot();
  const before = snapshot(root);
  for (const args of [
    ["stamp", "0.9.8"],
    ["stamp"],
    ["stamp", "1.2.3-jw.4", "extra"],
    ["bump", "1.2.3-jw.4"],
    [],
  ]) {
    const result = runCli(script, args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  }
  assert.deepEqual(snapshot(root), before);
});
