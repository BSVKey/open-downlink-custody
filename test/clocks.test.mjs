import { test } from "node:test";
import assert from "node:assert/strict";
import { compareClocks } from "../lib/clocks.mjs";

const at = (s) => new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + s * 1000).toISOString().replace(".000", "");
const rec = (id, frames) => ({ station: { id, name: `st${id}` }, frames: frames.map(([leaf, s]) => ({ leaf, t: at(s) })) });

test("a station running 5 s fast is found; agreeing stations sit at zero", () => {
  const r = compareClocks([
    rec(1, [["a", 0], ["b", 30], ["c", 60]]),
    rec(2, [["a", 0], ["b", 30], ["c", 61]]),
    rec(3, [["a", 5], ["b", 35], ["c", 65]]),
  ]);
  assert.equal(r.transmissions, 3);
  const s3 = r.stations.find((s) => s.id === 3);
  assert.equal(s3.medianOffset, 5);
  assert.equal(s3.flagged, true);
  assert.equal(r.stations.find((s) => s.id === 1).medianOffset, 0);
});

test("a beacon repeated minutes later is split into separate transmissions", () => {
  const r = compareClocks([
    rec(1, [["beacon", 0], ["beacon", 300]]),
    rec(2, [["beacon", 0], ["beacon", 300]]),
    rec(3, [["beacon", 0], ["beacon", 300]]),
  ]);
  // Two transmissions (t=0 and t=300, each heard by all three), not one smeared across
  // five minutes: every offset stays at zero.
  assert.equal(r.transmissions, 2);
  assert.ok(r.stations.every((s) => s.medianOffset === 0 && s.min === 0 && s.max === 0));
});

test("the same station twice inside one window is ambiguous and skipped", () => {
  const r = compareClocks([rec(1, [["x", 0], ["x", 4]]), rec(2, [["x", 2]]), rec(3, [["x", 2]])]);
  assert.equal(r.transmissions, 0);
  assert.equal(r.skipped.ambiguous, 1);
});

test("a transmission heard by only two stations is not used (no third to break the tie)", () => {
  const r = compareClocks([rec(1, [["p", 0]]), rec(2, [["p", 7]])]);
  assert.equal(r.transmissions, 0);
  assert.equal(r.skipped.singleStation, 1);
});

test("frames heard by one station only are not used", () => {
  const r = compareClocks([rec(1, [["only", 0]]), rec(2, [["other", 0]])]);
  assert.equal(r.transmissions, 0);
  assert.deepEqual(r.stations, []);
});
