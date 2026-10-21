import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORK_VERSION = /^\d+\.\d+\.\d+-jw\.\d+$/;
const ASSET_NAME = /^[A-Za-z0-9._-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DOWNLOAD_BASE = "https://github.com/jeremywho/Handy/releases/download";
const PLATFORMS = ["windows-x86_64", "windows-x86_64-nsis"];

function checkVersion(version) {
  if (typeof version !== "string" || !FORK_VERSION.test(version)) {
    throw new Error(
      `invalid version ${JSON.stringify(version)}, expected X.Y.Z-jw.N`,
    );
  }
}

export function assetUrl(version, file) {
  checkVersion(version);
  if (typeof file !== "string" || !ASSET_NAME.test(file)) {
    throw new Error(`invalid asset file name ${JSON.stringify(file)}`);
  }
  return `${DOWNLOAD_BASE}/v${version}/${file}`;
}

export function buildManifest({ version, url, signature, pubDate }) {
  checkVersion(version);
  const prefix = `${DOWNLOAD_BASE}/v${version}/`;
  const file =
    typeof url === "string" && url.startsWith(prefix)
      ? url.slice(prefix.length)
      : null;
  if (file === null || !ASSET_NAME.test(file)) {
    throw new Error(`url ${JSON.stringify(url)} is not ${prefix}<file>`);
  }
  // Tauri's updater base64-decodes this field, so surrounding whitespace would break the update.
  const sig = typeof signature === "string" ? signature.trim() : "";
  if (!BASE64.test(sig) || sig.length % 4 !== 0) {
    throw new Error(
      "signature must be the .sig file's single-line base64 text",
    );
  }
  if (
    typeof pubDate !== "string" ||
    !RFC3339.test(pubDate) ||
    Number.isNaN(Date.parse(pubDate))
  ) {
    throw new Error(`pub_date ${JSON.stringify(pubDate)} is not RFC 3339`);
  }
  return {
    version,
    notes: "",
    pub_date: pubDate,
    platforms: Object.fromEntries(
      PLATFORMS.map((platform) => [platform, { signature: sig, url }]),
    ),
  };
}

const nowRfc3339 = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.length > 4) {
    throw new Error(
      "usage: node fork/scripts/manifest.mjs <version> <installer> <sig> [pub-date]",
    );
  }
  const [version, installer, sigFile, pubDate = nowRfc3339()] = args;
  const manifest = buildManifest({
    version,
    url: assetUrl(version, path.basename(installer)),
    signature: fs.readFileSync(sigFile, "utf8"),
    pubDate,
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(`manifest: ${error.message}`);
    process.exit(1);
  }
}
