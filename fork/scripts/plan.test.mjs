import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decide,
  rebaseChecks,
  fetchWithRetry,
  formatOutputs,
  parseWorkflowChanges,
  uniqueTags,
} from "./plan.mjs";

const fixtureDir = fileURLToPath(new URL("./fixtures/plan/", import.meta.url));
const loadFixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));

const STOP_REASONS = {
  "new-upstream-adds-workflow": /new-thing\.yml/,
  "new-upstream-touches-fork-release": /fork-release\.yml/,
  "tag-version-mismatch": /0\.9\.9-rc1/,
  retagged: /v0\.9\.8/,
  "stale-draft-plus-new-upstream": /stale draft.*301.*v0\.9\.9-jw\.1/,
  "draft-without-provenance": /stale draft.*305/,
};

function checkFixture(name) {
  const { state, expected } = loadFixture(name);
  const decision = decide(state);
  if (expected.action === "stop") {
    assert.equal(decision.action, "stop", JSON.stringify(decision));
    assert.equal(typeof decision.reason, "string");
    assert.match(decision.reason, STOP_REASONS[name]);
  } else {
    assert.deepEqual(decision, expected);
  }
}

const RULE_FIXTURES = [
  ["rule 1: a re-tagged base stops", "retagged"],
  [
    "rule 2: an upstream tag whose app version differs stops",
    "tag-version-mismatch",
  ],
  [
    "rule 3: a stale draft plus a new upstream stops",
    "stale-draft-plus-new-upstream",
  ],
  [
    "rule 3: a draft matching jw's head resumes with its version",
    "draft-matching-head",
  ],
  [
    "rule 3: a draft matching jw's head resumes even when upstream moved on",
    "draft-matching-head-plus-new-upstream",
  ],
  [
    "rule 3: a draft rebased from jw's head onto the current upstream resumes",
    "draft-matching-pre-rebase-head",
  ],
  ["rule 3: a draft without provenance is stale", "draft-without-provenance"],
  ["rule 4: a broken public manifest builds N+1", "broken-public-manifest"],
  ["rule 4: a missing public manifest builds N+1", "missing-public-manifest"],
  [
    "rule 5: a new upstream that adds a workflow stops",
    "new-upstream-adds-workflow",
  ],
  [
    "rule 5: a new upstream that touches fork-release.yml stops",
    "new-upstream-touches-fork-release",
  ],
  ["rule 6: a new upstream rebases with N from 1", "new-upstream"],
  ["rule 7: a push to jw builds the next N", "jw-push"],
  ["rule 7: the first release builds jw.1", "first-release"],
  ["rule 8: nothing changed is a no-op", "noop"],
];

for (const [title, name] of RULE_FIXTURES) {
  test(`${title} (${name})`, () => checkFixture(name));
}

test("every fixture file is exercised", () => {
  const files = fs
    .readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
  assert.deepEqual(files, RULE_FIXTURES.map(([, name]) => name).sort());
});

test("rules apply in order: retagged beats a matching draft", () => {
  const { state } = loadFixture("draft-matching-head");
  assert.equal(decide({ ...state, retagged: true }).action, "stop");
});

test("rules apply in order: a version mismatch beats a matching draft", () => {
  const { state } = loadFixture("draft-matching-head");
  const decision = decide({
    ...state,
    upstreamLatest: { ...state.upstreamLatest, confVersion: "0.9.8-rc1" },
  });
  assert.equal(decision.action, "stop");
});

test("rules apply in order: a broken manifest builds before rebasing", () => {
  const { state } = loadFixture("new-upstream");
  assert.deepEqual(decide({ ...state, publicManifestVersion: "0.9.8-jw.1" }), {
    action: "build",
    version: "0.9.8-jw.3",
  });
});

test("fork tags are trimmed and deduplicated before computing N", () => {
  const { state } = loadFixture("jw-push");
  const decision = decide({
    ...state,
    forkTags: [" v0.9.8-jw.1\r", "v0.9.8-jw.4\r\n", "v0.9.8-jw.4", "  "],
  });
  assert.deepEqual(decision, { action: "build", version: "0.9.8-jw.5" });
  assert.deepEqual(uniqueTags(["a\r", " a ", "b", "", "b\n"]), ["a", "b"]);
});

test("two drafts matching jw's head is ambiguous and stops", () => {
  const { state } = loadFixture("draft-matching-head");
  const decision = decide({
    ...state,
    drafts: [
      ...state.drafts,
      { ...state.drafts[0], id: 203, tag: "v0.9.8-jw.4" },
    ],
  });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /202.*203|ambiguous/);
});

test("a matching draft alongside a stale one stops", () => {
  const { state } = loadFixture("draft-matching-head");
  const decision = decide({
    ...state,
    drafts: [
      ...state.drafts,
      {
        id: 99,
        tag: "v0.9.8-jw.9",
        sourceSha: "f".repeat(40),
        preRebaseHead: null,
        baseSha: null,
      },
    ],
  });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /99/);
});

test("a draft matching on its pre-rebase head but with no source SHA is stale", () => {
  const { state } = loadFixture("draft-matching-pre-rebase-head");
  const decision = decide({
    ...state,
    drafts: [{ ...state.drafts[0], sourceSha: null }],
  });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /stale draft.*304/);
});

test("a draft with a malformed tag stops instead of throwing", () => {
  const { state } = loadFixture("draft-matching-head");
  const decision = decide({
    ...state,
    drafts: [{ ...state.drafts[0], tag: "nightly" }],
  });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /nightly/);
});

test("a non-release upstream tag stops instead of throwing", () => {
  const { state } = loadFixture("new-upstream");
  const decision = decide({
    ...state,
    upstreamLatest: {
      ...state.upstreamLatest,
      tag: "v0.9.9-rc1",
      confVersion: "0.9.9-rc1",
    },
  });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /v0\.9\.9-rc1/);
});

test("a malformed base tag stops instead of throwing", () => {
  const { state } = loadFixture("noop");
  const decision = decide({ ...state, base: { ...state.base, tag: "main" } });
  assert.equal(decision.action, "stop");
});

test("upstream newer compares numerically, not as strings", () => {
  const { state } = loadFixture("new-upstream");
  const decision = decide({
    ...state,
    base: { tag: "v0.9.9", sha: "8".repeat(40) },
    upstreamLatest: {
      tag: "v0.9.10",
      sha: "7".repeat(40),
      confVersion: "0.9.10",
    },
    latestPublished: { version: "0.9.9-jw.1", sourceSha: state.jwHead },
    publicManifestVersion: "0.9.9-jw.1",
    forkTags: ["v0.9.9-jw.1"],
  });
  assert.deepEqual(decision, {
    action: "rebase",
    onto: { tag: "v0.9.10", sha: "7".repeat(40) },
    version: "0.9.10-jw.1",
  });
});

test("an upstream latest older than the base is not a rebase", () => {
  const { state } = loadFixture("noop");
  const decision = decide({
    ...state,
    upstreamLatest: {
      tag: "v0.9.7",
      sha: "6".repeat(40),
      confVersion: "0.9.7",
    },
  });
  assert.deepEqual(decision, { action: "noop" });
});

test("rebaseChecks passes a clean rebase", () =>
  assert.deepEqual(
    rebaseChecks({ mergesInRange: 0, countBefore: 5, countAfter: 5 }),
    [],
  ));

test("rebaseChecks reports merges in the range", () => {
  const violations = rebaseChecks({
    mergesInRange: 2,
    countBefore: 5,
    countAfter: 5,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /2 merge/);
});

test("rebaseChecks reports a dropped commit", () => {
  const violations = rebaseChecks({
    mergesInRange: 0,
    countBefore: 5,
    countAfter: 4,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /5.*4/);
});

test("rebaseChecks reports both violations together", () =>
  assert.equal(
    rebaseChecks({ mergesInRange: 1, countBefore: 3, countAfter: 2 }).length,
    2,
  ));

test("rebaseChecks rejects non-count input", () =>
  assert.equal(
    rebaseChecks({ mergesInRange: "0", countBefore: 3, countAfter: 3 }).length,
    1,
  ));

test("parseWorkflowChanges lists added files and spots fork-release.yml", () => {
  assert.deepEqual(
    parseWorkflowChanges(
      "M\t.github/workflows/build.yml\r\nA\t.github/workflows/new.yml\nD\t.github/workflows/old.yml\n",
    ),
    { added: [".github/workflows/new.yml"], touchesForkRelease: false },
  );
  assert.deepEqual(
    parseWorkflowChanges("M\t.github/workflows/fork-release.yml\n"),
    { added: [], touchesForkRelease: true },
  );
  assert.deepEqual(parseWorkflowChanges(""), {
    added: [],
    touchesForkRelease: false,
  });
});

test("formatOutputs writes the decision and its fields", () => {
  const text = formatOutputs(
    {
      action: "rebase",
      onto: { tag: "v0.9.9", sha: "abc" },
      version: "0.9.9-jw.1",
    },
    { jwHead: "def" },
  );
  const lines = text.split("\n");
  assert.ok(
    lines.includes(
      'decision={"action":"rebase","onto":{"tag":"v0.9.9","sha":"abc"},"version":"0.9.9-jw.1"}',
    ),
  );
  for (const line of [
    "action=rebase",
    "release=true",
    "version=0.9.9-jw.1",
    "onto_tag=v0.9.9",
    "onto_sha=abc",
    "jw_head=def",
  ]) {
    assert.ok(lines.includes(line), line);
  }
  assert.ok(text.endsWith("\n"));
});

test("formatOutputs marks noop and stop as no release and fences multi-line values", () => {
  assert.ok(
    formatOutputs({ action: "noop" }, { jwHead: "x" })
      .split("\n")
      .includes("release=false"),
  );
  const text = formatOutputs(
    { action: "stop", reason: "line one\nline two" },
    { jwHead: "x" },
  );
  assert.ok(text.split("\n").includes("release=false"));
  assert.match(text, /reason<<(\S+)\nline one\nline two\n\1\n/);
});

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body ?? "", {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
  return { fetch, calls };
}

function recorder() {
  const delays = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

test("fetchWithRetry backs off 2 s then 4 s on server errors", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 502 },
    { status: 503 },
    { status: 200, body: "ok" },
  ]);
  const { delays, sleep } = recorder();
  const res = await fetchWithRetry(
    "https://x/",
    {},
    { fetch, sleep, now: () => NOW },
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [2000, 4000]);
});

test("fetchWithRetry honours retry-after seconds", async () => {
  const { fetch } = fakeFetch([
    { status: 429, headers: { "retry-after": "7" } },
    { status: 200 },
  ]);
  const { delays, sleep } = recorder();
  await fetchWithRetry("https://x/", {}, { fetch, sleep, now: () => NOW });
  assert.deepEqual(delays, [7000]);
});

test("fetchWithRetry honours x-ratelimit-reset when the limit is exhausted, capped at 60 s", async () => {
  const resetIn = (s) => String(NOW / 1000 + s);
  const { fetch } = fakeFetch([
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": resetIn(12),
      },
    },
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": resetIn(3600),
      },
    },
    { status: 200 },
  ]);
  const { delays, sleep } = recorder();
  await fetchWithRetry("https://x/", {}, { fetch, sleep, now: () => NOW });
  assert.deepEqual(delays, [12000, 60000]);
});

test("fetchWithRetry caps retry-after at 60 s", async () => {
  const { fetch } = fakeFetch([
    { status: 503, headers: { "retry-after": "900" } },
    { status: 200 },
  ]);
  const { delays, sleep } = recorder();
  await fetchWithRetry("https://x/", {}, { fetch, sleep, now: () => NOW });
  assert.deepEqual(delays, [60000]);
});

test("fetchWithRetry ignores x-ratelimit-reset on a plain server error", async () => {
  const { fetch } = fakeFetch([
    {
      status: 502,
      headers: {
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": String(NOW / 1000 + 3000),
      },
    },
    { status: 200 },
  ]);
  const { delays, sleep } = recorder();
  await fetchWithRetry("https://x/", {}, { fetch, sleep, now: () => NOW });
  assert.deepEqual(delays, [2000]);
});

test("fetchWithRetry retries network errors", async () => {
  const { fetch, calls } = fakeFetch([
    new TypeError("fetch failed"),
    { status: 200 },
  ]);
  const { delays, sleep } = recorder();
  await fetchWithRetry("https://x/", {}, { fetch, sleep, now: () => NOW });
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [2000]);
});

test("fetchWithRetry gives up after 3 attempts", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 500 },
    { status: 500 },
    { status: 500 },
    { status: 200 },
  ]);
  const { delays, sleep } = recorder();
  await assert.rejects(
    fetchWithRetry("https://x/", {}, { fetch, sleep, now: () => NOW }),
    /3 attempts.*500/,
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [2000, 4000]);
});

test("fetchWithRetry returns 404 without retrying", async () => {
  const { fetch, calls } = fakeFetch([{ status: 404 }, { status: 200 }]);
  const { delays, sleep } = recorder();
  const res = await fetchWithRetry(
    "https://x/",
    {},
    { fetch, sleep, now: () => NOW },
  );
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test("fetchWithRetry fails at once on other client errors", async () => {
  const { fetch, calls } = fakeFetch([{ status: 401 }, { status: 200 }]);
  const { sleep } = recorder();
  await assert.rejects(
    fetchWithRetry("https://x/", {}, { fetch, sleep, now: () => NOW }),
    /401/,
  );
  assert.equal(calls.length, 1);
});
