#!/usr/bin/env node
// Witness recent SatNOGS passes heard by several stations and write custody records.
//
//   node bin/run.mjs                       auto: best multi-station passes, last 6 h
//   node bin/run.mjs --norad 59112 --hours 12
//   node bin/run.mjs --min-stations 3 --max-passes 5
//
// Output: out/<runId>/ { receipts/, passes/, batch.json, proofs.json, REPORT.md }
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { genKeypair, exportKeypair, importKeypair } from "../lib/keys.mjs";
import { fetchObservations, fetchStation, fetchObservationFrames } from "../lib/satnogs.mjs";
import { groupPasses, buildStationReceipt, buildPassManifest, buildBatch, DATA_SOURCE } from "../lib/custody.mjs";

const DATA_LICENSE = `# Data credit and license

${DATA_SOURCE.attribution}

The station receipts, pass manifests and batch in this folder are derived from SatNOGS
Network data and are licensed under Creative Commons Attribution-ShareAlike 4.0
(${DATA_SOURCE.licenseUrl}). They contain frame hashes, timestamps, source links, station
IDs, station names and operator handles; no station coordinates and no frame contents.

${DATA_SOURCE.notice}

The Open Downlink Custody software itself is licensed separately under Apache-2.0.
`;
import { verifyReceipt, verifyManifest, verifyManifestInBatch } from "../lib/verify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function args(argv) {
  const a = { hours: 6, minStations: 2, maxPasses: 8, norad: null, maxPages: 20 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--hours") a.hours = Number(v), i++;
    else if (k === "--norad") a.norad = Number(v), i++;
    else if (k === "--min-stations") a.minStations = Number(v), i++;
    else if (k === "--max-passes") a.maxPasses = Number(v), i++;
    else if (k === "--max-pages") a.maxPages = Number(v), i++;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

async function loadKey() {
  const path = join(ROOT, ".keys", "custody.json");
  try {
    return importKeypair(JSON.parse(await readFile(path, "utf8")));
  } catch {
    const kp = genKeypair();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(exportKeypair(kp), null, 2));
    console.log(`created custody key ${path} (keep private; publish only the public key)`);
    return kp;
  }
}

const write = (path, obj) => writeFile(path, JSON.stringify(obj, null, 2) + "\n");

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help) {
    console.log("usage: node bin/run.mjs [--norad N] [--hours H] [--min-stations K] [--max-passes P]");
    return;
  }
  const kp = await loadKey();
  const until = new Date();
  const since = new Date(until.getTime() - a.hours * 3600e3);
  console.log(`fetching good observations ${since.toISOString()} .. ${until.toISOString()}${a.norad ? ` norad ${a.norad}` : ""}`);

  const obs = (await fetchObservations({ norad: a.norad, since, until, maxPages: a.maxPages }))
    .filter((o) => o.demoddata && o.demoddata.length);
  const passes = groupPasses(obs)
    .map((p) => ({ ...p, stations: new Set(p.observations.map((o) => o.ground_station)).size }))
    .filter((p) => p.stations >= a.minStations)
    .sort((x, y) => y.stations - x.stations || y.observations.length - x.observations.length)
    .slice(0, a.maxPasses);
  console.log(`${obs.length} observations with frames -> ${passes.length} passes heard by >= ${a.minStations} stations`);
  if (!passes.length) return console.log("nothing to witness; widen --hours or lower --min-stations");

  const runId = until.toISOString().replace(/[:.]/g, "-");
  const outDir = join(ROOT, "out", runId);
  await mkdir(join(outDir, "receipts"), { recursive: true });
  await mkdir(join(outDir, "passes"), { recursive: true });
  const cacheDir = join(ROOT, ".cache", "frames");

  const manifests = [];
  const allReceipts = [];
  for (const p of passes) {
    const witnessedAt = new Date().toISOString();
    const receipts = [];
    for (const o of p.observations) {
      const station = await fetchStation(o.ground_station);
      const frames = await fetchObservationFrames(o, cacheDir);
      const r = buildStationReceipt({ obs: o, station, frames, kp, witnessedAt });
      receipts.push(r);
      await write(join(outDir, "receipts", `${o.id}.json`), r);
    }
    const m = buildPassManifest({ norad: p.norad, window: { start: p.start, end: p.end }, receipts, kp, witnessedAt });
    manifests.push(m);
    allReceipts.push(...receipts);
    await write(join(outDir, "passes", `${p.norad}_${p.start.replace(/[:.]/g, "-")}.json`), m);
    console.log(
      `  NORAD ${p.norad} ${p.start.slice(11, 19)}Z  stations ${m.stationCount} (owners ${m.independentOwners})` +
        `  frames ${m.uniqueFrames}  corroborated ${m.corroboratedFrames}` +
        `  missed ${m.stations.reduce((s, x) => s + x.missedFrames, 0)}`,
    );
  }

  const { batch, proofs } = buildBatch({ manifests, kp, createdAt: new Date().toISOString() });
  await write(join(outDir, "batch.json"), batch);
  await write(join(outDir, "proofs.json"), proofs);
  await write(join(outDir, "custody-pubkey.json"), { signerPub: kp.pub });

  // Self-check: everything written must verify under the pinned custody key.
  const pin = { pinnedPub: kp.pub };
  let bad = 0;
  for (const r of allReceipts) if (!verifyReceipt(r, pin).ok) bad++;
  manifests.forEach((m, i) => {
    const rs = allReceipts.filter((r) => m.stations.some((s) => s.receiptId === r.claimId));
    if (!verifyManifest(m, rs, pin).ok) bad++;
    if (!verifyManifestInBatch(m.claimId, proofs[i], batch, pin).ok) bad++;
  });

  await writeFile(join(outDir, "REPORT.md"), report({ runId, since, until, manifests, batch, bad, a }));
  await writeFile(join(outDir, "DATA-LICENSE.md"), DATA_LICENSE);
  console.log(`\nbatch root ${batch.root}`);
  console.log(`self-check: ${bad === 0 ? "PASS (all receipts, manifests and proofs verify)" : `FAIL (${bad} records)`}`);
  console.log(`written: ${outDir}`);
  if (bad) process.exitCode = 1;
}

function report({ runId, since, until, manifests, batch, bad, a }) {
  const t = (k) => manifests.reduce((s, m) => s + m[k], 0);
  const stations = new Set(manifests.flatMap((m) => m.stations.map((s) => s.stationId)));
  const owners = new Set(manifests.flatMap((m) => m.stations.map((s) => s.owner || `station:${s.stationId}`)));
  const rows = manifests
    .map(
      (m) =>
        `| ${m.norad} | ${m.window.start.replace("T", " ").slice(0, 19)} | ${m.stationCount} | ${m.independentOwners} | ${m.uniqueFrames} | ${m.corroboratedFrames} | ${m.stations.reduce((s, x) => s + x.missedFrames, 0)} |`,
    )
    .join("\n");
  return `# Open Downlink Custody run ${runId}

Window: ${since.toISOString()} to ${until.toISOString()} (${a.hours} h)${a.norad ? `, NORAD ${a.norad}` : ""}
Data: SatNOGS Network contributors (https://network.satnogs.org), licensed CC BY-SA.
The records in this folder are derived from that data and are shared under CC BY-SA 4.0.
Open Downlink Custody is not affiliated with or endorsed by the Libre Space Foundation.

| Passes | Stations | Independent owners | Unique frames | Corroborated (2+ owners) |
|---|---|---|---|---|
| ${manifests.length} | ${stations.size} | ${owners.size} | ${t("uniqueFrames")} | ${t("corroboratedFrames")} |

| NORAD | Pass start (UTC) | Stations | Owners | Unique frames | Corroborated | Missed (gap records) |
|---|---|---|---|---|---|---|
${rows}

Batch root: \`${batch.root}\`
Batch id: \`${batch.claimId}\`
Self-check: ${bad === 0 ? "PASS" : `FAIL (${bad})`}

What this attests: each station receipt records every frame the public archive served
for that observation, content-addressed and signed by the custody agent. Stations do
not sign their own uploads today, so trust comes from corroboration: a frame received
byte-for-byte by stations with different owners. The batch root is the single value to
anchor on chain; anchoring is a separate, manual step.

Reading the numbers: satellites often send several frames per second and each station
decodes only some of them, so a low corroborated count usually means the stations caught
different frames, not that they disagree. "Missed" counts frames another station archived
inside a station's own window that it did not archive: a reception gap record, not a
custody failure.

Re-verify independently: \`node bin/verify.mjs --run out/${runId} --pub <custody public key>\`
(add \`--refetch\` to re-download every frame from SatNOGS and compare).
`;
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
