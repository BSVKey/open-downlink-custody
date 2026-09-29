// Independent verification of custody records. Every check returns { ok, reason }.
import { contentId } from "./canonical.mjs";
import { leafHash, buildTree, verifyProof } from "./merkle.mjs";
import { verifySig } from "./keys.mjs";
import { RECEIPT_TYPE, MANIFEST_TYPE, BATCH_TYPE } from "./custody.mjs";

const fail = (reason) => ({ ok: false, reason });
const OK = { ok: true };

// Content address, signature, and (optionally) a pinned signer key. Pinning is how a
// verifier refuses records signed by anyone but the custody agent it trusts.
export function verifySigned(rec, { pinnedPub } = {}) {
  if (!rec || typeof rec !== "object") return fail("not_a_record");
  if (contentId(rec) !== rec.claimId) return fail("content_mismatch");
  if (pinnedPub !== undefined && rec.signerPub !== pinnedPub) return fail("signer_not_pinned");
  if (!verifySig(rec.signerPub, rec.claimId, rec.sig)) return fail("signature_invalid");
  return OK;
}

export function verifyReceipt(r, opts) {
  if (r?.type !== RECEIPT_TYPE) return fail("wrong_type");
  const s = verifySigned(r, opts);
  if (!s.ok) return s;
  if (r.frameCount !== r.frames.length) return fail("frame_count_mismatch");
  const root = r.frames.length ? buildTree(r.frames.map((f) => f.leaf)).root : null;
  if (root !== r.framesRoot) return fail("frames_root_mismatch");
  return OK;
}

// Is this exact frame (raw bytes as downloaded) one the station receipt covers?
export function verifyFrameInReceipt(bytes, r) {
  const leaf = leafHash(bytes);
  const hit = r.frames.find((f) => f.leaf === leaf);
  if (!hit) return fail("frame_not_in_receipt");
  if (hit.len !== bytes.length) return fail("length_mismatch");
  return { ok: true, index: hit.i, t: hit.t };
}

export function verifyManifest(m, receipts, opts) {
  if (m?.type !== MANIFEST_TYPE) return fail("wrong_type");
  const s = verifySigned(m, opts);
  if (!s.ok) return s;
  const root = m.frames.length ? buildTree(m.frames.map((f) => f.leaf)).root : null;
  if (root !== m.framesRoot) return fail("frames_root_mismatch");
  if (receipts) {
    const byId = new Map(receipts.map((r) => [r.claimId, r]));
    for (const st of m.stations) {
      const r = byId.get(st.receiptId);
      if (!r) return fail(`missing_receipt:${st.observationId}`);
      const rv = verifyReceipt(r, opts);
      if (!rv.ok) return fail(`receipt_${st.observationId}_${rv.reason}`);
      const leaves = new Set(r.frames.map((f) => f.leaf));
      for (const f of m.frames) {
        if (f.seenBy.includes(r.observationId) !== leaves.has(f.leaf)) {
          return fail(`seenBy_mismatch:${st.observationId}`);
        }
      }
    }
  }
  return OK;
}

export function verifyManifestInBatch(manifestId, p, batch, opts) {
  if (batch?.type !== BATCH_TYPE) return fail("wrong_type");
  const s = verifySigned(batch, opts);
  if (!s.ok) return s;
  const leaf = leafHash(Buffer.from(manifestId.replace(/^0x/, ""), "hex"));
  if (!verifyProof(leaf, p.branch, p.index, batch.root)) return fail("proof_invalid");
  if (batch.passes[p.index]?.manifestId !== manifestId) return fail("index_mismatch");
  return OK;
}
