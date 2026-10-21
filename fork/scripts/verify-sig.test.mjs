import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifySig } from "./verify-sig.mjs";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const scriptPath = here("./verify-sig.mjs");
const samplePath = here("./fixtures/sample.bin");
const sigPath = here("./fixtures/sample.bin.sig");
const pubPath = here("./fixtures/test.pub");
const forkPubPath = here("../updater.pub");

const sample = fs.readFileSync(samplePath);
const sigText = fs.readFileSync(sigPath, "utf8");
const testPub = fs.readFileSync(pubPath, "utf8");
const forkPub = fs.readFileSync(forkPubPath, "utf8");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-sig-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (text) => Buffer.from(text.trim(), "base64").toString("utf8");
const sigAlgorithm = (text) =>
  Buffer.from(unb64(text).split(/\r?\n/)[1], "base64")
    .subarray(0, 2)
    .toString("latin1");

function minisignPair({ eol = "\n" } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = crypto.randomBytes(8);
  const pubText = [
    "untrusted comment: minisign public key: TEST",
    b64(Buffer.concat([Buffer.from("Ed"), keyId, raw])),
    "",
  ].join(eol);
  const sign = (
    data,
    { algorithm = "ED", trusted = "timestamp:1\tfile:x", signId = keyId } = {},
  ) => {
    const message =
      algorithm === "ED"
        ? crypto.createHash("blake2b512").update(data).digest()
        : data;
    const signature = crypto.sign(null, message, privateKey);
    const global = crypto.sign(
      null,
      Buffer.concat([signature, Buffer.from(trusted, "utf8")]),
      privateKey,
    );
    return b64(
      [
        "untrusted comment: signature from tauri secret key",
        b64(
          Buffer.concat([Buffer.from(algorithm, "latin1"), signId, signature]),
        ),
        `trusted comment: ${trusted}`,
        b64(global),
        "",
      ].join(eol),
    );
  };
  return { pub: b64(pubText), sign, keyId };
}

test("the Tauri-signed fixture verifies against its key", () => {
  assert.equal(verifySig(sample, sigText, testPub), true);
});

test("the fixture's algorithm is recorded", () => {
  assert.match(sigAlgorithm(sigText), /^(Ed|ED)$/);
});

test("a flipped byte in the file fails", () => {
  for (const index of [0, Math.floor(sample.length / 2), sample.length - 1]) {
    const tampered = Buffer.from(sample);
    tampered[index] ^= 0x01;
    assert.equal(verifySig(tampered, sigText, testPub), false, String(index));
  }
});

test("a key from another file fails", () => {
  assert.equal(verifySig(sample, sigText, forkPub), false);
});

test("an in-test key verifies both the prehashed ED and legacy Ed algorithms", () => {
  const data = Buffer.from("hello\r\nworld\n\0");
  const pair = minisignPair();
  assert.equal(
    verifySig(data, pair.sign(data, { algorithm: "ED" }), pair.pub),
    true,
  );
  assert.equal(
    verifySig(data, pair.sign(data, { algorithm: "Ed" }), pair.pub),
    true,
  );
});

test("an algorithm label that does not match how the file was signed fails", () => {
  const data = Buffer.from("payload");
  const pair = minisignPair();
  const legacy = unb64(pair.sign(data, { algorithm: "Ed" })).split("\n");
  const raw = Buffer.from(legacy[1], "base64");
  raw.write("ED", 0, "latin1");
  legacy[1] = b64(raw);
  assert.equal(verifySig(data, b64(legacy.join("\n")), pair.pub), false);
});

test("an unknown algorithm fails", () => {
  const data = Buffer.from("payload");
  const pair = minisignPair();
  assert.equal(
    verifySig(data, pair.sign(data, { algorithm: "Xx" }), pair.pub),
    false,
  );
});

test("CRLF line endings in the decoded files are tolerated", () => {
  const data = Buffer.from("payload");
  const pair = minisignPair({ eol: "\r\n" });
  assert.equal(verifySig(data, pair.sign(data), pair.pub), true);
});

test("a key ID mismatch fails even with a valid signature", () => {
  const data = Buffer.from("payload");
  const pair = minisignPair();
  assert.equal(
    verifySig(data, pair.sign(data, { signId: Buffer.alloc(8, 7) }), pair.pub),
    false,
  );
});

test("a tampered trusted comment fails the global signature", () => {
  const data = Buffer.from("payload");
  const pair = minisignPair();
  const lines = unb64(pair.sign(data)).split("\n");
  lines[2] = "trusted comment: timestamp:2\tfile:x";
  assert.equal(verifySig(data, b64(lines.join("\n")), pair.pub), false);
});

test("a tampered fixture trusted comment fails", () => {
  const lines = unb64(sigText).split("\n");
  lines[2] = `${lines[2]}x`;
  assert.equal(verifySig(sample, b64(lines.join("\n")), testPub), false);
});

test("malformed inputs return false instead of throwing", () => {
  for (const [sig, pub] of [
    ["", testPub],
    [sigText, ""],
    ["not*base64", testPub],
    [`${sigText.trim()}!!`, testPub],
    [b64("untrusted comment: x\nAAAA\n"), testPub],
    [sigText, b64("untrusted comment: x\nRWQ=\n")],
  ]) {
    assert.equal(verifySig(sample, sig, pub), false);
  }
});

function runCli(file, sig, pub) {
  return spawnSync(process.execPath, [scriptPath, file, sig, pub], {
    encoding: "utf8",
  });
}

test("the CLI exits 0 on a valid signature and 1 otherwise", () => {
  const ok = runCli(samplePath, sigPath, pubPath);
  assert.equal(ok.status, 0, ok.stderr);

  const wrongKey = runCli(samplePath, sigPath, forkPubPath);
  assert.equal(wrongKey.status, 1);
  assert.match(wrongKey.stderr, /key ID|does not verify|invalid/);

  const tampered = path.join(tmp, "tampered.bin");
  const bytes = Buffer.from(sample);
  bytes[0] ^= 0xff;
  fs.writeFileSync(tampered, bytes);
  assert.equal(runCli(tampered, sigPath, pubPath).status, 1);

  assert.equal(
    runCli(path.join(tmp, "missing.bin"), sigPath, pubPath).status,
    1,
  );
  const usage = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage/);
});
