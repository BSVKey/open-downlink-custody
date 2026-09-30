// On-chain anchor for a custody batch root: an OP_FALSE OP_RETURN output carrying the
// tag "odc.custody-batch/1" and the 32-byte root. Only the hash is published, never data.
//
// Checking an anchor is zero-dependency and read-only (WhatsOnChain). Building one needs
// @bsv/sdk and a funded key, and lives in bin/anchor.mjs; nothing here ever broadcasts.

export const WOC = "https://api.whatsonchain.com/v1/bsv/main";
export const ANCHOR_TAG = "odc.custody-batch/1";
export const tagHex = Buffer.from(ANCHOR_TAG, "utf8").toString("hex");

const strip0x = (h) => String(h).replace(/^0x/i, "").toLowerCase();

// Does a WhatsOnChain tx JSON carry `root` in an OP_RETURN output? Pure, no network.
export function opReturnCarriesRoot(txJson, root) {
  const needle = strip0x(root);
  if (!/^[0-9a-f]{64}$/.test(needle)) return false;
  for (const o of txJson?.vout || []) {
    const spk = o.scriptPubKey || {};
    const hex = String(spk.hex || "").toLowerCase();
    const asm = String(spk.asm || "");
    const nulldata = spk.type === "nulldata" || /\bOP_RETURN\b/.test(asm) || /^(00)?6a/.test(hex);
    if (nulldata && `${hex} ${asm.toLowerCase()}`.includes(needle)) return true;
  }
  return false;
}

export async function verifyAnchorOnChain(txid, root, { wocBase = WOC } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(txid))) return { ok: false, reason: "bad_txid" };
  let j;
  try {
    const res = await fetch(`${wocBase}/tx/hash/${txid}`);
    if (!res.ok) return { ok: false, reason: `chain_read_http_${res.status}`, txid };
    j = await res.json();
  } catch (e) {
    return { ok: false, reason: `chain_read_failed: ${e.message}`, txid };
  }
  const ok = opReturnCarriesRoot(j, root);
  return {
    ok,
    txid,
    root: strip0x(root),
    confirmations: Number(j.confirmations) || 0,
    blocktime: j.blocktime ? new Date(j.blocktime * 1000).toISOString() : null,
    reason: ok ? undefined : "root_not_in_op_return",
  };
}
