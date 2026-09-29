// Read-only client for the public SatNOGS Network API (network.satnogs.org).
// No account or token is needed: observations, stations and demodulated frames are
// public (CC BY-SA). Frames are cached on disk so a run can be re-verified offline.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const NETWORK = "https://network.satnogs.org";
const UA = "open-downlink-custody/0.1 (read-only; custody receipts over public SatNOGS data)";

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": UA } });
    if (res.ok) return { body: await res.json(), link: res.headers.get("link") || "" };
    if (i >= tries || (res.status < 500 && res.status !== 429)) {
      throw new Error(`GET ${url} -> HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 1500 * i));
  }
}

const nextLink = (link) => (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null;

// Observations for one satellite whose window overlaps [since, until]. The API lists
// newest first; `end=` bounds the top, and we page back until windows end before `since`.
export async function fetchObservations({ norad, since, until, status = "good", maxPages = 20 }) {
  const params = new URLSearchParams({ format: "json", status, end: until.toISOString() });
  if (norad) params.set("norad_cat_id", String(norad));
  let url = `${NETWORK}/api/observations/?${params}`;
  const out = [];
  for (let page = 0; url && page < maxPages; page++) {
    const { body, link } = await getJson(url);
    if (!Array.isArray(body)) throw new Error(`unexpected observations payload from ${url}`);
    let older = false;
    for (const o of body) {
      if (new Date(o.end) < since) { older = true; continue; }
      if (new Date(o.start) <= until) out.push(o);
    }
    if (older) break;
    url = nextLink(link);
  }
  return out;
}

const stationCache = new Map();
export async function fetchStation(id) {
  if (stationCache.has(id)) return stationCache.get(id);
  const { body } = await getJson(`${NETWORK}/api/stations/?id=${id}&format=json`);
  const s = Array.isArray(body) && body[0] ? body[0] : null;
  const info = s ? { id: s.id, name: s.name, owner: s.owner } : { id, name: null, owner: null }; // no coordinates: stations are often private homes
  stationCache.set(id, info);
  return info;
}

// Frame files are named data_<obsId>_<YYYY-MM-DDTHH-MM-SS>[_n]; the timestamp is the
// station's receive time (station clock, UTC).
export function frameTimeFromUrl(url) {
  const m = String(url).match(/data_\d+_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null;
}

export async function fetchFrame(url, cacheDir) {
  const key = createHash("sha256").update(url).digest("hex").slice(0, 32);
  const path = cacheDir ? join(cacheDir, key) : null;
  if (path) {
    try { return await readFile(path); } catch { /* not cached yet */ }
  }
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (path) {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(path, bytes);
      }
      return bytes;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw new Error(`frame ${url}: ${lastErr.message}`);
}

// Download every demodulated frame of an observation, oldest first.
export async function fetchObservationFrames(obs, cacheDir, concurrency = 4) {
  const urls = (obs.demoddata || []).map((d) => d.payload_demod).filter(Boolean);
  const results = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      const bytes = await fetchFrame(urls[i], cacheDir);
      results[i] = { url: urls[i], t: frameTimeFromUrl(urls[i]), bytes };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results.sort((a, b) => (a.t || "").localeCompare(b.t || "") || a.url.localeCompare(b.url));
}
