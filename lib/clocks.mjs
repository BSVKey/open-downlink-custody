// Station clock comparison from corroborated frames.
//
// When stations with different owners decode the same frame byte for byte, they heard
// the same transmission. Their receive times should then agree to within propagation
// differences (milliseconds) plus timestamp resolution (SatNOGS frame times are whole
// seconds). A station whose times sit consistently away from the others has a clock
// offset. This needs no satellite clock and no extra hardware: only receipts.
//
// Repeated beacons: many satellites send the same bytes again minutes later. The same
// leaf hash can therefore be several transmissions. Occurrences of one leaf are split
// into "transmissions" wherever consecutive times are more than `gap` seconds apart,
// and a transmission is used only if each station appears in it at most once and at
// least `minStations` distinct stations do. Anything ambiguous is skipped and counted.
//
// Offsets are solved jointly, not per transmission: each station's offset is the median,
// over all its transmissions, of (its time minus that transmission's consensus), and each
// consensus is the median of the stations' times after removing their current offsets.
// Repeating this a few times lets one wrong clock be pinned on that station instead of
// leaking into everyone it shared a transmission with. Offsets are finally centred so
// the median station sits at zero.

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// receipts: odc.station-receipt/1 records ({ station, frames: [{ t, leaf }] }).
// Returns { transmissions, skipped, stations: [{ id, name, n, medianOffset, min, max, flagged }] }
export function compareClocks(receipts, { gap = 10, minStations = 3, flagAt = 2 } = {}) {
  const byLeaf = new Map();
  const names = new Map();
  for (const r of receipts) {
    const id = r.station && typeof r.station === "object" ? r.station.id : r.station;
    if (r.station && typeof r.station === "object" && r.station.name) names.set(id, r.station.name);
    for (const f of r.frames || []) {
      const t = Date.parse(f.t);
      if (!Number.isFinite(t) || !f.leaf) continue;
      if (!byLeaf.has(f.leaf)) byLeaf.set(f.leaf, []);
      byLeaf.get(f.leaf).push({ id, t: t / 1000 });
    }
  }

  const used = [];
  let transmissions = 0;
  const skipped = { singleStation: 0, ambiguous: 0 };
  for (const occ of byLeaf.values()) {
    occ.sort((a, b) => a.t - b.t);
    const groups = [];
    for (const o of occ) {
      const g = groups[groups.length - 1];
      if (g && o.t - g[g.length - 1].t <= gap) g.push(o);
      else groups.push([o]);
    }
    for (const g of groups) {
      const ids = g.map((o) => o.id);
      const distinct = new Set(ids);
      if (distinct.size < minStations) { skipped.singleStation++; continue; }
      if (distinct.size !== ids.length) { skipped.ambiguous++; continue; }
      transmissions++;
      used.push(g);
    }
  }

  const ids = [...new Set(used.flatMap((g) => g.map((o) => o.id)))];
  let off = new Map(ids.map((id) => [id, 0]));
  let resid = new Map();
  for (let iter = 0; iter < 20; iter++) {
    resid = new Map(ids.map((id) => [id, []]));
    for (const g of used) {
      const c = median(g.map((o) => o.t - off.get(o.id)));
      for (const o of g) resid.get(o.id).push(o.t - c);
    }
    const next = new Map(ids.map((id) => [id, median(resid.get(id))]));
    const centre = median([...next.values()]);
    for (const id of ids) next.set(id, next.get(id) - centre);
    const moved = Math.max(0, ...ids.map((id) => Math.abs(next.get(id) - off.get(id))));
    off = next;
    if (moved < 1e-9) break;
  }
  const centre = median([...off.values()]);
  const offsets = new Map(ids.map((id) => [id, resid.get(id).map((x) => x - centre)]));

  const stations = [...offsets].map(([id, xs]) => {
    const med = off.get(id);
    return {
      id, name: names.get(id) || null, n: xs.length,
      medianOffset: med, min: Math.min(...xs), max: Math.max(...xs),
      flagged: xs.length >= 3 && Math.abs(med) >= flagAt,
    };
  }).sort((a, b) => Math.abs(b.medianOffset) - Math.abs(a.medianOffset) || b.n - a.n);

  return { transmissions, skipped, stations };
}
