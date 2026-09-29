// Offline tests: synthetic observations, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genKeypair } from "../lib/keys.mjs";
import { groupPasses, buildStationReceipt, buildPassManifest, buildBatch, corroborate } from "../lib/custody.mjs";
import { verifyReceipt, verifyManifest, verifyManifestInBatch, verifyFrameInReceipt } from "../lib/verify.mjs";
import { frameTimeFromUrl } from "../lib/satnogs.mjs";
import { signObservation } from "../bin/station-hook.mjs";
import { verifySigned } from "../lib/verify.mjs";

const kp = genKeypair();
const at = "2026-09-29T00:00:00.000Z";
const F = (s) => Buffer.from(s);

function obs(id, station, start, end, norad = 59112) {
  return { id, ground_station: station, norad_cat_id: norad, start, end, station_name: `S${station}`, demoddata: [{}] };
}
const station = (id, owner) => ({ id, name: `S${id}`, owner });

// Pass: A(owner a) hears f1 f2 f3, B(owner b) hears f2 f3, C(owner a, same owner as A) hears f3 f4.
const oA = obs(1, 10, "2026-09-29T03:00:00Z", "2026-09-29T03:10:00Z");
const oB = obs(2, 20, "2026-09-29T03:02:00Z", "2026-09-29T03:12:00Z");
const oC = obs(3, 30, "2026-09-29T03:05:00Z", "2026-09-29T03:15:00Z");
const fr = (t, s) => ({ t: `2026-09-29T03:${t}Z`, bytes: F(s), url: `u/${s}/${t}` });
const rA = buildStationReceipt({ obs: oA, station: station(10, "a"), frames: [fr("01:00", "f1"), fr("03:00", "f2"), fr("06:00", "f3")], kp, witnessedAt: at });
const rB = buildStationReceipt({ obs: oB, station: station(20, "b"), frames: [fr("03:01", "f2"), fr("06:00", "f3")], kp, witnessedAt: at });
const rC = buildStationReceipt({ obs: oC, station: station(30, "a"), frames: [fr("06:01", "f3"), fr("08:00", "f4")], kp, witnessedAt: at });

test("frame time is parsed from SatNOGS file names", () => {
  assert.equal(frameTimeFromUrl("https://x/data_15082870_2026-09-29T04-15-58"), "2026-09-29T04:15:58Z");
  assert.equal(frameTimeFromUrl("data_1_2026-09-29T04-17-03_0"), "2026-09-29T04:17:03Z");
  assert.equal(frameTimeFromUrl("nonsense"), null);
});

test("overlapping observations of one satellite form one pass; other satellites and gaps split", () => {
  const far = obs(4, 40, "2026-09-29T05:00:00Z", "2026-09-29T05:10:00Z");
  const other = obs(5, 50, "2026-09-29T03:01:00Z", "2026-09-29T03:09:00Z", 44530);
  const passes = groupPasses([oC, oA, far, oB, other]);
  const p = passes.find((x) => x.norad === 59112 && x.observations.length === 3);
  assert.ok(p);
  assert.equal(p.start, "2026-09-29T03:00:00.000Z");
  assert.equal(p.end, "2026-09-29T03:15:00.000Z");
  assert.equal(passes.length, 3);
});

test("receipts verify, bind every frame, and reject tampering", () => {
  assert.deepEqual(verifyReceipt(rA, { pinnedPub: kp.pub }), { ok: true });
  assert.equal(verifyFrameInReceipt(F("f2"), rA).ok, true);
  assert.equal(verifyFrameInReceipt(F("f9"), rA).reason, "frame_not_in_receipt");
  const t = structuredClone(rA);
  t.frames[0].leaf = t.frames[1].leaf;
  assert.equal(verifyReceipt(t).reason, "content_mismatch");
  assert.equal(verifyReceipt(rA, { pinnedPub: genKeypair().pub }).reason, "signer_not_pinned");
});

test("corroboration counts independent OWNERS, not stations", () => {
  const c = corroborate([rA, rB, rC]);
  assert.equal(c.uniqueFrames, 4);
  const byLeaf = Object.fromEntries(c.frames.map((f) => [f.seenBy.join(","), f.independentOwners]));
  assert.equal(byLeaf["1,2,3"], 2); // f3: A,B,C but A and C share an owner
  assert.equal(c.corroboratedFrames, 2); // f2 (a,b) and f3 (a,b)
  assert.equal(c.independentOwners, 2);
});

test("gap records: frames others archived inside a station's own window", () => {
  const c = corroborate([rA, rB, rC]);
  const st = Object.fromEntries(c.stations.map((s) => [s.observationId, s]));
  // Union first-seen: f1 03:01, f2 03:03, f3 03:06, f4 03:08.
  assert.equal(st[1].missedFrames, 1); // A (03:00-03:10) lacks f4
  assert.equal(st[2].missedFrames, 1); // B (03:02-03:12) lacks f4; f1 at 03:01 is outside B's window
  assert.equal(st[3].missedFrames, 0); // C (03:05-03:15) lacks f1, f2, but both precede its window
  assert.deepEqual(st[1].gaps, [{ from: "2026-09-29T03:08:00.000Z", to: "2026-09-29T03:08:00.000Z", frames: 1 }]);
});

test("manifest verifies against its receipts and catches a swapped receipt", () => {
  const m = buildPassManifest({ norad: 59112, window: { start: oA.start, end: oC.end }, receipts: [rA, rB, rC], kp, witnessedAt: at });
  assert.deepEqual(verifyManifest(m, [rA, rB, rC], { pinnedPub: kp.pub }), { ok: true });
  assert.match(verifyManifest(m, [rA, rC], {}).reason, /^missing_receipt/);
  const forged = buildStationReceipt({ obs: oB, station: station(20, "b"), frames: [fr("03:01", "f2")], kp, witnessedAt: at });
  const m2 = structuredClone(m);
  m2.stations[1].receiptId = forged.claimId;
  assert.equal(verifyManifest(m2, [rA, forged, rC], {}).reason, "content_mismatch");
});

test("batch root commits to every manifest; proofs are position-bound", () => {
  const m1 = buildPassManifest({ norad: 59112, window: { start: oA.start, end: oB.end }, receipts: [rA, rB], kp, witnessedAt: at });
  const m2 = buildPassManifest({ norad: 59112, window: { start: oC.start, end: oC.end }, receipts: [rC], kp, witnessedAt: at });
  const m3 = buildPassManifest({ norad: 59112, window: { start: oA.start, end: oC.end }, receipts: [rA, rB, rC], kp, witnessedAt: at });
  const { batch, proofs } = buildBatch({ manifests: [m1, m2, m3], kp, createdAt: at });
  for (const [i, m] of [m1, m2, m3].entries()) {
    assert.deepEqual(verifyManifestInBatch(m.claimId, proofs[i], batch, { pinnedPub: kp.pub }), { ok: true });
  }
  assert.equal(verifyManifestInBatch(m1.claimId, { ...proofs[0], index: 1 }, batch).ok, false);
  assert.equal(verifyManifestInBatch(m2.claimId, proofs[0], batch).reason, "proof_invalid");
});

test("station hook signs exactly the decoded files for one observation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "satnogs-"));
  await writeFile(join(dir, "data_77_2026-09-29T04-15-58"), F("x1"));
  await writeFile(join(dir, "data_77_2026-09-29T04-16-03_0"), F("x2"));
  await writeFile(join(dir, "data_78_2026-09-29T04-16-03"), F("other obs"));
  const skp = genKeypair();
  const rec = await signObservation({ id: "77", dataDir: dir, kp: skp });
  assert.equal(rec.frameCount, 2);
  assert.equal(rec.frames[0].t, "2026-09-29T04:15:58Z");
  assert.deepEqual(verifySigned(rec, { pinnedPub: skp.pub }), { ok: true });
});

test("records carry the data credit and never station coordinates or hostnames", async () => {
  const withCoords = { ...oA, station_lat: 37.98, station_lng: 23.72 };
  const r = buildStationReceipt({ obs: withCoords, station: { id: 10, name: "S10", owner: "a", lat: 1, lng: 2 }, frames: [fr("01:00", "f1")], kp, witnessedAt: at });
  const json = JSON.stringify(r);
  assert.ok(!/"lat"|"lng"|37\.98|23\.72/.test(json));
  assert.equal(r.source.license, "CC BY-SA");
  assert.match(r.source.notice, /not affiliated with or endorsed by the Libre Space Foundation/);
  const m = buildPassManifest({ norad: 59112, window: { start: oA.start, end: oA.end }, receipts: [r], kp, witnessedAt: at });
  assert.equal(m.source.network, "network.satnogs.org");
  const dir = await mkdtemp(join(tmpdir(), "odc-"));
  await writeFile(join(dir, "data_9_2026-09-29T04-15-58"), F("x"));
  const s = await signObservation({ id: "9", dataDir: dir, kp: genKeypair() });
  assert.equal(s.host, undefined);
  assert.equal(s.source.license, "CC BY-SA");
});
