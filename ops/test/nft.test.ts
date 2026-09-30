import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { merkleProof, merkleRoot, verifyProof } from "../src/nft/merkle.ts";
import { BACKDROPS, CHARMS, HEADWEAR, MASKS, PALETTES, WOODS, render, traitsOf } from "../src/nft/talArt.ts";

const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address;

test("every allowlisted wallet gets a proof that verifies, and nobody else does", () => {
  for (const n of [1, 2, 3, 7, 64, 101]) {
    const list = Array.from({ length: n }, (_, i) => addr(i + 1));
    const root = merkleRoot(list);
    for (const a of list) assert.ok(verifyProof(root, a, merkleProof(list, a)!), `${n}:${a}`);
    assert.equal(merkleProof(list, addr(9999)), null);
  }
});

test("the list's order and letter case do not change the root", () => {
  const list = [addr(3), addr(1), addr(2)];
  assert.equal(merkleRoot(list), merkleRoot([...list].reverse().map((a) => a.toUpperCase().replace("0X", "0x") as Address)));
});

test("Tal traits are deterministic and inside their tables", () => {
  const counts = new Map<number, number>();
  for (let id = 1n; id <= 400n; id++) {
    const t = traitsOf(12345n, id);
    assert.deepEqual(t, traitsOf(12345n, id));
    assert.ok(t.backdrop < BACKDROPS.length && t.palette < PALETTES.length && t.wood < WOODS.length);
    assert.ok(t.mask < MASKS.length && t.headwear < HEADWEAR.length && t.charm < CHARMS.length);
    counts.set(t.mask, (counts.get(t.mask) ?? 0) + 1);
    const svg = render(t);
    assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>") && !svg.includes("'"));
  }
  assert.equal(counts.size, MASKS.length, "400 masks should show every face");
});
