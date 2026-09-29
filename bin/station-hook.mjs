#!/usr/bin/env node
// Station-side signer: run by satnogs-client after each observation, BEFORE upload, so
// the station itself signs exactly what it decoded. This closes the gap the network-side
// witness cannot: a receipt signed by the station's own key at the source.
//
// satnogs-client setup (check the variable names against your client version):
//   SATNOGS_POST_OBSERVATION_SCRIPT="node /path/to/open-downlink-custody/bin/station-hook.mjs --id {{ID}}"
//
// Options:
//   --id N            observation id (required)
//   --data-dir DIR    where satnogs-client writes decoded frames (default /tmp/.satnogs/data)
//   --out DIR         where signed receipts are kept (default ~/.open-downlink-custody/receipts)
//   --key FILE        station signing key (default ~/.open-downlink-custody/station-key.json, created on first run)
//
// Receive-only and local: it reads files the client already wrote and writes a JSON
// receipt next to them. It never transmits, never modifies frames, never blocks upload
// (any error exits 0 with a message so the observation pipeline is unaffected).
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { genKeypair, exportKeypair, importKeypair } from "../lib/keys.mjs";
import { leafHash, buildTree } from "../lib/merkle.mjs";
import { signRecord, DATA_SOURCE } from "../lib/custody.mjs";
import { frameTimeFromUrl } from "../lib/satnogs.mjs";

export const STATION_SIGNED_TYPE = "odc.station-signed/1";

function args(argv) {
  const home = join(homedir(), ".open-downlink-custody");
  const a = { dataDir: "/tmp/.satnogs/data", out: join(home, "receipts"), key: join(home, "station-key.json") };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--id") a.id = String(v), i++;
    else if (k === "--data-dir") a.dataDir = v, i++;
    else if (k === "--out") a.out = v, i++;
    else if (k === "--key") a.key = v, i++;
  }
  return a;
}

async function loadOrCreateKey(path) {
  try {
    return importKeypair(JSON.parse(await readFile(path, "utf8")));
  } catch {
    const kp = genKeypair();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(exportKeypair(kp), null, 2), { mode: 0o600 });
    console.log(`[open-downlink-custody] created station key ${path}; public key: ${kp.pub}`);
    return kp;
  }
}

// Build the station-signed receipt from decoded frame files for one observation.
export async function signObservation({ id, dataDir, kp }) {
  const names = (await readdir(dataDir)).filter((n) => n.startsWith(`data_${id}_`)).sort();
  const frames = [];
  for (const n of names) {
    const bytes = await readFile(join(dataDir, n));
    frames.push({ i: frames.length, file: n, t: frameTimeFromUrl(n), len: bytes.length, leaf: leafHash(bytes) });
  }
  return signRecord(
    {
      type: STATION_SIGNED_TYPE,
      source: DATA_SOURCE,
      observationId: Number(id),
      signedAt: new Date().toISOString(),
      frameCount: frames.length,
      frames,
      framesRoot: frames.length ? buildTree(frames.map((f) => f.leaf)).root : null,
      attests: "frames decoded by this station for this observation, signed before upload",
    },
    kp,
  );
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.id || !/^\d+$/.test(a.id)) return console.log("[open-downlink-custody] --id <observation id> required; skipping");
  const kp = await loadOrCreateKey(a.key);
  const rec = await signObservation({ id: a.id, dataDir: a.dataDir, kp });
  await mkdir(a.out, { recursive: true });
  const path = join(a.out, `${a.id}.json`);
  await writeFile(path, JSON.stringify(rec, null, 2) + "\n");
  console.log(`[open-downlink-custody] obs ${a.id}: signed ${rec.frameCount} frames, root ${rec.framesRoot ?? "none"} -> ${path}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((e) => console.log(`[open-downlink-custody] skipped: ${e.message}`)); // never break the client
}
