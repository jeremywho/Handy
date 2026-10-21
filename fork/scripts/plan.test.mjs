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
  githubClient,
  latestPublishedRelease,
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
  "upstream-regressed-below-base": /v0\.9\.7.*v0\.9\.8/,
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
    "rule 4: a broken manifest after an in-runner rebase fixes forward on the published base",
    "broken-manifest-after-rebased-release",
  ],
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
  [
    "rule 7: an owner push after a rebased release rebases N+1 on the same upstream",
    "owner-pushed-after-rebased-release",
  ],
  ["rule 8: an unchanged jw head and base is a no-op", "noop"],
  [
    "rule 8: an unchanged jw after an in-runner rebase is a no-op",
    "unchanged-after-in-runner-rebase",
  ],
  [
    "an upstream latest older than the base stops",
    "upstream-regressed-below-base",
  ],
  [
    "rule 4: a broken public manifest builds N+1 even when upstream regressed",
    "upstream-regressed-broken-manifest",
  ],
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

test("an upstream regression below the base does not block resuming a draft", () => {
  const { state } = loadFixture("draft-matching-head");
  const decision = decide({
    ...state,
    upstreamLatest: {
      tag: "v0.9.7",
      sha: "6".repeat(40),
      confVersion: "0.9.7",
    },
  });
  assert.deepEqual(decision, {
    action: "resume",
    draftId: 202,
    version: "0.9.8-jw.3",
    sourceSha: state.jwHead,
  });
});

test("noop keys on the published pre-rebase head, not its source SHA", () => {
  const { state } = loadFixture("noop");
  const decision = decide({
    ...state,
    latestPublished: {
      ...state.latestPublished,
      preRebaseHead: "2".repeat(40),
    },
  });
  assert.deepEqual(decision, { action: "build", version: "0.9.8-jw.3" });
});

test("noop needs the published base to be upstream's latest", () => {
  const { state } = loadFixture("noop");
  const decision = decide({
    ...state,
    latestPublished: { ...state.latestPublished, baseSha: "5".repeat(40) },
  });
  assert.deepEqual(decision, { action: "build", version: "0.9.8-jw.3" });
});

test("a broken manifest fixes forward on fork/base.json when it is newer than the published base", () => {
  const { state } = loadFixture("broken-manifest-after-rebased-release");
  const decision = decide({
    ...state,
    base: { tag: "v0.9.10", sha: "9".repeat(39) + "2" },
  });
  assert.deepEqual(decision, { action: "build", version: "0.9.10-jw.1" });
});

test("a broken manifest whose published base tag is malformed stops", () => {
  const { state } = loadFixture("broken-manifest-after-rebased-release");
  const decision = decide({
    ...state,
    latestPublished: { ...state.latestPublished, baseTag: "main" },
  });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /main/);
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

function routedFetch(route) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const { body, headers = {} } = route(new URL(url));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { fetch, calls };
}

const noSleep = async () => {};

test("matchingRefs makes one call even though the endpoint ignores paging", async () => {
  const refs = Array.from({ length: 150 }, (_, i) => ({
    ref: `refs/tags/v0.${i}.0`,
  }));
  const { fetch, calls } = routedFetch(() => ({ body: refs }));
  const github = githubClient({ fetch, sleep: noSleep });
  const result = await github.matchingRefs("jeremywho/Handy", "tags/v");
  assert.equal(result.length, 150);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0],
    /\/repos\/jeremywho\/Handy\/git\/matching-refs\/tags\/v$/,
  );
});

test("apiList follows rel=next and stops when there is no next link", async () => {
  const page = (n) =>
    Array.from({ length: 100 }, (_, i) => ({ id: n * 1000 + i }));
  const { fetch, calls } = routedFetch((url) => {
    const n = Number(url.searchParams.get("page") ?? "1");
    if (n === 1) {
      return {
        body: page(1),
        headers: {
          link: '<https://api.github.com/repos/jeremywho/Handy/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repos/jeremywho/Handy/releases?per_page=100&page=2>; rel="last"',
        },
      };
    }
    return { body: page(2) };
  });
  const github = githubClient({ fetch, sleep: noSleep });
  const items = await github.apiList("/repos/jeremywho/Handy/releases");
  assert.equal(items.length, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((url) => new URL(url).searchParams.get("page")),
    [null, "2"],
  );
});

test("apiList stops when a page repeats the previous page", async () => {
  const same = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const { fetch, calls } = routedFetch((url) => ({
    body: same,
    headers: {
      link: `<https://api.github.com/repos/x/y/releases?per_page=100&page=${Number(url.searchParams.get("page") ?? "1") + 1}>; rel="next"`,
    },
  }));
  const github = githubClient({ fetch, sleep: noSleep });
  const items = await github.apiList("/repos/x/y/releases");
  assert.equal(items.length, 100);
  assert.equal(calls.length, 2);
});

const PROVENANCE = {
  version: "0.9.9-jw.1",
  sourceSha: "c".repeat(40),
  preRebaseHead: "1".repeat(40),
  baseTag: "v0.9.9",
  baseSha: "9".repeat(39) + "1",
};

function releaseRoute(provenance) {
  return (url) => {
    if (url.pathname === "/repos/jeremywho/Handy/releases/latest") {
      return {
        body: {
          tag_name: "v0.9.9-jw.1",
          assets: [{ id: 7, name: "provenance.json", state: "uploaded" }],
        },
      };
    }
    if (url.pathname === "/repos/jeremywho/Handy/releases/assets/7") {
      return { body: provenance };
    }
    throw new Error(`unexpected ${url}`);
  };
}

test("latestPublishedRelease returns the provenance fields decide() needs", async () => {
  const { fetch } = routedFetch(releaseRoute(PROVENANCE));
  const github = githubClient({ fetch, sleep: noSleep });
  assert.deepEqual(await latestPublishedRelease(github), PROVENANCE);
});

for (const field of ["sourceSha", "preRebaseHead", "baseSha"]) {
  test(`latestPublishedRelease throws when provenance lacks ${field}`, async () => {
    const { fetch } = routedFetch(
      releaseRoute({ ...PROVENANCE, [field]: undefined }),
    );
    const github = githubClient({ fetch, sleep: noSleep });
    await assert.rejects(latestPublishedRelease(github), new RegExp(field));
  });
}

test("latestPublishedRelease throws when provenance lacks a base tag", async () => {
  const { fetch } = routedFetch(
    releaseRoute({ ...PROVENANCE, baseTag: undefined }),
  );
  const github = githubClient({ fetch, sleep: noSleep });
  await assert.rejects(latestPublishedRelease(github), /baseTag/);
});
