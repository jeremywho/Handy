import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextVersion } from "./version.mjs";

const FORK_REPO = "jeremywho/Handy";
const UPSTREAM_REPO = "cjpais/Handy";
const UPSTREAM_GIT_URL = `https://github.com/${UPSTREAM_REPO}.git`;
const UPSTREAM_TAG_NAMESPACE = "refs/upstream-tags";
const PUBLIC_MANIFEST_URL = `https://github.com/${FORK_REPO}/releases/latest/download/latest.json`;
const FORK_RELEASE_WORKFLOW = ".github/workflows/fork-release.yml";
const PROVENANCE_ASSET = "provenance.json";

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const FORK_TAG = /^v(\d+\.\d+\.\d+-jw\.\d+)$/;
const ATTEMPTS = 3;
const MAX_DELAY_MS = 60_000;

const stop = (reason) => ({ action: "stop", reason });

export const uniqueTags = (tags) => [
  ...new Set((tags ?? []).map((tag) => String(tag).trim()).filter(Boolean)),
];

function releaseVersion(tag) {
  const match = RELEASE_TAG.exec(tag ?? "");
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function draftMatches(draft, jwHead, upstreamSha) {
  if (!draft.sourceSha) return false;
  if (draft.sourceSha === jwHead) return true;
  return Boolean(
    draft.preRebaseHead &&
      draft.preRebaseHead === jwHead &&
      draft.baseSha &&
      draft.baseSha === upstreamSha,
  );
}

const describeDraft = (draft) =>
  `#${draft.id} ${draft.tag} (source ${draft.sourceSha ?? "unknown: no provenance"}, pre-rebase ${draft.preRebaseHead ?? "unknown"}, base ${draft.baseSha ?? "unknown"})`;

export function decide(state) {
  const {
    base,
    upstreamLatest,
    jwHead,
    latestPublished,
    publicManifestVersion,
    drafts = [],
    forkTags = [],
    upstreamWorkflowChanges,
    retagged,
  } = state;

  if (retagged) {
    return stop(
      `upstream re-tagged ${base.tag}: it no longer peels to ${base.sha}`,
    );
  }
  if (upstreamLatest.tag.replace(/^v/, "") !== upstreamLatest.confVersion) {
    return stop(
      `upstream tag ${upstreamLatest.tag} has app version ${upstreamLatest.confVersion} in tauri.conf.json`,
    );
  }
  const baseVersion = releaseVersion(base.tag);
  if (!baseVersion) return stop(`base tag ${base.tag} is not vX.Y.Z`);
  const upstreamVersion = releaseVersion(upstreamLatest.tag);
  if (!upstreamVersion) {
    return stop(`upstream latest tag ${upstreamLatest.tag} is not vX.Y.Z`);
  }
  if (compareVersions(upstreamVersion, baseVersion) < 0) {
    return stop(
      `upstream latest ${upstreamLatest.tag} is older than the base ${base.tag}`,
    );
  }

  if (drafts.length > 0) {
    const stale = drafts.filter(
      (draft) => !draftMatches(draft, jwHead, upstreamLatest.sha),
    );
    if (stale.length > 0) {
      return stop(
        `stale draft release(s) match neither jw's head ${jwHead} nor a rebase of it onto ${upstreamLatest.tag}; delete them after review: ${stale.map(describeDraft).join("; ")}`,
      );
    }
    if (drafts.length > 1) {
      return stop(
        `ambiguous: draft releases ${drafts.map((draft) => `#${draft.id}`).join(", ")} all match jw's head ${jwHead}`,
      );
    }
    const [draft] = drafts;
    const match = FORK_TAG.exec(draft.tag ?? "");
    if (!match) {
      return stop(
        `draft #${draft.id} has tag ${draft.tag}, expected vX.Y.Z-jw.N`,
      );
    }
    return {
      action: "resume",
      draftId: draft.id,
      version: match[1],
      sourceSha: draft.sourceSha,
    };
  }

  const tags = uniqueTags(forkTags);
  const baseNumber = base.tag.slice(1);

  if (latestPublished && publicManifestVersion !== latestPublished.version) {
    return { action: "build", version: nextVersion(baseNumber, tags) };
  }

  if (compareVersions(upstreamVersion, baseVersion) > 0) {
    const added = upstreamWorkflowChanges?.added ?? [];
    if (added.length > 0) {
      return stop(
        `upstream ${upstreamLatest.tag} adds workflow file(s) ${added.join(", ")}; review before rebasing`,
      );
    }
    if (upstreamWorkflowChanges?.touchesForkRelease) {
      return stop(
        `upstream ${upstreamLatest.tag} touches ${FORK_RELEASE_WORKFLOW}; review before rebasing`,
      );
    }
    return {
      action: "rebase",
      onto: { tag: upstreamLatest.tag, sha: upstreamLatest.sha },
      version: nextVersion(upstreamLatest.tag.slice(1), tags),
    };
  }

  if (!latestPublished || jwHead !== latestPublished.sourceSha) {
    return { action: "build", version: nextVersion(baseNumber, tags) };
  }
  return { action: "noop" };
}

export function rebaseChecks({ mergesInRange, countBefore, countAfter }) {
  const counts = { mergesInRange, countBefore, countAfter };
  const invalid = Object.entries(counts).filter(
    ([, value]) => !Number.isInteger(value) || value < 0,
  );
  if (invalid.length > 0) {
    return [
      `rebaseChecks needs non-negative integer counts, got ${invalid.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")}`,
    ];
  }
  const violations = [];
  if (mergesInRange > 0) {
    violations.push(
      `${mergesInRange} merge commit(s) in the rebase range; rebase --onto would flatten them`,
    );
  }
  if (countAfter !== countBefore) {
    violations.push(
      `${countBefore} fork commit(s) before the rebase, ${countAfter} after; a commit was dropped or emptied`,
    );
  }
  return violations;
}

export function parseWorkflowChanges(nameStatus) {
  const entries = nameStatus
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split("\t"));
  return {
    added: entries
      .filter(([status]) => status.startsWith("A"))
      .map(([, file]) => file),
    touchesForkRelease: entries.some(([, ...files]) =>
      files.includes(FORK_RELEASE_WORKFLOW),
    ),
  };
}

function outputEntry(name, value) {
  if (!/[\r\n]/.test(value)) return `${name}=${value}\n`;
  const delimiter = `EOF_${crypto.randomBytes(8).toString("hex")}`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

export function formatOutputs(decision, { jwHead }) {
  const fields = {
    decision: JSON.stringify(decision),
    action: decision.action,
    release: String(["resume", "rebase", "build"].includes(decision.action)),
    reason: decision.reason,
    version: decision.version,
    draft_id: decision.draftId,
    source_sha: decision.sourceSha,
    onto_tag: decision.onto?.tag,
    onto_sha: decision.onto?.sha,
    jw_head: jwHead,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => outputEntry(name, String(value)))
    .join("");
}

function retryDelayMs(res, attempt, nowMs) {
  const retryAfter = res?.headers.get("retry-after")?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, MAX_DELAY_MS);
  }
  const reset = Number(res?.headers.get("x-ratelimit-reset"));
  if (
    res?.headers.get("x-ratelimit-remaining") === "0" &&
    Number.isFinite(reset)
  ) {
    return Math.min(Math.max(reset * 1000 - nowMs, 0), MAX_DELAY_MS);
  }
  return 2000 * 2 ** (attempt - 1);
}

function isRetryable(res) {
  if (res.status >= 500 || res.status === 429) return true;
  return (
    res.status === 403 &&
    (res.headers.get("x-ratelimit-remaining") === "0" ||
      res.headers.has("retry-after"))
  );
}

export async function fetchWithRetry(
  url,
  init = {},
  {
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (error) {
      lastError = error.message;
    }
    if (res) {
      if (res.ok || res.status === 404) return res;
      await res.body?.cancel();
      if (!isRetryable(res)) throw new Error(`GET ${url}: HTTP ${res.status}`);
      lastError = `HTTP ${res.status}`;
    }
    if (attempt === ATTEMPTS) break;
    await sleep(retryDelayMs(res, attempt, now()));
  }
  throw new Error(
    `GET ${url}: failed after ${ATTEMPTS} attempts, last: ${lastError}`,
  );
}

const MAX_PAGES = 50;

function nextLink(header) {
  for (const part of (header ?? "").split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return null;
}

export function githubClient({ token, fetch, sleep }) {
  const apiHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "handy-fork-plan",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const get = async (url, headers) => {
    const res = await fetchWithRetry(url, { headers }, { fetch, sleep });
    return res.status === 404 ? null : res;
  };
  return {
    async api(pathname) {
      const res = await get(`https://api.github.com${pathname}`, apiHeaders);
      return res && res.json();
    },
    async apiList(pathname) {
      const sep = pathname.includes("?") ? "&" : "?";
      let url = `https://api.github.com${pathname}${sep}per_page=100`;
      const items = [];
      let previousFirst;
      for (let page = 1; url; page++) {
        if (page > MAX_PAGES) {
          throw new Error(`${pathname}: more than ${MAX_PAGES} pages`);
        }
        const res = await get(url, apiHeaders);
        if (!res) return items;
        const batch = await res.json();
        const first = JSON.stringify(batch[0]);
        if (batch.length === 0 || first === previousFirst) return items;
        items.push(...batch);
        previousFirst = first;
        url = nextLink(res.headers.get("link"));
      }
      return items;
    },
    async matchingRefs(repo, prefix) {
      return (
        (await this.api(`/repos/${repo}/git/matching-refs/${prefix}`)) ?? []
      );
    },
    async assetText(repo, assetId) {
      const res = await get(
        `https://api.github.com/repos/${repo}/releases/assets/${assetId}`,
        { ...apiHeaders, Accept: "application/octet-stream" },
      );
      return res && res.text();
    },
    async publicText(url) {
      const res = await get(url, { "User-Agent": "handy-fork-plan" });
      return res && res.text();
    },
  };
}

function gitRunner(cwd) {
  return (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function peel(git, ref) {
  try {
    return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch {
    return null;
  }
}

const SHA = /^[0-9a-f]{40}$/;
const shaOrNull = (value) =>
  typeof value === "string" && SHA.test(value) ? value : null;

async function readProvenance(github, release) {
  const asset = (release.assets ?? []).find(
    (candidate) =>
      candidate.name === PROVENANCE_ASSET && candidate.state === "uploaded",
  );
  if (!asset) return null;
  const text = await github.assetText(FORK_REPO, asset.id);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function latestPublishedRelease(github) {
  const release = await github.api(`/repos/${FORK_REPO}/releases/latest`);
  if (!release) return null;
  const provenance = await readProvenance(github, release);
  const version = release.tag_name.replace(/^v/, "");
  if (!provenance || !shaOrNull(provenance.sourceSha)) {
    throw new Error(
      `latest published release ${release.tag_name} has no readable ${PROVENANCE_ASSET} with a sourceSha`,
    );
  }
  if (provenance.version !== version) {
    throw new Error(
      `latest published release ${release.tag_name} has provenance version ${provenance.version}`,
    );
  }
  return { version, sourceSha: provenance.sourceSha };
}

async function draftReleases(github, releases) {
  const drafts = [];
  for (const release of releases.filter((candidate) => candidate.draft)) {
    const provenance = (await readProvenance(github, release)) ?? {};
    drafts.push({
      id: release.id,
      tag: release.tag_name,
      sourceSha: shaOrNull(provenance.sourceSha),
      preRebaseHead: shaOrNull(provenance.preRebaseHead),
      baseSha: shaOrNull(provenance.baseSha),
    });
  }
  return drafts;
}

async function forkTagNames(github, releases) {
  const refs = await github.matchingRefs(FORK_REPO, "tags/v");
  return uniqueTags([
    ...refs.map((ref) => ref.ref.replace(/^refs\/tags\//, "")),
    ...releases.map((release) => release.tag_name),
  ]).filter((tag) => /-jw\./.test(tag));
}

async function publicManifestVersion(github) {
  const text = await github.publicText(PUBLIC_MANIFEST_URL);
  if (text === null) return null;
  try {
    const version = JSON.parse(text).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export async function gatherState({ repoRoot, token, fetch, sleep }) {
  const git = gitRunner(repoRoot);
  const github = githubClient({ token, fetch, sleep });
  const base = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "fork/base.json"), "utf8"),
  );

  git(
    "fetch",
    "--quiet",
    "--prune",
    "--no-tags",
    UPSTREAM_GIT_URL,
    `+refs/tags/*:${UPSTREAM_TAG_NAMESPACE}/*`,
  );

  const upstreamRelease = await github.api(
    `/repos/${UPSTREAM_REPO}/releases/latest`,
  );
  if (!upstreamRelease)
    throw new Error(`${UPSTREAM_REPO} has no latest release`);
  const upstreamTag = upstreamRelease.tag_name.trim();
  const upstreamRef = `${UPSTREAM_TAG_NAMESPACE}/${upstreamTag}`;
  const upstreamSha = peel(git, upstreamRef);
  if (!upstreamSha)
    throw new Error(`upstream tag ${upstreamTag} was not fetched`);
  const confVersion = JSON.parse(
    git("show", `${upstreamRef}:src-tauri/tauri.conf.json`),
  ).version;

  const releases = await github.apiList(`/repos/${FORK_REPO}/releases`);

  return {
    base: { tag: base.tag, sha: base.sha },
    upstreamLatest: { tag: upstreamTag, sha: upstreamSha, confVersion },
    jwHead: git("rev-parse", "HEAD"),
    latestPublished: await latestPublishedRelease(github),
    publicManifestVersion: await publicManifestVersion(github),
    drafts: await draftReleases(github, releases),
    forkTags: await forkTagNames(github, releases),
    upstreamWorkflowChanges:
      upstreamSha === base.sha
        ? { added: [], touchesForkRelease: false }
        : parseWorkflowChanges(
            git(
              "diff",
              "--no-renames",
              "--name-status",
              base.sha,
              upstreamSha,
              "--",
              ".github/workflows/",
            ),
          ),
    retagged: peel(git, `${UPSTREAM_TAG_NAMESPACE}/${base.tag}`) !== base.sha,
  };
}

const COUNT = /^\d+$/;
const parseCount = (text) => (COUNT.test(text ?? "") ? Number(text) : NaN);

async function main(argv) {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  if (argv[0] === "rebase-checks") {
    if (argv.length !== 4) {
      throw new Error(
        "usage: node fork/scripts/plan.mjs rebase-checks <merges> <before> <after>",
      );
    }
    const violations = rebaseChecks({
      mergesInRange: parseCount(argv[1]),
      countBefore: parseCount(argv[2]),
      countAfter: parseCount(argv[3]),
    });
    for (const violation of violations) console.error(`plan: ${violation}`);
    process.exit(violations.length > 0 ? 1 : 0);
  }
  if (argv.length > 0) {
    throw new Error(
      "usage: node fork/scripts/plan.mjs [rebase-checks <merges> <before> <after>]",
    );
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token)
    console.error("plan: no GH_TOKEN; draft releases are not visible");
  const state = await gatherState({ repoRoot, token });
  console.error(`plan: state ${JSON.stringify(state)}`);
  const decision = decide(state);
  console.log(JSON.stringify(decision));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      formatOutputs(decision, { jwHead: state.jwHead }),
    );
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`plan: ${error.message}`);
    process.exit(1);
  });
}
