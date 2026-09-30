import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi, parseAbiItem, zeroAddress, type Address, type Hex } from "viem";
import { giwa, reason } from "../chain.ts";
import { config } from "../config.ts";
import { Seen } from "../engine/rescan.ts";
import type { Store } from "../engine/db.ts";
import type { Task } from "../engine/scheduler.ts";
import { verifyDrop } from "./verifyDrop.ts";

/**
 * 인사동 Insadong indexer. Follows the drop factory, every drop's transfers and the market's
 * listings, offers and sales, and publishes what the web app shows:
 *
 *   insa-data/index.json        every collection with its floor, volume and owners, recent sales
 *   insa-data/c/<addr>.json     one collection: tokens (owner, name, image, traits, listing),
 *                               open offers and activity
 *   insa-data/img/<sha>.<ext>   on-chain images (data: URIs) saved as files, by content hash
 *
 * The web app never fetches metadata from third parties (its CSP forbids it): this indexer does,
 * with a timeout and a size cap, and caches by URI.
 */
const SITE = "https://jangteo.org";
const LEGACY = ["https://gye.rygroup.asia"];
const UPLOADS = "/srv/jangteo/uploads";
const IPFS = "https://gateway.pinata.cloud/ipfs/";

const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const mintedEv = parseAbiItem("event Minted(address indexed to, uint256 indexed phase, uint256 firstId, uint256 quantity, uint256 paid)");
const created = parseAbiItem("event Created(address indexed drop, address indexed creator, string name, string symbol, uint32 maxSupply, uint16 platformBps)");
const metaEvents = parseAbi(["event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId)", "event MetadataUpdate(uint256 _tokenId)", "event SeedRevealed(uint256 seed)", "event BaseURISet(string uri)"]);
const marketEvents = parseAbi([
  "event Listed(address indexed collection, uint256 indexed tokenId, address indexed seller, uint256 price, uint64 expiry)",
  "event Unlisted(address indexed collection, uint256 indexed tokenId)",
  "event Sold(address indexed collection, uint256 indexed tokenId, address seller, address buyer, uint256 price, uint256 royalty, uint256 fee, uint256 offerId)",
  "event OfferMade(uint256 indexed id, address indexed collection, uint256 indexed tokenId, address buyer, uint256 price, uint64 expiry)",
  "event OfferClosed(uint256 indexed id, bool accepted)",
]);
const nftAbi = parseAbi([
  "struct Phase { uint64 start; uint64 end; uint128 price; uint32 perWallet; bytes32 root; }",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function tokenURI(uint256) view returns (string)",
  "function ownerOf(uint256) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint32)",
  "function creator() view returns (address)",
  "function payout() view returns (address)",
  "function royaltyBps() view returns (uint16)",
  "function platformBps() view returns (uint16)",
  "function contractURI() view returns (string)",
  "function phases() view returns (Phase[])",
  "function seed() view returns (uint256)",
  "function frozen() view returns (bool)",
  "function renderer() view returns (address)",
]);

interface TokenMeta {
  name?: string;
  image?: string;
  attributes?: { trait_type: string; value: string }[];
}
interface Listing {
  seller: Address;
  price: string;
  expiry: number;
}
interface Offer {
  id: number;
  tokenId: string; // "any" for a collection offer
  buyer: Address;
  price: string;
  expiry: number;
}
interface Act {
  kind: "mint" | "sale" | "list" | "offer" | "transfer";
  id?: string;
  from?: Address;
  to?: Address;
  price?: string;
  at: number;
  tx: Hex;
}
interface Col {
  address: Address;
  drop: boolean; // launched on Insadong
  createdBlock: number;
  owners: Record<string, Address>;
  listings: Record<string, Listing>;
  offers: Record<string, Offer>;
  sales: { id: string; price: string; at: number }[];
  activity: Act[];
  meta: Record<string, TokenMeta>;
  stale: boolean; // metadata needs a refresh
  verified?: boolean;
}
interface State {
  block: number;
  cols: Record<string, Col>;
  /** Totals for Telegram: mints, sales, and what Jangteo earned (wei, as strings). */
  stats?: InsaStats;
  /** Activity since the last Telegram digest. */
  pending?: { mints: number; sales: number; volume: string; fees: string; since: number };
}
export interface InsaStats {
  mints: number;
  sales: number;
  volume: string;
  marketFees: string;
  mintIncome: string; // Jangteo's share of paid mints
}
const DIGEST_MS = 30 * 60_000;

const deployments = resolve(config.root, "../contracts/deployments");
function insa(): { insaFactory: Address; insaMarket: Address; fromBlock: number } | null {
  const f = `${deployments}/91342.insa.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

const uriCache = new Map<string, TokenMeta | null>();

async function fetchJson(url: string): Promise<unknown> {
  // Files Jangteo stores itself are read from disk, whichever of its domains the chain recorded
  // (links written on-chain before the move to jangteo.org keep working after the old one is gone).
  if (url.startsWith(`${SITE}/uploads/`) || url.startsWith("/uploads/") || LEGACY.some((d) => url.startsWith(`${d}/uploads/`))) {
    const f = resolve(UPLOADS, url.split("/").pop()!);
    return /^[0-9a-f]{64}\.json$/.test(url.split("/").pop()!) && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  }
  // Uploaded collections: /nft/<manifest>/<id>.json is built from the manifest on disk, as nft-meta.php does.
  const nft = url.match(/^https:\/\/(?:jangteo\.org|gye\.rygroup\.asia)\/nft\/([0-9a-f]{64})\/([1-9]\d{0,5})\.json$/);
  if (nft) {
    const f = resolve(UPLOADS, `${nft[1]}.json`);
    if (!existsSync(f)) return null;
    const m = JSON.parse(readFileSync(f, "utf8")) as { kind?: string; name?: string; description?: string; images?: string[] };
    const image = m.kind === "manifest" ? m.images?.[Number(nft[2]) - 1] : undefined;
    return image ? { name: `${m.name ?? "Token"} #${nft[2]}`, description: m.description, image } : null;
  }
  const res = await fetch(url.startsWith("ipfs://") ? IPFS + url.slice(7) : url, { signal: AbortSignal.timeout(6000), redirect: "follow" });
  if (!res.ok) return null;
  const text = await res.text();
  return text.length > 200_000 ? null : JSON.parse(text);
}

/** Saves a data: image as a file and returns its public path; https/ipfs images pass through. */
function imagePath(img: unknown, dir: string): string | undefined {
  if (typeof img !== "string") return undefined;
  if (img.startsWith("ipfs://")) return IPFS + img.slice(7);
  if (img.startsWith("https://")) return img;
  const m = img.match(/^data:image\/(svg\+xml|png|webp|gif|jpeg)(;base64)?,(.*)$/s);
  if (!m) return undefined;
  const bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
  if (bytes.length > 300_000) return undefined;
  const ext = m[1] === "svg+xml" ? "svg" : m[1] === "jpeg" ? "jpg" : m[1];
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
  const f = resolve(dir, name);
  if (!existsSync(f)) writeFileSync(f, bytes);
  return `/insa-data/img/${name}`;
}

async function tokenMeta(uri: string, dir: string): Promise<TokenMeta | null> {
  if (uriCache.has(uri)) return uriCache.get(uri)!;
  let raw: unknown = null;
  try {
    const m = uri.match(/^data:application\/json(;base64)?,(.*)$/s);
    raw = m ? JSON.parse(m[1] ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2])) : await fetchJson(uri);
  } catch {
    raw = null;
  }
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const meta: TokenMeta | null = o
    ? {
        name: typeof o.name === "string" ? o.name.slice(0, 80) : undefined,
        image: imagePath(o.image ?? o.image_url, dir),
        attributes: Array.isArray(o.attributes)
          ? o.attributes
              .filter((a): a is { trait_type: unknown; value: unknown } => !!a && typeof a === "object")
              .slice(0, 20)
              .map((a) => ({ trait_type: String(a.trait_type ?? "").slice(0, 40), value: String(a.value ?? "").slice(0, 60) }))
          : undefined,
      }
    : null;
  if (!uri.startsWith("data:") || uriCache.size < 5000) uriCache.set(uri, meta);
  return meta;
}

function newCol(address: Address, drop: boolean, block: number): Col {
  return { address, drop, createdBlock: block, owners: {}, listings: {}, offers: {}, sales: [], activity: [], meta: {}, stale: true };
}

const DAY = 86_400;

export function insaIndexTask(store: Store): Task {
  return {
    id: "nft:index",
    title: "인사동 index",
    everyMs: 90_000,
    timeoutMs: 15 * 60_000,
    async run() {
      const a = insa();
      if (!a) return { summary: "Insadong not deployed" };
      const out = resolve(config.webroot, "insa-data");
      const imgDir = resolve(out, "img");
      mkdirSync(resolve(out, "c"), { recursive: true });
      mkdirSync(imgDir, { recursive: true });
      const st = store.get<State>("insa:state") ?? { block: a.fromBlock, cols: {} };
      st.stats ??= { mints: 0, sales: 0, volume: "0", marketFees: "0", mintIncome: "0" };
      st.pending ??= { mints: 0, sales: 0, volume: "0", fees: "0", since: Date.now() };
      const stats = st.stats;
      const pend = st.pending;
      const plus = (a: string, b: bigint) => (BigInt(a) + b).toString();
      const bps = store.get<Record<string, number>>("insa:bps") ?? {};
      const head = Number(await giwa.getBlockNumber());
      const now = Math.floor(Date.now() / 1000);
      const blockTime = (b: bigint) => now - (head - Number(b)); // 1-second blocks
      let events = 0;

      try {
        const seen = new Seen(store, "insa");
        for (let from = Number(seen.start(st.block, BigInt(head))); from <= head; ) {
          const to = Math.min(from + 9_999, head);
          const range = { fromBlock: BigInt(from), toBlock: BigInt(to) };
          for (const l of await giwa.getLogs({ address: a.insaFactory, event: created, ...range })) {
            const d = l.args.drop!.toLowerCase();
            bps[d] = Number(l.args.platformBps);
            st.cols[d] ??= newCol(l.args.drop!, true, Number(l.blockNumber));
            st.cols[d].drop = true;
          }
          const drops = Object.values(st.cols).filter((c) => c.drop).map((c) => c.address);
          const tracked = Object.values(st.cols).map((c) => c.address);
          if (tracked.length) {
            for (const l of await giwa.getLogs({ address: tracked, event: transfer, ...range })) {
              if (!seen.fresh(l)) continue;
              const c = st.cols[l.address.toLowerCase()];
              const id = l.args.tokenId!.toString();
              c.owners[id] = l.args.to!;
              if (l.args.to === zeroAddress) delete c.owners[id];
              if (l.args.from === zeroAddress) {
                c.activity.push({ kind: "mint", id, to: l.args.to!, at: blockTime(l.blockNumber), tx: l.transactionHash });
              }
              events++;
            }
          }
          if (drops.length) {
            for (const l of await giwa.getLogs({ address: drops, event: mintedEv, ...range })) {
              if (!seen.fresh(l)) continue;
              const q = Number(l.args.quantity);
              stats.mints += q;
              pend.mints += q;
              const cut = (l.args.paid! * BigInt(bps[l.address.toLowerCase()] ?? 0)) / 10_000n;
              stats.mintIncome = plus(stats.mintIncome, cut);
              pend.fees = plus(pend.fees, cut);
            }
            for (const l of await giwa.getLogs({ address: drops, events: metaEvents, ...range })) {
              st.cols[l.address.toLowerCase()].stale = true;
              if (l.eventName !== "BaseURISet") st.cols[l.address.toLowerCase()].meta = {};
            }
          }
          for (const l of await giwa.getLogs({ address: a.insaMarket, events: marketEvents, ...range })) {
            if (!seen.fresh(l)) continue;
            events++;
            const at = blockTime(l.blockNumber);
            if (l.eventName === "OfferClosed") {
              for (const c of Object.values(st.cols)) delete c.offers[l.args.id!.toString()];
              continue;
            }
            const addr = l.args.collection!;
            const c = (st.cols[addr.toLowerCase()] ??= newCol(addr, false, Number(l.blockNumber)));
            const id = l.args.tokenId!.toString();
            if (l.eventName === "Listed") {
              c.listings[id] = { seller: l.args.seller!, price: l.args.price!.toString(), expiry: Number(l.args.expiry) };
              c.activity.push({ kind: "list", id, from: l.args.seller!, price: l.args.price!.toString(), at, tx: l.transactionHash });
            } else if (l.eventName === "Unlisted") {
              delete c.listings[id];
            } else if (l.eventName === "Sold") {
              stats.sales++;
              pend.sales++;
              stats.volume = plus(stats.volume, l.args.price!);
              stats.marketFees = plus(stats.marketFees, l.args.fee!);
              pend.volume = plus(pend.volume, l.args.price!);
              pend.fees = plus(pend.fees, l.args.fee!);
              delete c.listings[id];
              if (!c.drop) c.owners[id] = l.args.buyer!;
              c.sales.push({ id, price: l.args.price!.toString(), at });
              c.activity.push({ kind: "sale", id, from: l.args.seller!, to: l.args.buyer!, price: l.args.price!.toString(), at, tx: l.transactionHash });
            } else if (l.eventName === "OfferMade") {
              const any = l.args.tokenId === 2n ** 256n - 1n;
              c.offers[l.args.id!.toString()] = { id: Number(l.args.id), tokenId: any ? "any" : id, buyer: l.args.buyer!, price: l.args.price!.toString(), expiry: Number(l.args.expiry) };
              c.activity.push({ kind: "offer", id: any ? undefined : id, from: l.args.buyer!, price: l.args.price!.toString(), at, tx: l.transactionHash });
            }
          }
          from = to + 1;
        }
        st.block = head + 1;
        seen.save();
      } catch (err) {
        store.set("insa:state", st);
        return { summary: `Insadong index: ${reason(err).slice(0, 100)}` };
      }

      const ethKrw = (() => {
        try {
          return (JSON.parse(readFileSync(resolve(config.webroot, "market.json"), "utf8")) as { ethKrw: number }).ethKrw;
        } catch {
          return 0;
        }
      })();

      // Rehearsal collections stay reachable by address but are left out of Insadong's lists.
      const hidden = new Set(((): string[] => {
        try {
          return JSON.parse(readFileSync(`${deployments}/91342.insa-hidden.json`, "utf8"));
        } catch {
          return [];
        }
      })().map((x) => x.toLowerCase()));
      const summaries = [];
      const recentSales = [];
      for (const c of Object.values(st.cols)) {
        const r = <T>(functionName: string, args: unknown[] = []) => giwa.readContract({ address: c.address, abi: nftAbi, functionName, args } as never).catch(() => null) as Promise<T | null>;
        const [name, symbol, supply, maxSupply, creator, royaltyBps, contractURI, phases, seed, frozen, renderer] = await Promise.all([
          r<string>("name"), r<string>("symbol"), r<bigint>("totalSupply"), c.drop ? r<number>("maxSupply") : null, c.drop ? r<Address>("creator") : null,
          c.drop ? r<number>("royaltyBps") : null, c.drop ? r<string>("contractURI") : null,
          c.drop ? r<{ start: bigint; end: bigint; price: bigint; perWallet: number; root: Hex }[]>("phases") : null,
          c.drop ? r<bigint>("seed") : null, c.drop ? r<boolean>("frozen") : null, c.drop ? r<Address>("renderer") : null,
        ]);
        let about: Record<string, unknown> = {};
        if (contractURI) {
          try {
            const j = await fetchJson(contractURI);
            if (j && typeof j === "object") about = j as Record<string, unknown>;
          } catch {
            /* unreachable page details are simply left out */
          }
        }
        // Owners of market-only collections: ask the chain for tokens seen in the market.
        if (!c.drop) {
          const ids = new Set([...Object.keys(c.listings), ...Object.values(c.offers).map((o) => o.tokenId).filter((x) => x !== "any"), ...c.sales.map((s) => s.id)]);
          for (const id of ids) {
            const o = await r<Address>("ownerOf", [BigInt(id)]);
            if (o) c.owners[id] = o;
          }
        }
        // Token metadata: new tokens, or everything after a metadata update / reveal.
        const ids = Object.keys(c.owners);
        const need = c.stale ? ids : ids.filter((id) => !c.meta[id]);
        for (let i = 0; i < need.length; i += 25) {
          await Promise.all(
            need.slice(i, i + 25).map(async (id) => {
              const uri = await r<string>("tokenURI", [BigInt(id)]);
              const m = uri ? await tokenMeta(uri, imgDir) : null;
              if (m) c.meta[id] = m;
            }),
          );
        }
        c.stale = false;
        if (c.drop && c.verified === undefined && phases) c.verified = await verifyDrop(c.address);

        const live = Object.entries(c.listings).filter(([id, l]) => l.expiry > now && c.owners[id]?.toLowerCase() === l.seller.toLowerCase());
        const floor = live.length ? live.reduce((m, [, l]) => (BigInt(l.price) < m ? BigInt(l.price) : m), BigInt(live[0][1].price)) : null;
        const vol = c.sales.reduce((s, x) => s + BigInt(x.price), 0n);
        const vol24 = c.sales.filter((x) => x.at > now - DAY).reduce((s, x) => s + BigInt(x.price), 0n);
        const owners = new Set(Object.values(c.owners).map((o) => o.toLowerCase())).size;
        const offers = Object.values(c.offers).filter((o) => o.expiry > now);
        const topOffer = offers.filter((o) => o.tokenId === "any").reduce((m, o) => (BigInt(o.price) > m ? BigInt(o.price) : m), 0n);
        const cover = typeof about.image === "string" ? about.image : Object.values(c.meta)[0]?.image;
        const base = {
          address: c.address,
          name: name ?? "Unknown",
          symbol: symbol ?? "",
          drop: c.drop,
          verified: !!c.verified,
          creator,
          supply: Number(supply ?? BigInt(Object.keys(c.owners).length)),
          maxSupply,
          owners,
          floor: floor?.toString() ?? null,
          topOffer: topOffer ? topOffer.toString() : null,
          volume: vol.toString(),
          volume24h: vol24.toString(),
          sales: c.sales.length,
          listed: live.length,
          image: cover ?? null,
          revealed: renderer && renderer !== zeroAddress ? seed !== 0n : null,
          phases: phases?.map((p) => ({ start: Number(p.start), end: Number(p.end), price: p.price.toString(), perWallet: p.perWallet, root: p.root })) ?? null,
          createdBlock: c.createdBlock,
        };
        if (!hidden.has(c.address.toLowerCase())) summaries.push(base);
        if (!hidden.has(c.address.toLowerCase())) for (const s of c.sales.slice(-20)) recentSales.push({ collection: c.address, name: base.name, id: s.id, price: s.price, at: s.at, image: c.meta[s.id]?.image ?? null });

        const doc = {
          updatedAt: now,
          ethKrw,
          collection: {
            ...base,
            royaltyBps,
            frozen,
            contractURI,
            about: {
              description: typeof about.description === "string" ? about.description.slice(0, 2000) : null,
              banner: typeof about.banner === "string" ? about.banner : null,
              links: about.links && typeof about.links === "object" ? about.links : {},
              lists: about.lists && typeof about.lists === "object" ? about.lists : {},
              phaseNames: about.phaseNames && typeof about.phaseNames === "object" ? about.phaseNames : {},
            },
          },
          tokens: ids
            .map((id) => {
              const l = c.listings[id];
              const isLive = l && l.expiry > now && c.owners[id]?.toLowerCase() === l.seller.toLowerCase();
              return { id, owner: c.owners[id], name: c.meta[id]?.name ?? null, image: c.meta[id]?.image ?? null, attributes: c.meta[id]?.attributes ?? [], listing: isLive ? l : null };
            })
            .sort((x, y) => Number(BigInt(x.id) - BigInt(y.id))),
          offers,
          activity: c.activity.slice(-300).reverse(),
        };
        c.activity = c.activity.slice(-1000);
        c.sales = c.sales.slice(-5000);
        const f = resolve(out, "c", `${c.address.toLowerCase()}.json`);
        writeFileSync(`${f}.tmp`, JSON.stringify(doc));
        renameSync(`${f}.tmp`, f);
      }
      store.set("insa:bps", bps);
      // A Telegram digest at most every 30 minutes, only when something happened.
      let digest: string | null = null;
      if ((pend.mints || pend.sales) && Date.now() - pend.since >= DIGEST_MS) {
        const talSum = summaries.find((x) => x.name === "Tal" && x.drop);
        const eth = (w: string) => (Number(w) / 1e18).toLocaleString("en-US", { maximumSignificantDigits: 4 });
        digest =
          `🖼 Insadong (30 min): ${pend.mints} minted${talSum ? ` · Tal ${talSum.supply}/${talSum.maxSupply}` : ""}` +
          ` · ${pend.sales} sales, vol ${eth(pend.volume)} ETH · Jangteo earned ${eth(pend.fees)} ETH`;
        st.pending = { mints: 0, sales: 0, volume: "0", fees: "0", since: Date.now() };
      }
      store.set("insa:state", st);
      store.set("insa:stats", { ...stats, collections: summaries.length, tal: summaries.find((x) => x.name === "Tal" && x.drop) ?? null });
      const tal = (() => {
        try {
          return JSON.parse(readFileSync(`${deployments}/91342.tal.json`, "utf8")).tal as Address;
        } catch {
          return null;
        }
      })();
      const idx = resolve(out, "index.json");
      writeFileSync(
        `${idx}.tmp`,
        JSON.stringify({ updatedAt: now, ethKrw, featured: tal, collections: summaries, recentSales: recentSales.sort((x, y) => y.at - x.at).slice(0, 40) }),
      );
      renameSync(`${idx}.tmp`, idx);
      return digest ? { summary: digest, notify: "info" } : { summary: `Insadong: ${summaries.length} collections, ${events} events` };
    },
  };
}
