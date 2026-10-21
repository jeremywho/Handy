import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const UNTRUSTED = "untrusted comment: ";
const TRUSTED = "trusted comment: ";

class SigError extends Error {}

function strictBase64(text, what) {
  const trimmed = text.trim();
  if (!BASE64.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new SigError(`${what} is not valid base64`);
  }
  return Buffer.from(trimmed, "base64");
}

function minisignLines(fileText, what, count) {
  const lines = strictBase64(fileText, what)
    .toString("utf8")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  while (lines.length > count && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== count || !lines[0].startsWith(UNTRUSTED)) {
    throw new SigError(`${what} is not a minisign ${count}-line file`);
  }
  return lines;
}

function payload(line, what, length) {
  const bytes = strictBase64(line, what);
  if (bytes.length !== length) {
    throw new SigError(`${what} is ${bytes.length} bytes, expected ${length}`);
  }
  return bytes;
}

// Minisign public key, line 2: "Ed" (2) || key ID (8) || Ed25519 public key (32).
function parsePublicKey(pubkeyB64) {
  const [, line] = minisignLines(pubkeyB64, "public key", 2);
  const bytes = payload(line, "public key payload", 42);
  if (bytes.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new SigError("public key algorithm is not Ed");
  }
  return {
    keyId: bytes.subarray(2, 10),
    key: crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, bytes.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  };
}

// Minisign signature, line 2: algorithm (2) || key ID (8) || signature (64), where
// "Ed" signs the raw file and "ED" signs its BLAKE2b-512 digest. Line 4 signs
// signature || trusted comment text, binding the comment to the file signature.
function parseSignature(sigFileText) {
  const lines = minisignLines(sigFileText, "signature", 4);
  const bytes = payload(lines[1], "signature payload", 74);
  if (!lines[2].startsWith(TRUSTED)) {
    throw new SigError("signature has no trusted comment line");
  }
  return {
    algorithm: bytes.subarray(0, 2).toString("latin1"),
    keyId: bytes.subarray(2, 10),
    signature: bytes.subarray(10),
    trustedComment: lines[2].slice(TRUSTED.length),
    globalSignature: payload(lines[3], "global signature", 64),
  };
}

export function checkSig(fileBytes, sigFileText, pubkeyB64) {
  try {
    const pub = parsePublicKey(pubkeyB64);
    const sig = parseSignature(sigFileText);
    if (!sig.keyId.equals(pub.keyId)) {
      return {
        ok: false,
        reason: `key ID mismatch: signature ${hexId(sig.keyId)}, public key ${hexId(pub.keyId)}`,
      };
    }
    let message;
    if (sig.algorithm === "ED") {
      message = crypto.createHash("blake2b512").update(fileBytes).digest();
    } else if (sig.algorithm === "Ed") {
      message = fileBytes;
    } else {
      return {
        ok: false,
        reason: `unknown signature algorithm ${JSON.stringify(sig.algorithm)}`,
      };
    }
    if (!crypto.verify(null, message, pub.key, sig.signature)) {
      return {
        ok: false,
        reason: `the ${sig.algorithm} file signature does not verify`,
      };
    }
    const globalMessage = Buffer.concat([
      sig.signature,
      Buffer.from(sig.trustedComment, "utf8"),
    ]);
    if (!crypto.verify(null, globalMessage, pub.key, sig.globalSignature)) {
      return {
        ok: false,
        reason: "the global signature over the trusted comment does not verify",
      };
    }
    return { ok: true, algorithm: sig.algorithm, keyId: hexId(pub.keyId) };
  } catch (error) {
    if (error instanceof SigError)
      return { ok: false, reason: `invalid input: ${error.message}` };
    throw error;
  }
}

const hexId = (keyId) =>
  Buffer.from(keyId).reverse().toString("hex").toUpperCase();

export function verifySig(fileBytes, sigFileText, pubkeyB64) {
  return checkSig(fileBytes, sigFileText, pubkeyB64).ok;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new Error(
      "usage: node fork/scripts/verify-sig.mjs <file> <sig> <pubfile>",
    );
  }
  const [file, sig, pub] = args;
  const result = checkSig(
    fs.readFileSync(file),
    fs.readFileSync(sig, "utf8"),
    fs.readFileSync(pub, "utf8"),
  );
  if (!result.ok) {
    console.error(`verify-sig: ${file}: ${result.reason}`);
    process.exit(1);
  }
  console.log(`verify-sig: ok (${result.algorithm}, key ${result.keyId})`);
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(`verify-sig: ${error.message}`);
    process.exit(1);
  }
}
