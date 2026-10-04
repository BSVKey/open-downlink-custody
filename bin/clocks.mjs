#!/usr/bin/env node
// Compare station clocks using frames that several stations decoded byte for byte.
//
//   node bin/clocks.mjs --run runs/<dir> [--run runs/<dir2> ...] [--gap 10] [--json]
//
// Reads the signed station receipts of one or more runs (verify them first with
// bin/verify.mjs if they came from someone else) and prints each station's offset
// from the consensus of the other stations that heard the same transmissions.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareClocks } from "../lib/clocks.mjs";

const argv = process.argv.slice(2);
const runs = [];
let gap = 10, json = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--run") runs.push(argv[++i]);
  else if (argv[i] === "--gap") gap = Number(argv[++i]);
  else if (argv[i] === "--json") json = true;
}
if (!runs.length) {
  console.error("usage: node bin/clocks.mjs --run runs/<dir> [--run ...] [--gap 10] [--json]");
  process.exit(64);
}

const receipts = [];
for (const run of runs) {
  const dir = join(run, "receipts");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    receipts.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
  }
}
const r = compareClocks(receipts, { gap });

if (json) {
  console.log(JSON.stringify({ runs, receipts: receipts.length, ...r }, null, 2));
} else {
  const fmt = (x) => (x > 0 ? "+" : "") + x.toFixed(1);
  console.log(`receipts ${receipts.length}, shared transmissions used ${r.transmissions}`);
  console.log(`skipped: heard by fewer than 3 stations ${r.skipped.singleStation}, ambiguous repeats ${r.skipped.ambiguous}`);
  console.log("");
  console.log("station  frames  median offset (s)  range (s)       name");
  for (const s of r.stations) {
    console.log(
      `${String(s.id).padEnd(8)} ${String(s.n).padStart(6)}  ${fmt(s.medianOffset).padStart(17)}  ${(fmt(s.min) + " .. " + fmt(s.max)).padEnd(14)}  ${s.name || ""}${s.flagged ? "   <- check clock" : ""}`,
    );
  }
  console.log("\nEach offset is against the median of the other stations on the same transmissions (3+ stations each). SatNOGS frame times are whole seconds, so +/-1 s is within resolution.");
}
