#!/usr/bin/env node
// Verify a custody run from disk, with no trust in the machine that produced it.
//
//   node bin/verify.mjs --run out/<runId> --pub <base64 key>     records + proofs
//   node bin/verify.mjs --run out/<runId> --pub <key> --refetch  also re-download frames
//   node bin/verify.mjs --run out/<runId> --pub <key> --anchor <txid>  also check the on-chain anchor
//   node bin/verify.mjs --frame f.bin --receipt out/<runId>/receipts/<obsId>.json
//
// --pub pins the custody agent's public key. Without it the key is read from the run
// folder, which proves internal consistency only (say so, don't pretend otherwise).
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchFrame } from "../lib/satnogs.mjs";
import { leafHash } from "../lib/merkle.mjs";
import { verifyAnchorOnChain } from "../lib/anchor.mjs";
import { verifyReceipt, verifyManifest, verifyManifestInBatch, verifyFrameInReceipt } from "../lib/verify.mjs";

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--refetch") a.refetch = true;
    else if (k.startsWith("--")) a[k.slice(2)] = argv[++i];
  }
  return a;
}
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

async function verifyRun(a) {
  const dir = a.run;
  let pinnedPub = a.pub;
  if (!pinnedPub) {
    pinnedPub = (await readJson(join(dir, "custody-pubkey.json"))).signerPub;
    console.log("note: no --pub given; pinning the key stored in the run folder (internal consistency only)");
  }
  const opts = { pinnedPub };
  const receipts = await Promise.all(
    (await readdir(join(dir, "receipts"))).map((f) => readJson(join(dir, "receipts", f))),
  );
  const manifestFiles = await readdir(join(dir, "passes"));
  const manifests = await Promise.all(manifestFiles.map((f) => readJson(join(dir, "passes", f))));
  const batch = await readJson(join(dir, "batch.json"));
  const proofs = await readJson(join(dir, "proofs.json"));

  let fails = 0;
  const report = (label, r) => {
    if (!r.ok) {
      fails++;
      console.log(`  FAIL ${label}: ${r.reason}`);
    }
  };
  for (const r of receipts) report(`receipt ${r.observationId}`, verifyReceipt(r, opts));
  for (const m of manifests) {
    report(`manifest ${m.norad} ${m.window.start}`, verifyManifest(m, receipts, opts));
    const p = proofs.find((x) => x.manifestId === m.claimId);
    report(`batch inclusion ${m.norad}`, p ? verifyManifestInBatch(m.claimId, p, batch, opts) : { ok: false, reason: "no_proof" });
  }
  console.log(`records: ${receipts.length} receipts, ${manifests.length} pass manifests, batch root ${batch.root}`);

  if (a.refetch) {
    let n = 0, changed = 0, gone = 0;
    for (const r of receipts) {
      for (const f of r.frames) {
        if (!f.src) continue;
        n++;
        try {
          const bytes = await fetchFrame(f.src, null);
          if (leafHash(bytes) !== f.leaf) {
            changed++;
            console.log(`  CHANGED obs ${r.observationId} frame ${f.i} ${f.src}`);
          }
        } catch {
          gone++;
        }
      }
    }
    console.log(`refetch: ${n} frames re-downloaded from SatNOGS, ${changed} changed, ${gone} unreachable`);
    fails += changed;
  }
  if (a.anchor) {
    const v = await verifyAnchorOnChain(a.anchor, batch.root);
    console.log(
      v.ok
        ? `anchor: batch root is in an OP_RETURN of BSV tx ${v.txid} (${v.confirmations} confirmations${v.blocktime ? `, block time ${v.blocktime}` : ""})`
        : `  FAIL anchor ${a.anchor}: ${v.reason}`,
    );
    if (!v.ok) fails++;
  }
  console.log(fails === 0 ? "VERIFY: PASS" : `VERIFY: FAIL (${fails})`);
  if (fails) process.exitCode = 1;
}

async function verifyOneFrame(a) {
  const bytes = await readFile(a.frame);
  const receipt = await readJson(a.receipt);
  const rv = verifyReceipt(receipt, a.pub ? { pinnedPub: a.pub } : {});
  if (!rv.ok) {
    console.log(`receipt invalid: ${rv.reason}`);
    process.exitCode = 1;
    return;
  }
  const fv = verifyFrameInReceipt(bytes, receipt);
  console.log(
    fv.ok
      ? `PASS: frame is #${fv.index} (received ${fv.t}) of observation ${receipt.observationId}, station ${receipt.station.name}`
      : `FAIL: ${fv.reason}`,
  );
  if (!fv.ok) process.exitCode = 1;
}

const a = args(process.argv.slice(2));
if (a.run) await verifyRun(a);
else if (a.frame && a.receipt) await verifyOneFrame(a);
else console.log("usage: node bin/verify.mjs --run out/<runId> [--pub KEY] [--refetch] [--anchor TXID] | --frame F --receipt R [--pub KEY]");
