import { maxUint256, parseUnits, type Address, type WalletClient } from "viem";
import { GyeWonAbi } from "./abi";
import { chain, client, confirmed, mustHold } from "./chain";
import { JangteoPropertyAbi } from "./propertyAbi";

export const PROP_STATUS = ["None", "Funding", "Active", "Failed", "Sold"] as const;
export type PropStatus = (typeof PROP_STATUS)[number];
export const PROP_KINDS = ["apartment", "house", "land", "commercial", "other"] as const;
export type PropKind = (typeof PROP_KINDS)[number];

/** What the issuer wrote about the property (stored on-chain as JSON, ≤ 4 KB). */
export interface PropMeta {
  name: string;
  nameKo?: string;
  location: string;
  locationKo?: string;
  kind: PropKind;
  areaM2?: number;
  description?: string;
  descriptionKo?: string;
  images: string[];
}

export interface Property {
  id: number;
  share: Address;
  issuer: Address;
  status: PropStatus;
  verified: boolean;
  saleBps: number;
  tradeBps: number;
  exitBps: number;
  totalShares: bigint;
  minShares: bigint;
  price: bigint;
  endAt: number;
  rentPerPeriod: bigint;
  reserveMonths: bigint;
  sold: bigint;
  activatedAt: number;
  lastPeriodAt: number;
  reserve: bigint;
  due: bigint;
  rentPaid: bigint;
  rentUnclaimed: bigint;
  refundable: bigint;
  salePrice: bigint;
  pool: bigint;
  exitSupply: bigint;
  redeemed: bigint;
  meta: PropMeta;
}

export interface PropListing {
  id: number;
  property: number;
  seller: Address;
  shares: bigint;
  price: bigint;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined) || undefined;
/** Only our own paths and https images are shown; anything else in the JSON is dropped. */
const safeImage = (v: unknown) =>
  typeof v === "string" && (/^https:\/\/[^\s"<>]+$/.test(v) || /^\/(property|uploads)\/[\w.-]+$/.test(v)) ? v : undefined;

export function parseMeta(raw: string): PropMeta {
  let j: Record<string, unknown> = {};
  try {
    const x = JSON.parse(raw) as unknown;
    if (x && typeof x === "object") j = x as Record<string, unknown>;
  } catch {
    /* an unreadable profile shows as an unnamed property */
  }
  const kind = PROP_KINDS.includes(j.kind as PropKind) ? (j.kind as PropKind) : "other";
  const area = typeof j.areaM2 === "number" && Number.isFinite(j.areaM2) && j.areaM2 > 0 ? j.areaM2 : undefined;
  const images = (Array.isArray(j.images) ? j.images : []).map(safeImage).filter((x): x is string => !!x).slice(0, 6);
  return {
    name: str(j.name, 80) ?? "—",
    nameKo: str(j.nameKo, 80),
    location: str(j.location, 120) ?? "",
    locationKo: str(j.locationKo, 120),
    kind,
    areaM2: area,
    description: str(j.description, 1500),
    descriptionKo: str(j.descriptionKo, 1500),
    images,
  };
}

/** Name / location / description in the reader's language when the issuer wrote one. */
export const localized = (m: PropMeta, lang: "en" | "ko") => ({
  name: (lang === "ko" && m.nameKo) || m.name,
  location: (lang === "ko" && m.locationKo) || m.location,
  description: (lang === "ko" && m.descriptionKo) || m.description,
});

export async function readProperty(addr: Address, id: number): Promise<Property> {
  const [p, raw] = await Promise.all([
    client.readContract({ address: addr, abi: JangteoPropertyAbi, functionName: "property", args: [BigInt(id)] }),
    client.readContract({ address: addr, abi: JangteoPropertyAbi, functionName: "metadata", args: [BigInt(id)] }),
  ]);
  return {
    id,
    share: p.share,
    issuer: p.issuer,
    status: PROP_STATUS[p.status],
    verified: p.verified,
    saleBps: p.saleBps,
    tradeBps: p.tradeBps,
    exitBps: p.exitBps,
    totalShares: p.totalShares,
    minShares: p.minShares,
    price: p.price,
    endAt: Number(p.endAt),
    rentPerPeriod: p.rentPerPeriod,
    reserveMonths: p.reserveMonths,
    sold: p.sold,
    activatedAt: Number(p.activatedAt),
    lastPeriodAt: Number(p.lastPeriodAt),
    reserve: p.reserve,
    due: p.due,
    rentPaid: p.rentPaid,
    rentUnclaimed: p.rentUnclaimed,
    refundable: p.refundable,
    salePrice: p.salePrice,
    pool: p.pool,
    exitSupply: p.exitSupply,
    redeemed: p.redeemed,
    meta: parseMeta(raw),
  };
}

/** Verified first, then open sales, then the rest; newest first inside each group. */
export async function listProperties(addr: Address): Promise<Property[]> {
  const n = Number(await client.readContract({ address: addr, abi: JangteoPropertyAbi, functionName: "count" }));
  // A cancelled or failed sale with nothing left to refund has nothing to show; its page still works.
  const all = (await Promise.all(Array.from({ length: n }, (_, i) => readProperty(addr, i)))).filter((p) => !(p.status === "Failed" && p.refundable === 0n));
  const rank = (p: Property) => (p.verified ? 0 : 2) + (p.status === "Funding" || p.status === "Active" ? 0 : 1);
  return all.sort((a, b) => rank(a) - rank(b) || b.id - a.id);
}

export async function readListings(addr: Address, id: number): Promise<PropListing[]> {
  const ids = await client.readContract({ address: addr, abi: JangteoPropertyAbi, functionName: "listingsOf", args: [BigInt(id)] });
  const ls = await Promise.all(ids.map((i) => client.readContract({ address: addr, abi: JangteoPropertyAbi, functionName: "listing", args: [i] })));
  return ls.map((l, k) => ({ id: Number(ids[k]), property: Number(l.property), seller: l.seller, shares: l.shares, price: l.price }));
}

const shareAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface Position {
  shares: bigint;
  claimable: bigint;
  eligible: bigint;
  arrears: bigint;
  nextPeriodAt: number;
}

export async function readPosition(addr: Address, p: Property, who: Address | null): Promise<Position> {
  const [shares, claimable, eligible, arr] = await Promise.all([
    who ? client.readContract({ address: p.share, abi: shareAbi, functionName: "balanceOf", args: [who] }) : 0n,
    who ? client.readContract({ address: addr, abi: JangteoPropertyAbi, functionName: "claimable", args: [BigInt(p.id), who] }) : 0n,
    client.readContract({ address: addr, abi: JangteoPropertyAbi, functionName: "eligibleShares", args: [BigInt(p.id)] }),
    client.readContract({ address: addr, abi: JangteoPropertyAbi, functionName: "arrears", args: [BigInt(p.id)] }),
  ]);
  return { shares, claimable, eligible, arrears: arr[0], nextPeriodAt: Number(arr[1]) };
}

// ─────────────────────────────── maths shown in the UI ───────────────────────────────

/** Yearly rent as a share of the sale value, in percent (simple, not compounded). */
export const yieldPct = (p: Pick<Property, "rentPerPeriod" | "price" | "totalShares">) =>
  p.price === 0n || p.totalShares === 0n ? 0 : (Number(p.rentPerPeriod) * 12 * 100) / (Number(p.price) * Number(p.totalShares));
export const rentPerShare = (p: Pick<Property, "rentPerPeriod" | "totalShares">) => (p.totalShares === 0n ? 0n : p.rentPerPeriod / p.totalShares);
/** What redeeming `shares` pays after a sale, using the contract's cumulative rounding. */
export const redeemValue = (p: Pick<Property, "pool" | "exitSupply" | "redeemed">, shares: bigint) =>
  p.exitSupply === 0n ? 0n : (p.pool * (p.redeemed + shares)) / p.exitSupply - (p.pool * p.redeemed) / p.exitSupply;
export const feeOf = (v: bigint, bps: number) => (v * BigInt(bps)) / 10_000n;
export const toWei = (won: string) => parseUnits(won || "0", 18);

/** Whole numbers only (shares, won amounts): anything else typed is dropped. */
export const digits = (v: string) => v.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "").slice(0, 15);

// ────────────────────────────────────── actions ──────────────────────────────────────

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return { hash, rc };
}

async function approve(wallet: WalletClient, token: Address, spender: Address, amount: bigint) {
  await mustHold(token, wallet.account!.address, amount);
  const owner = wallet.account!.address;
  const allowance = await client.readContract({ address: token, abi: GyeWonAbi, functionName: "allowance", args: [owner, spender] });
  if (allowance >= amount) return;
  await send(wallet, { account: wallet.account!, chain, address: token, abi: GyeWonAbi, functionName: "approve", args: [spender, maxUint256] });
}

const tx = (wallet: WalletClient, addr: Address, functionName: string, args: unknown[]) =>
  send(wallet, { account: wallet.account!, chain, address: addr, abi: JangteoPropertyAbi, functionName, args });

export interface NewTerms {
  totalShares: bigint;
  minShares: bigint;
  price: bigint;
  duration: bigint;
  rentPerPeriod: bigint;
  reserveMonths: bigint;
}

export const property = {
  create: (wallet: WalletClient, addr: Address, t: NewTerms, meta: PropMeta) => tx(wallet, addr, "create", [t, JSON.stringify(meta)]),
  async buy(wallet: WalletClient, addr: Address, tkrw: Address, p: Property, shares: bigint) {
    await approve(wallet, tkrw, addr, shares * p.price);
    return tx(wallet, addr, "buy", [BigInt(p.id), shares]);
  },
  finalize: (wallet: WalletClient, addr: Address, id: number) => tx(wallet, addr, "finalize", [BigInt(id)]),
  cancel: (wallet: WalletClient, addr: Address, id: number) => tx(wallet, addr, "cancel", [BigInt(id)]),
  refund: (wallet: WalletClient, addr: Address, id: number) => tx(wallet, addr, "refund", [BigInt(id)]),
  claimRent: (wallet: WalletClient, addr: Address, id: number) => tx(wallet, addr, "claimRent", [BigInt(id)]),
  accrue: (wallet: WalletClient, addr: Address, id: number) => tx(wallet, addr, "accrue", [BigInt(id)]),
  async fundReserve(wallet: WalletClient, addr: Address, tkrw: Address, id: number, amount: bigint) {
    await approve(wallet, tkrw, addr, amount);
    return tx(wallet, addr, "fundReserve", [BigInt(id), amount]);
  },
  list: (wallet: WalletClient, addr: Address, id: number, shares: bigint, price: bigint) => tx(wallet, addr, "list", [BigInt(id), shares, price]),
  async buyListing(wallet: WalletClient, addr: Address, tkrw: Address, l: PropListing, shares: bigint) {
    await approve(wallet, tkrw, addr, shares * l.price);
    return tx(wallet, addr, "buyListing", [BigInt(l.id), shares]);
  },
  cancelListing: (wallet: WalletClient, addr: Address, lid: number) => tx(wallet, addr, "cancelListing", [BigInt(lid)]),
  async sell(wallet: WalletClient, addr: Address, tkrw: Address, id: number, amount: bigint) {
    await approve(wallet, tkrw, addr, amount);
    return tx(wallet, addr, "sell", [BigInt(id), amount]);
  },
  redeem: (wallet: WalletClient, addr: Address, id: number, shares: bigint) => tx(wallet, addr, "redeem", [BigInt(id), shares]),
};
