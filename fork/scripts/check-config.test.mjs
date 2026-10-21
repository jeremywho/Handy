import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, mergePatch, scanSources } from "./check-config.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const readJson = (rel) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));

const identity = {
  endpoint:
    "https://github.com/jeremywho/Handy/releases/latest/download/latest.json",
  identifier: "com.pais.handy",
  productName: "Handy",
  publisher: "pais",
};
const pubkey = "Rk9SS19QVUJLRVk=\n";
const upstreamEndpoint =
  "https://github.com/cjpais/Handy/releases/latest/download/latest.json";

const okFixture = {
  baseConf: {
    productName: "Handy",
    version: "0.9.8",
    identifier: "com.pais.handy",
    bundle: { windows: { nsis: { template: "nsis/installer.nsi" } } },
    plugins: {
      updater: { pubkey: "Rk9SS19QVUJLRVk=", endpoints: [identity.endpoint] },
    },
  },
  windowsConf: { bundle: { resources: { resources: "resources" } } },
  identity,
  pubkey,
};

const withBase = (patch) => ({
  ...okFixture,
  baseConf: mergePatch(okFixture.baseConf, patch),
});

test("passes the fork config", () =>
  assert.deepEqual(checkConfig(okFixture), []));

test("flags upstream endpoint in the windows overlay", () =>
  assert.match(
    checkConfig({
      ...okFixture,
      windowsConf: { plugins: { updater: { endpoints: [upstreamEndpoint] } } },
    }).join(),
    /endpoint/,
  ));

test("flags upstream endpoint in the base config", () =>
  assert.match(
    checkConfig(
      withBase({ plugins: { updater: { endpoints: [upstreamEndpoint] } } }),
    ).join(),
    /endpoint/,
  ));

test("flags a second endpoint", () =>
  assert.match(
    checkConfig(
      withBase({
        plugins: {
          updater: { endpoints: [identity.endpoint, upstreamEndpoint] },
        },
      }),
    ).join(),
    /exactly one endpoint/,
  ));

test("flags missing endpoints", () =>
  assert.match(
    checkConfig(withBase({ plugins: { updater: { endpoints: null } } })).join(),
    /exactly one endpoint/,
  ));

test("flags a pubkey that is not fork/updater.pub", () =>
  assert.match(
    checkConfig(
      withBase({ plugins: { updater: { pubkey: "VVBTVFJFQU0=" } } }),
    ).join(),
    /pubkey/,
  ));

test("flags a pubkey overridden by the windows overlay", () =>
  assert.match(
    checkConfig({
      ...okFixture,
      windowsConf: { plugins: { updater: { pubkey: "VVBTVFJFQU0=" } } },
    }).join(),
    /pubkey/,
  ));

test("flags an empty fork pubkey", () =>
  assert.match(
    checkConfig({
      ...withBase({ plugins: { updater: { pubkey: "" } } }),
      pubkey: "  \n",
    }).join(),
    /pubkey/,
  ));

test("flags signCommand present", () =>
  assert.match(
    checkConfig(
      withBase({
        bundle: { windows: { signCommand: "trusted-signing-cli %1" } },
      }),
    ).join(),
    /signCommand/,
  ));

test("flags signCommand added by the windows overlay", () =>
  assert.match(
    checkConfig({
      ...okFixture,
      windowsConf: {
        bundle: { windows: { signCommand: "trusted-signing-cli %1" } },
      },
    }).join(),
    /signCommand/,
  ));

test("flags identifier or productName change", () => {
  assert.match(
    checkConfig(withBase({ identifier: "com.jeremywho.handy" })).join(),
    /identifier/,
  );
  assert.match(
    checkConfig(withBase({ productName: "Handy Fork" })).join(),
    /productName/,
  );
});

test("flags a publisher that differs from the fork identity", () =>
  assert.match(
    checkConfig(withBase({ bundle: { publisher: "jeremywho" } })).join(),
    /publisher/,
  ));

test("flags version mismatch when expectedVersion given", () => {
  assert.match(
    checkConfig({ ...okFixture, expectedVersion: "0.9.8-jw.1" }).join(),
    /version/,
  );
  assert.deepEqual(
    checkConfig({
      ...withBase({ version: "0.9.8-jw.1" }),
      expectedVersion: "0.9.8-jw.1",
    }),
    [],
  );
});

test("mergePatch follows RFC 7396", () => {
  assert.deepEqual(
    mergePatch(
      { a: { b: 1, c: 2 }, d: [1] },
      { a: { c: null, e: 3 }, d: { x: 1 } },
    ),
    {
      a: { b: 1, e: 3 },
      d: { x: 1 },
    },
  );
  assert.deepEqual(mergePatch({ a: [1, 2] }, { a: [3] }), { a: [3] });
  assert.deepEqual(mergePatch("text", { a: 1 }), { a: 1 });
});

test("the repo config passes", () =>
  assert.deepEqual(
    checkConfig({
      baseConf: readJson("src-tauri/tauri.conf.json"),
      windowsConf: readJson("src-tauri/tauri.windows.conf.json"),
      identity: readJson("fork/identity.json"),
      pubkey: fs.readFileSync(path.join(repoRoot, "fork/updater.pub"), "utf8"),
    }),
    [],
  ));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "check-config-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test("scanSources finds a planted cjpais/Handy/releases string", () => {
  const plant = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, rel), text);
  };
  const hit =
    'const url = "https://github.com/cjpais/Handy/releases/latest";\n';
  plant("src/components/deep/a.ts", hit);
  plant(
    "src/clean.ts",
    'const url = "https://github.com/jeremywho/Handy/releases/latest";\n',
  );
  plant("src/components/deep/a.test.ts", hit);
  plant("src-tauri/src/b.rs", hit);
  plant("src-tauri/other/c.rs", hit);
  plant("docs/d.md", hit);

  assert.deepEqual(scanSources(tmpRoot), [
    "src-tauri/src/b.rs",
    "src/components/deep/a.ts",
  ]);
});
