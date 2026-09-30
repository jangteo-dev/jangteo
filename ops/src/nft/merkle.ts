import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/**
 * Allowlist Merkle trees, verified on-chain by OpenZeppelin's MerkleProof (sorted pairs).
 * A leaf is keccak256(keccak256(abi.encode(address))): the double hash keeps a leaf from ever
 * looking like an inner node. Leaves are sorted, and an odd node moves up a level unchanged.
 */
export const leafOf = (a: Address): Hex => keccak256(keccak256(encodeAbiParameters([{ type: "address" }], [a])));
const pair = (a: Hex, b: Hex): Hex => keccak256((a < b ? a + b.slice(2) : b + a.slice(2)) as Hex);

function layers(addresses: Address[]): Hex[][] {
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase() as Address))];
  let level = uniq.map(leafOf).sort();
  const out = [level];
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
    out.push((level = next));
  }
  return out;
}

export function merkleRoot(addresses: Address[]): Hex {
  if (addresses.length === 0) return `0x${"0".repeat(64)}`;
  const l = layers(addresses);
  return l[l.length - 1][0];
}

/** The proof for `who`, or null if they are not on the list. */
export function merkleProof(addresses: Address[], who: Address): Hex[] | null {
  const l = layers(addresses);
  let idx = l[0].indexOf(leafOf(who.toLowerCase() as Address));
  if (idx < 0) return null;
  const proof: Hex[] = [];
  for (let d = 0; d < l.length - 1; d++) {
    const sib = idx ^ 1;
    if (sib < l[d].length) proof.push(l[d][sib]);
    idx >>= 1;
  }
  return proof;
}

export function verifyProof(root: Hex, who: Address, proof: Hex[]): boolean {
  let h = leafOf(who.toLowerCase() as Address);
  for (const p of proof) h = pair(h, p);
  return h === root;
}
