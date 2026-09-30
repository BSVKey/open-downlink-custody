import test from "node:test";
import assert from "node:assert/strict";
import { opReturnCarriesRoot, tagHex } from "../lib/anchor.mjs";

const root = "76d34ef5fb0b2d410dff97d486bf7d0e12c8bccd63e832916fe11ed3cfb87135";
const push = (hex) => (hex.length / 2).toString(16).padStart(2, "0") + hex;
const anchorTx = (r) => ({
  vout: [
    { value: 0, scriptPubKey: { type: "nulldata", hex: "006a" + push(tagHex) + push(r) } },
    { value: 0.00001, scriptPubKey: { type: "pubkeyhash", hex: "76a914" + "11".repeat(20) + "88ac" } },
  ],
});

test("anchor: OP_RETURN carrying the root is found, with or without 0x", () => {
  assert.equal(opReturnCarriesRoot(anchorTx(root), root), true);
  assert.equal(opReturnCarriesRoot(anchorTx(root), "0x" + root.toUpperCase()), true);
});

test("anchor: a different root, a non-OP_RETURN output, or a bad root is rejected", () => {
  const other = "00".repeat(32);
  assert.equal(opReturnCarriesRoot(anchorTx(other), root), false);
  const p2pkhOnly = { vout: [{ scriptPubKey: { type: "pubkeyhash", hex: "76a914" + root.slice(0, 40) + "88ac" } }] };
  assert.equal(opReturnCarriesRoot(p2pkhOnly, root.slice(0, 40)), false);
  assert.equal(opReturnCarriesRoot(anchorTx(root), ""), false);
  assert.equal(opReturnCarriesRoot({}, root), false);
});
