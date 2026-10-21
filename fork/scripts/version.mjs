import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_VERSION = /^\d+\.\d+\.\d+$/;
const FORK_VERSION = /^\d+\.\d+\.\d+-jw\.\d+$/;
const TOML_VERSION = /^(version\s*=\s*")([^"]*)(")/;
const JSON_VERSION = /("version"\s*:\s*")([^"]*)(")/;

const CONF = "src-tauri/tauri.conf.json";
const CARGO = "src-tauri/Cargo.toml";
const PKG = "package.json";
const LOCK = "src-tauri/Cargo.lock";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const splitLines = (text) => text.split(/(?<=\n)/);
const bare = (line) => line.replace(/\r?\n$/, "");

export function nextVersion(baseVersion, existingTags) {
  if (typeof baseVersion !== "string" || !BASE_VERSION.test(baseVersion)) {
    throw new Error(
      `invalid base version ${JSON.stringify(baseVersion)}, expected X.Y.Z`,
    );
  }
  const forkTag = new RegExp(`^v?${escapeRegExp(baseVersion)}-jw\\.(\\d+)$`);
  const highest = existingTags.reduce((max, tag) => {
    const match = forkTag.exec(tag);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${baseVersion}-jw.${highest + 1}`;
}

function onlyIndex(indices, what) {
  if (indices.length !== 1) {
    throw new Error(`expected exactly one ${what}, found ${indices.length}`);
  }
  return indices[0];
}

function cargoPackageVersionLine(lines) {
  const header = onlyIndex(
    lines.flatMap((line, i) =>
      /^\[package\]\s*$/.test(bare(line)) ? [i] : [],
    ),
    `[package] table in ${CARGO}`,
  );
  const indices = [];
  for (let i = header + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
    if (TOML_VERSION.test(lines[i])) indices.push(i);
  }
  return onlyIndex(indices, `[package] version in ${CARGO}`);
}

function lockHandyVersionLine(lines) {
  const starts = lines.flatMap((line, i) =>
    /^\[\[package\]\]\s*$/.test(bare(line)) ? [i] : [],
  );
  const blocks = starts.map((start, n) => [
    start,
    starts[n + 1] ?? lines.length,
  ]);
  const handyBlocks = blocks.filter(([start, end]) =>
    lines.slice(start + 1, end).some((line) => bare(line) === 'name = "handy"'),
  );
  const [start, end] = onlyIndex(
    handyBlocks,
    `[[package]] named "handy" in ${LOCK}`,
  );
  const indices = [];
  for (let i = start + 1; i < end; i++) {
    if (TOML_VERSION.test(lines[i])) indices.push(i);
  }
  return onlyIndex(indices, `version for "handy" in ${LOCK}`);
}

function tomlLocator(findLine) {
  return {
    read(text) {
      const lines = splitLines(text);
      return TOML_VERSION.exec(lines[findLine(lines)])[2];
    },
    write(text, version) {
      const lines = splitLines(text);
      const index = findLine(lines);
      lines[index] = lines[index].replace(TOML_VERSION, `$1${version}$3`);
      return lines.join("");
    },
  };
}

function jsonLocator(rel) {
  return {
    read(text) {
      return JSON.parse(text).version;
    },
    write(text, version) {
      if (!JSON_VERSION.test(text)) {
        throw new Error(`no "version" key in ${rel}`);
      }
      const updated = text.replace(JSON_VERSION, `$1${version}$3`);
      const before = JSON.parse(text);
      const after = JSON.parse(updated);
      if (
        after.version !== version ||
        JSON.stringify({ ...after, version: before.version }) !==
          JSON.stringify(before)
      ) {
        throw new Error(`the first "version" key in ${rel} is not top-level`);
      }
      return updated;
    },
  };
}

const TARGETS = {
  conf: [CONF, jsonLocator(CONF)],
  cargo: [CARGO, tomlLocator(cargoPackageVersionLine)],
  pkg: [PKG, jsonLocator(PKG)],
  lock: [LOCK, tomlLocator(lockHandyVersionLine)],
};

const readTarget = (rootDir, rel) =>
  fs.readFileSync(path.join(rootDir, rel), "utf8");

export function readStamped(rootDir) {
  return Object.fromEntries(
    Object.entries(TARGETS).map(([key, [rel, locator]]) => [
      key,
      locator.read(readTarget(rootDir, rel)),
    ]),
  );
}

export function stamp(rootDir, version) {
  if (typeof version !== "string" || !FORK_VERSION.test(version)) {
    throw new Error(
      `invalid version ${JSON.stringify(version)}, expected X.Y.Z-jw.N`,
    );
  }
  const updates = Object.values(TARGETS).map(([rel, locator]) => [
    rel,
    locator.write(readTarget(rootDir, rel), version),
  ]);
  for (const [rel, text] of updates) {
    fs.writeFileSync(path.join(rootDir, rel), text);
  }
}

export function scriptHash() {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  // Hash the LF form so Windows (autocrlf) and Linux checkouts give the same digest as the git blob.
  return crypto
    .createHash("sha256")
    .update(source.replace(/\r\n/g, "\n"))
    .digest("hex");
}

function main() {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "stamp") {
    throw new Error("usage: node fork/scripts/version.mjs stamp <X.Y.Z-jw.N>");
  }
  stamp(repoRoot, args[1]);
  console.log(scriptHash());
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(`version: ${error.message}`);
    process.exit(1);
  }
}
