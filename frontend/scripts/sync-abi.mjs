/**
 * Copy the compiled PayWithQuai ABI out of the contracts workspace into the frontend.
 *
 *   npm run abi:sync        (from frontend/)
 *
 * The frontend imports this JSON directly (src/lib/paywithquai.abi.json). Copying it by hand is
 * how it silently drifted before: a new function existed on-chain while the frontend's copy was
 * one entry behind, and nothing failed until someone read a function the bundle could not encode.
 * This script fails loudly instead — if the artifact is missing or the write would change the file,
 * it says so and exits non-zero.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = resolve(
  here,
  "../../contracts/artifacts/contracts/PayWithQuai.sol/PayWithQuai.json",
);
const target = resolve(here, "../src/lib/paywithquai.abi.json");

let abi;
try {
  abi = JSON.parse(readFileSync(artifact, "utf8")).abi;
} catch {
  console.error(
    `[abi:sync] could not read the compiled artifact at ${artifact}.\n` +
      `            Run \`npm run compile\` in ../contracts first.`,
  );
  process.exit(1);
}

if (!Array.isArray(abi) || abi.length === 0) {
  console.error(`[abi:sync] ${artifact} has no usable "abi" array.`);
  process.exit(1);
}

const next = `${JSON.stringify(abi, null, 2)}\n`;
let current = null;
try {
  current = readFileSync(target, "utf8");
} catch {
  /* no existing file — treated as a create */
}

if (current === next) {
  const fns = abi.filter((e) => e.type === "function").length;
  console.log(`[abi:sync] already up to date (${abi.length} entries, ${fns} functions).`);
  process.exit(0);
}

writeFileSync(target, next);
const before = current ? JSON.parse(current).length : 0;
const fns = abi.filter((e) => e.type === "function").length;
console.log(
  `[abi:sync] wrote ${target} — ${before} -> ${abi.length} entries (${fns} functions).` +
    (abi.length < before ? "\n            WARNING: fewer entries than before; was the artifact rebuilt?" : ""),
);
