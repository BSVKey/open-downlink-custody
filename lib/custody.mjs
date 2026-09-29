// Open Downlink Custody: custody records over real SatNOGS downlinks. Pure functions,
// no network. Not affiliated with or endorsed by the Libre Space Foundation.
//
//   station receipt  one observation: every frame the station archived, content-addressed
//                    (Merkle leaf per frame, framesRoot over them), signed by the custody
//                    agent that witnessed the public archive.
//   pass manifest    every station that heard the same pass: the union of unique frames,
//                    how many independent stations/owners corroborate each frame, and a
//                    gap record per station for frames it missed inside its own window.
//   custody batch    Merkle root over pass manifests: the one value to anchor on chain.
//
// Honest boundary: SatNOGS stations do not sign their uploads today, so a receipt
// attests "this is what the public archive served for this station at witnessedAt",
// not "the station signed this". Corroboration by independently owned stations is
// what makes a frame credible; the station-side signer (bin/station-hook.mjs) closes
// the remaining gap for stations that opt in.
import { contentId } from "./canonical.mjs";
import { leafHash, buildTree, proof } from "./merkle.mjs";
import { signClaim } from "./keys.mjs";

// Carried inside every record so the credit and license travel with the data.
export const DATA_SOURCE = Object.freeze({
  network: "network.satnogs.org",
  attribution: "Data: SatNOGS Network contributors (https://network.satnogs.org)",
  license: "CC BY-SA",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  notice: "Open Downlink Custody is not affiliated with or endorsed by the Libre Space Foundation.",
});

export const RECEIPT_TYPE = "odc.station-receipt/1";
export const MANIFEST_TYPE = "odc.pass-manifest/1";
export const BATCH_TYPE = "odc.custody-batch/1";

// Missed-frame check tolerance for station clock skew and window rounding.
const WINDOW_SLACK_MS = 5000;
// Missed frames closer together than this form one gap interval.
const GAP_JOIN_MS = 60000;

export function signRecord(obj, kp) {
  const claimId = contentId(obj);
  return { ...obj, claimId, sig: signClaim(kp.priv, claimId), signerPub: kp.pub };
}

const ms = (iso) => new Date(iso).getTime();

// Cluster observations of the same satellite whose windows overlap into passes.
export function groupPasses(observations) {
  const bySat = new Map();
  for (const o of observations) {
    if (!bySat.has(o.norad_cat_id)) bySat.set(o.norad_cat_id, []);
    bySat.get(o.norad_cat_id).push(o);
  }
  const passes = [];
  for (const [norad, obs] of bySat) {
    obs.sort((a, b) => ms(a.start) - ms(b.start) || a.id - b.id);
    let cur = null;
    for (const o of obs) {
      if (cur && ms(o.start) <= cur.endMs) {
        cur.observations.push(o);
        cur.endMs = Math.max(cur.endMs, ms(o.end));
      } else {
        cur = { norad, startMs: ms(o.start), endMs: ms(o.end), observations: [o] };
        passes.push(cur);
      }
    }
  }
  return passes.map((p) => ({
    norad: p.norad,
    start: new Date(p.startMs).toISOString(),
    end: new Date(p.endMs).toISOString(),
    observations: p.observations,
  }));
}

export function buildStationReceipt({ obs, station, frames, kp, witnessedAt }) {
  const entries = frames.map((f, i) => ({ i, t: f.t, len: f.bytes.length, leaf: leafHash(f.bytes), src: f.url ?? null }));
  const framesRoot = entries.length ? buildTree(entries.map((e) => e.leaf)).root : null;
  return signRecord(
    {
      type: RECEIPT_TYPE,
      source: DATA_SOURCE,
      observationId: obs.id,
      norad: obs.norad_cat_id,
      transmitter: obs.transmitter_uuid || obs.transmitter || null,
      mode: obs.transmitter_mode || null,
      window: { start: obs.start, end: obs.end },
      station: {
        id: obs.ground_station,
        name: station?.name ?? obs.station_name ?? null,
        owner: station?.owner ?? null,
      },
      frameCount: entries.length,
      frames: entries,
      framesRoot,
      witnessedAt,
      attests: "frames served by the public SatNOGS archive for this observation at witnessedAt; station did not sign",
    },
    kp,
  );
}

function gapIntervals(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const out = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && t - last.endMs <= GAP_JOIN_MS) {
      last.endMs = t;
      last.frames++;
    } else out.push({ startMs: t, endMs: t, frames: 1 });
  }
  return out.map((g) => ({ from: new Date(g.startMs).toISOString(), to: new Date(g.endMs).toISOString(), frames: g.frames }));
}

// Cross-station view of one pass. `receipts` are station receipts for the same pass.
export function corroborate(receipts) {
  const union = new Map(); // leaf -> { leaf, firstSeen, seenBy:Set(obsId), owners:Set }
  for (const r of receipts) {
    const owner = r.station.owner || `station:${r.station.id}`;
    for (const f of r.frames) {
      let u = union.get(f.leaf);
      if (!u) union.set(f.leaf, (u = { leaf: f.leaf, firstSeen: f.t, seenBy: new Set(), owners: new Set() }));
      if (f.t && (!u.firstSeen || f.t < u.firstSeen)) u.firstSeen = f.t;
      u.seenBy.add(r.observationId);
      u.owners.add(owner);
    }
  }
  const frames = [...union.values()]
    .sort((a, b) => (a.firstSeen || "").localeCompare(b.firstSeen || "") || a.leaf.localeCompare(b.leaf))
    .map((u) => ({
      leaf: u.leaf,
      firstSeen: u.firstSeen,
      seenBy: [...u.seenBy].sort((a, b) => a - b),
      independentOwners: u.owners.size,
    }));

  const stations = receipts.map((r) => {
    const have = new Set(r.frames.map((f) => f.leaf));
    const lo = ms(r.window.start) - WINDOW_SLACK_MS;
    const hi = ms(r.window.end) + WINDOW_SLACK_MS;
    const missedTimes = frames
      .filter((f) => !have.has(f.leaf) && f.firstSeen && ms(f.firstSeen) >= lo && ms(f.firstSeen) <= hi)
      .map((f) => ms(f.firstSeen));
    return {
      observationId: r.observationId,
      stationId: r.station.id,
      stationName: r.station.name,
      owner: r.station.owner,
      receiptId: r.claimId,
      frameCount: r.frameCount,
      uniqueFrames: have.size,
      missedFrames: missedTimes.length,
      gaps: gapIntervals(missedTimes),
    };
  });

  const owners = new Set(receipts.map((r) => r.station.owner || `station:${r.station.id}`));
  return {
    frames,
    stations,
    uniqueFrames: frames.length,
    corroboratedFrames: frames.filter((f) => f.independentOwners >= 2).length,
    independentOwners: owners.size,
  };
}

export function buildPassManifest({ norad, window, receipts, kp, witnessedAt }) {
  const c = corroborate(receipts);
  const framesRoot = c.frames.length ? buildTree(c.frames.map((f) => f.leaf)).root : null;
  return signRecord(
    {
      type: MANIFEST_TYPE,
      source: DATA_SOURCE,
      norad,
      window,
      stationCount: receipts.length,
      independentOwners: c.independentOwners,
      uniqueFrames: c.uniqueFrames,
      corroboratedFrames: c.corroboratedFrames,
      stations: c.stations,
      frames: c.frames,
      framesRoot,
      witnessedAt,
    },
    kp,
  );
}

// One root over many pass manifests; each manifest gets an inclusion proof.
export function buildBatch({ manifests, kp, createdAt }) {
  const leaves = manifests.map((m) => leafHash(Buffer.from(m.claimId.replace(/^0x/, ""), "hex")));
  const tree = buildTree(leaves);
  const batch = signRecord(
    {
      type: BATCH_TYPE,
      source: DATA_SOURCE,
      createdAt,
      passes: manifests.map((m, i) => ({ index: i, manifestId: m.claimId, norad: m.norad, window: m.window })),
      root: tree.root,
    },
    kp,
  );
  const proofs = manifests.map((m, i) => ({ manifestId: m.claimId, index: i, branch: proof(tree, i) }));
  return { batch, proofs };
}
