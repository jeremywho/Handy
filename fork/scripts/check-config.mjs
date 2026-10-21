import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_RELEASES = "cjpais/Handy/releases";
const SCAN_DIRS = ["src", "src-tauri/src"];
const TEST_FILE = /\.test\./;

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function mergePatch(target, patch) {
  if (!isObject(patch)) return patch;
  const result = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

export function checkConfig({
  baseConf,
  windowsConf,
  identity,
  pubkey,
  expectedVersion,
}) {
  const conf = mergePatch(baseConf, windowsConf ?? {});
  const violations = [];
  const updater = conf.plugins?.updater ?? {};

  const endpoints = updater.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 1) {
    violations.push(
      `plugins.updater.endpoints must hold exactly one endpoint (${identity.endpoint}), got ${JSON.stringify(endpoints)}`,
    );
  } else if (endpoints[0] !== identity.endpoint) {
    violations.push(
      `plugins.updater endpoint is ${endpoints[0]}, expected ${identity.endpoint}`,
    );
  }

  const forkPubkey = (pubkey ?? "").trim();
  if (!forkPubkey)
    violations.push(
      "fork/updater.pub is empty; the updater pubkey has nothing to match",
    );
  else if (updater.pubkey !== forkPubkey) {
    violations.push("plugins.updater.pubkey does not match fork/updater.pub");
  }

  if (conf.bundle?.windows?.signCommand !== undefined) {
    violations.push(
      `bundle.windows.signCommand must be absent, got ${JSON.stringify(conf.bundle.windows.signCommand)}`,
    );
  }

  if (conf.identifier !== identity.identifier) {
    violations.push(
      `identifier is ${conf.identifier}, expected ${identity.identifier}`,
    );
  }
  if (conf.productName !== identity.productName) {
    violations.push(
      `productName is ${conf.productName}, expected ${identity.productName}`,
    );
  }

  // Tauri defaults bundle.publisher to the second segment of the identifier.
  const publisher = conf.bundle?.publisher ?? conf.identifier?.split(".")[1];
  if (publisher !== identity.publisher) {
    violations.push(
      `publisher is ${publisher}, expected ${identity.publisher}`,
    );
  }

  if (expectedVersion !== undefined && conf.version !== expectedVersion) {
    violations.push(`version is ${conf.version}, expected ${expectedVersion}`);
  }

  return violations;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return entry.isFile() ? [full] : [];
  });
}

export function scanSources(rootDir) {
  return SCAN_DIRS.flatMap((dir) => listFiles(path.join(rootDir, dir)))
    .filter((file) => !TEST_FILE.test(path.basename(file)))
    .filter((file) => fs.readFileSync(file, "utf8").includes(UPSTREAM_RELEASES))
    .map((file) => path.relative(rootDir, file).split(path.sep).join("/"))
    .sort();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version" && argv[i + 1] !== undefined)
      args.expectedVersion = argv[++i];
    else if (argv[i].startsWith("--version="))
      args.expectedVersion = argv[i].slice("--version=".length);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const { expectedVersion } = parseArgs(process.argv.slice(2));

  const violations = checkConfig({
    baseConf: JSON.parse(read("src-tauri/tauri.conf.json")),
    windowsConf: JSON.parse(read("src-tauri/tauri.windows.conf.json")),
    identity: JSON.parse(read("fork/identity.json")),
    pubkey: read("fork/updater.pub"),
    expectedVersion,
  });
  for (const file of scanSources(repoRoot)) {
    violations.push(`${file} references ${UPSTREAM_RELEASES}`);
  }

  if (violations.length > 0) {
    console.error(`check-config: ${violations.length} violation(s)`);
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log("check-config: ok");
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(`check-config: ${error.message}`);
    process.exit(1);
  }
}
