import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assetUrl, buildManifest } from "./manifest.mjs";

const scriptPath = fileURLToPath(new URL("./manifest.mjs", import.meta.url));
const fixtureSig = fileURLToPath(
  new URL("./fixtures/sample.bin.sig", import.meta.url),
);
const sigText = fs.readFileSync(fixtureSig, "utf8");

const VERSION = "0.9.8-jw.4";
const FILE = "Handy_0.9.8-jw.4_x64-setup.exe";
const URL_EXACT = `https://github.com/jeremywho/Handy/releases/download/v${VERSION}/${FILE}`;
const PUB_DATE = "2026-10-21T12:00:00Z";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("assetUrl is the immutable tagged download URL", () =>
  assert.equal(assetUrl(VERSION, FILE), URL_EXACT));

test("buildManifest emits both Windows platform keys with the exact URL and version", () => {
  const manifest = buildManifest({
    version: VERSION,
    url: URL_EXACT,
    signature: sigText,
    pubDate: PUB_DATE,
  });
  assert.deepEqual(manifest, {
    version: VERSION,
    notes: "",
    pub_date: PUB_DATE,
    platforms: {
      "windows-x86_64": { signature: sigText.trim(), url: URL_EXACT },
      "windows-x86_64-nsis": { signature: sigText.trim(), url: URL_EXACT },
    },
  });
});

test("the signature is the whole .sig file as single-line base64", () => {
  const manifest = buildManifest({
    version: VERSION,
    url: URL_EXACT,
    signature: `${sigText}\r\n`,
    pubDate: PUB_DATE,
  });
  const signature = manifest.platforms["windows-x86_64"].signature;
  assert.match(signature, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(signature, sigText.trim());
  assert.match(
    Buffer.from(signature, "base64").toString("utf8"),
    /^untrusted comment: .*\ntrusted comment: /s,
  );
});

test("buildManifest rejects a URL that is not the version's tagged asset", () => {
  for (const url of [
    `https://github.com/jeremywho/Handy/releases/download/v0.9.8-jw.3/${FILE}`,
    `https://github.com/jeremywho/Handy/releases/latest/download/${FILE}`,
    `https://github.com/cjpais/Handy/releases/download/v${VERSION}/${FILE}`,
    `${URL_EXACT}?x=1`,
    `https://github.com/jeremywho/Handy/releases/download/v${VERSION}/sub/${FILE}`,
  ]) {
    assert.throws(
      () =>
        buildManifest({
          version: VERSION,
          url,
          signature: sigText,
          pubDate: PUB_DATE,
        }),
      /url/,
      url,
    );
  }
});

test("buildManifest rejects a malformed version, empty signature or bad date", () => {
  assert.throws(
    () =>
      buildManifest({
        version: "0.9.8",
        url: URL_EXACT,
        signature: sigText,
        pubDate: PUB_DATE,
      }),
    /version/,
  );
  assert.throws(
    () =>
      buildManifest({
        version: VERSION,
        url: URL_EXACT,
        signature: " \n",
        pubDate: PUB_DATE,
      }),
    /signature/,
  );
  assert.throws(
    () =>
      buildManifest({
        version: VERSION,
        url: URL_EXACT,
        signature: "not base64!",
        pubDate: PUB_DATE,
      }),
    /signature/,
  );
  assert.throws(
    () =>
      buildManifest({
        version: VERSION,
        url: URL_EXACT,
        signature: sigText,
        pubDate: "yesterday",
      }),
    /pub_date|pubDate/,
  );
});

test("the CLI prints latest.json built from the installer name and .sig", () => {
  const installer = path.join(tmp, FILE);
  fs.writeFileSync(installer, "x");
  const result = spawnSync(
    process.execPath,
    [scriptPath, VERSION, installer, fixtureSig, PUB_DATE],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.pub_date, PUB_DATE);
  assert.equal(manifest.platforms["windows-x86_64-nsis"].url, URL_EXACT);
  assert.equal(manifest.platforms["windows-x86_64"].signature, sigText.trim());
});

test("the CLI defaults pub_date to now and fails on bad arguments", () => {
  const installer = path.join(tmp, FILE);
  fs.writeFileSync(installer, "x");
  const ok = spawnSync(
    process.execPath,
    [scriptPath, VERSION, installer, fixtureSig],
    {
      encoding: "utf8",
    },
  );
  assert.equal(ok.status, 0, ok.stderr);
  const age = Date.now() - Date.parse(JSON.parse(ok.stdout).pub_date);
  assert.ok(age >= 0 && age < 60_000, String(age));

  const bad = spawnSync(process.execPath, [scriptPath, VERSION], {
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage/);
});
