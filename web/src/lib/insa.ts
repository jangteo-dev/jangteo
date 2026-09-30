import { maxUint256, parseAbi, zeroHash, type Address, type Hex, type WalletClient } from "viem";
import { chain, client, confirmed, currentUrl } from "./chain";
import { merkleProof, merkleRoot, verifyProof } from "./merkle";

/**
 * 인사동 Insadong: NFT drops (InsaFactory → InsaDrop) and the on-chain market (InsaMarket).
 * Collection data comes from the ops indexer (insa-data/*.json); anything that decides a
 * transaction (phase windows, what a wallet already minted, a listing's price) is read live.
 */
export const dropAbi = parseAbi([
  "struct Phase { uint64 start; uint64 end; uint128 price; uint32 perWallet; bytes32 root; }",
  "struct Config { string name; string symbol; address creator; address payout; uint32 maxSupply; uint16 royaltyBps; string baseURI; string contractURI; address renderer; }",
  "function create(Config c, Phase[] phases) returns (address)",
  "function mint(uint256 index, uint256 quantity, bytes32[] proof) payable",
  "function phases() view returns (Phase[])",
  "function mintedIn(uint256, address) view returns (uint32)",
  "function totalSupply() view returns (uint32)",
  "function maxSupply() view returns (uint32)",
  "function creator() view returns (address)",
  "function creatorOwed() view returns (uint256)",
  "function withdraw()",
  "function setApprovalForAll(address, bool)",
  "function isApprovedForAll(address, address) view returns (bool)",
  "function ownerOf(uint256) view returns (address)",
  "event Created(address indexed drop, address indexed creator, string name, string symbol, uint32 maxSupply, uint16 platformBps)",
]);
export const marketAbi = parseAbi([
  "function list(address collection, uint256 tokenId, uint128 price, uint64 expiry)",
  "function unlist(address collection, uint256 tokenId)",
  "function buy(address collection, uint256 tokenId) payable",
  "function makeOffer(address collection, uint256 tokenId, uint64 expiry) payable returns (uint256)",
  "function cancelOffer(uint256 id)",
  "function acceptOffer(uint256 id, uint256 tokenId)",
  "function listings(address, uint256) view returns (address seller, uint128 price, uint64 expiry)",
  "function isLive(address, uint256) view returns (bool)",
  "function feeBps() view returns (uint16)",
  "function owed(address) view returns (uint256)",
  "function withdrawOwed()",
]);
export const ANY = maxUint256;

export interface Phase {
  start: number;
  end: number;
  price: string;
  perWallet: number;
  root: Hex;
}
export interface Collection {
  address: Address;
  name: string;
  symbol: string;
  drop: boolean;
  verified: boolean;
  creator: Address | null;
  supply: number;
  maxSupply: number | null;
  owners: number;
  floor: string | null;
  topOffer: string | null;
  volume: string;
  volume24h: string;
  sales: number;
  listed: number;
  image: string | null;
  revealed: boolean | null;
  phases: Phase[] | null;
  createdBlock: number;
}
export interface Token {
  id: string;
  owner: Address;
  name: string | null;
  image: string | null;
  attributes: { trait_type: string; value: string }[];
  listing: { seller: Address; price: string; expiry: number } | null;
}
export interface Offer {
  id: number;
  tokenId: string;
  buyer: Address;
  price: string;
  expiry: number;
}
export interface Act {
  kind: "mint" | "sale" | "list" | "offer" | "transfer";
  id?: string;
  from?: Address;
  to?: Address;
  price?: string;
  at: number;
  tx: Hex;
}
export interface CollectionDoc {
  updatedAt: number;
  ethKrw: number;
  collection: Collection & {
    royaltyBps: number | null;
    frozen: boolean | null;
    contractURI: string | null;
    about: {
      description: string | null;
      banner: string | null;
      links: Partial<Record<"site" | "x" | "discord" | "telegram", string>>;
      lists: Record<string, string>;
      phaseNames: Record<string, string>;
    };
  };
  tokens: Token[];
  offers: Offer[];
  activity: Act[];
}
export interface InsaIndex {
  updatedAt: number;
  ethKrw: number;
  featured: Address | null;
  collections: Collection[];
  recentSales: { collection: Address; name: string; id: string; price: string; at: number; image: string | null }[];
}

const base = import.meta.env.BASE_URL;
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${base}${path}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
export const loadIndex = () => getJson<InsaIndex>("insa-data/index.json");
export const loadCollection = (a: Address) => getJson<CollectionDoc>(`insa-data/c/${a.toLowerCase()}.json`);

/** Images from the indexer are same-site paths or https URLs; anything else is dropped. */
export const safeImg = (u: string | null | undefined) => (u && (u.startsWith("/insa-data/img/") || u.startsWith("/insa/") || u.startsWith("https://")) ? currentUrl(u) : null);

export const fmtEthStr = (wei: string | bigint | null, dp = 4) => {
  if (wei === null) return "—";
  const n = Number(BigInt(wei)) / 1e18;
  if (n === 0) return "0";
  if (n < 0.000001) return n.toExponential(1);
  // Small prices keep their significant digits (0.00015, not 0.0002); larger ones round to `dp`.
  return n < 1 ? n.toLocaleString("en-US", { maximumSignificantDigits: Math.max(3, dp - 1) }) : n.toLocaleString("en-US", { maximumFractionDigits: dp });
};

// ---- phases ---------------------------------------------------------------------------------

export type PhaseState = "upcoming" | "live" | "ended";
export const phaseState = (p: Phase, now = Date.now() / 1000): PhaseState => (now < p.start ? "upcoming" : p.end !== 0 && now >= p.end ? "ended" : "live");
export const isPublic = (p: Phase) => p.root === zeroHash;
/** A phase parked on 2028-01-01 or later: its date has not been announced yet. */
export const isTba = (p: Phase) => p.start >= 1830297600;

/** The allowlist behind a phase, checked against the root on-chain before it is trusted. */
export async function loadAllowlist(url: string | undefined, root: Hex): Promise<Address[] | null> {
  if (!url || !/^\/uploads\/[0-9a-f]{64}\.json$/.test(url)) return null;
  const j = await getJson<{ addresses: Address[] }>(url.slice(1));
  if (!j?.addresses || merkleRoot(j.addresses) !== root) return null;
  return j.addresses;
}

export function proofFor(list: Address[] | null, who: Address, root: Hex): Hex[] | null {
  if (!list) return null;
  const p = merkleProof(list, who);
  return p && verifyProof(root, who, p) ? p : null;
}

export async function readMintState(drop: Address, who: Address | null) {
  const [phases, total, max] = await Promise.all([
    client.readContract({ address: drop, abi: dropAbi, functionName: "phases" }),
    client.readContract({ address: drop, abi: dropAbi, functionName: "totalSupply" }),
    client.readContract({ address: drop, abi: dropAbi, functionName: "maxSupply" }),
  ]);
  const minted = who ? await Promise.all(phases.map((_, i) => client.readContract({ address: drop, abi: dropAbi, functionName: "mintedIn", args: [BigInt(i), who] }))) : phases.map(() => 0);
  return {
    phases: phases.map((p) => ({ start: Number(p.start), end: Number(p.end), price: p.price.toString(), perWallet: p.perWallet, root: p.root })) as Phase[],
    total,
    max,
    minted: minted.map(Number),
  };
}

// ---- transactions ---------------------------------------------------------------------------

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract({ chain, account: wallet.account!, ...req } as unknown as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return rc;
}

export const mint = (w: WalletClient, drop: Address, phase: number, qty: number, proof: Hex[], price: bigint) =>
  send(w, { address: drop, abi: dropAbi, functionName: "mint", args: [BigInt(phase), BigInt(qty), proof], value: price * BigInt(qty) });

async function approveMarket(w: WalletClient, collection: Address, market: Address) {
  const ok = await client.readContract({ address: collection, abi: dropAbi, functionName: "isApprovedForAll", args: [w.account!.address, market] });
  if (ok) return;
  await send(w, { address: collection, abi: dropAbi, functionName: "setApprovalForAll", args: [market, true] });
  // GIWA's public RPC can answer from a node a block behind: wait until the approval is visible,
  // or the listing that follows is simulated against the old state and refused.
  for (let i = 0; i < 20; i++) {
    if (await client.readContract({ address: collection, abi: dropAbi, functionName: "isApprovedForAll", args: [w.account!.address, market] })) return;
    await new Promise((r) => setTimeout(r, 700));
  }
}

export async function list(w: WalletClient, market: Address, collection: Address, id: bigint, price: bigint, days: number) {
  await approveMarket(w, collection, market);
  return send(w, { address: market, abi: marketAbi, functionName: "list", args: [collection, id, price, BigInt(Math.floor(Date.now() / 1000) + days * 86400)] });
}
export const unlist = (w: WalletClient, market: Address, collection: Address, id: bigint) => send(w, { address: market, abi: marketAbi, functionName: "unlist", args: [collection, id] });

export async function buy(w: WalletClient, market: Address, collection: Address, id: bigint) {
  // Pay exactly the live price; if the seller changed it since the page loaded, the contract refuses.
  const [, price] = await client.readContract({ address: market, abi: marketAbi, functionName: "listings", args: [collection, id] });
  return send(w, { address: market, abi: marketAbi, functionName: "buy", args: [collection, id], value: price });
}

export const makeOffer = (w: WalletClient, market: Address, collection: Address, id: bigint, price: bigint, days: number) =>
  send(w, { address: market, abi: marketAbi, functionName: "makeOffer", args: [collection, id, BigInt(Math.floor(Date.now() / 1000) + days * 86400)], value: price });
export const cancelOffer = (w: WalletClient, market: Address, id: number) => send(w, { address: market, abi: marketAbi, functionName: "cancelOffer", args: [BigInt(id)] });

export async function acceptOffer(w: WalletClient, market: Address, collection: Address, offerId: number, tokenId: bigint) {
  await approveMarket(w, collection, market);
  return send(w, { address: market, abi: marketAbi, functionName: "acceptOffer", args: [BigInt(offerId), tokenId] });
}

export interface DropInput {
  name: string;
  symbol: string;
  maxSupply: number;
  royaltyBps: number;
  baseURI: string;
  contractURI: string;
  phases: { start: bigint; end: bigint; price: bigint; perWallet: number; root: Hex }[];
}

export async function createDrop(w: WalletClient, factory: Address, d: DropInput): Promise<Address | null> {
  const me = w.account!.address;
  const rc = await send(w, {
    address: factory,
    abi: dropAbi,
    functionName: "create",
    args: [{ name: d.name, symbol: d.symbol, creator: me, payout: me, maxSupply: d.maxSupply, royaltyBps: d.royaltyBps, baseURI: d.baseURI, contractURI: d.contractURI, renderer: "0x0000000000000000000000000000000000000000" }, d.phases],
  });
  const log = rc.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase());
  return log?.topics[1] ? (`0x${log.topics[1].slice(26)}` as Address) : null;
}

/** Stores a collection's details or an allowlist (api/nft-json.php) and returns its path. */
export async function storeJson(doc: object): Promise<string> {
  const r = await fetch(`${base}api/nft-json.php`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
  const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!r.ok || !j.url) throw new Error(j.error ?? `Upload failed (${r.status})`);
  return j.url;
}

export const SITE = "https://jangteo.org";

const feeAbi = parseAbi(["function platformBps() view returns (uint16)", "function feeBps() view returns (uint16)"]);
/** Jangteo's live fees in basis points: share of mint income (new drops) and of every sale. */
export async function insaFees(factory?: Address, market?: Address): Promise<{ mintBps: number | null; saleBps: number | null }> {
  const [mintBps, saleBps] = await Promise.all([
    factory ? client.readContract({ address: factory, abi: feeAbi, functionName: "platformBps" }).catch(() => null) : null,
    market ? client.readContract({ address: market, abi: feeAbi, functionName: "feeBps" }).catch(() => null) : null,
  ]);
  return { mintBps: mintBps === null ? null : Number(mintBps), saleBps: saleBps === null ? null : Number(saleBps) };
}
export const pctOf = (bps: number | null | undefined) => (bps === null || bps === undefined ? "…" : `${bps / 100}%`);

/** A token's display name: editions share one name, so the number is added when it is missing. */
export const tokenName = (name: string | null, collection: string, id: string) => (!name ? `${collection} #${id}` : name.includes("#") ? name : `${name} #${id}`);
