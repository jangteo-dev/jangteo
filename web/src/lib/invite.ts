import { getAddress, isAddress, parseAbi, type Address } from "viem";

export const inviteAbi = parseAbi([
  "function join(address referrer)",
  "function referrerOf(address) view returns (address)",
  "function invitedCount(address) view returns (uint256)",
]);

const KEY = "jangteo:ref";

/** A friend's link (jangteo.org/?ref=0x…#/points): remember who sent it, then tidy the address bar. */
export function captureRef() {
  try {
    const url = new URL(location.href);
    const ref = url.searchParams.get("ref");
    if (!ref) return;
    if (isAddress(ref)) localStorage.setItem(KEY, getAddress(ref));
    url.searchParams.delete("ref");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    /* storage blocked: the friend can still paste the address */
  }
}

export function savedRef(): Address | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && isAddress(v) ? (v as Address) : null;
  } catch {
    return null;
  }
}

export const inviteLink = (me: Address) => `${location.origin}/?ref=${me}#/points`;
