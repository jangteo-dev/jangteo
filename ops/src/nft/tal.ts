import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi, parseEther, zeroHash, type Address } from "viem";
import { explorerTx, giwa, reason, write } from "../chain.ts";
import { config } from "../config.ts";
import type { Store } from "../engine/db.ts";
import type { Task } from "../engine/scheduler.ts";
import { merkleProof, merkleRoot } from "./merkle.ts";

/**
 * 탈 Tal, Jangteo's own collection on 인사동 Insadong: 1,000 masks drawn on-chain.
 *
 *   Guaranteed  free, 1 per wallet, for everyone who had Jangteo points when the drop was made
 *   Allowlist   0.0005 ETH, 3 per wallet, for every wallet with points when the phase opens:
 *               the list keeps growing (the root is re-set on-chain) until then
 *   Public      0.001 ETH, 5 per wallet
 *   Reveal      when the collection sells out, or REVEAL_AT, whichever comes first
 *
 * `node src/nft/tal.ts create` launches it once; `talTask` keeps the allowlist fresh, reveals and
 * collects the mint income.
 */
export const dropAbi = parseAbi([
  "struct Phase { uint64 start; uint64 end; uint128 price; uint32 perWallet; bytes32 root; }",
  "struct Config { string name; string symbol; address creator; address payout; uint32 maxSupply; uint16 royaltyBps; string baseURI; string contractURI; address renderer; }",
  "function create(Config c, Phase[] phases) returns (address)",
  "function phases() view returns (Phase[])",
  "function setPhase(uint256 index, Phase p)",
  "function setContractURI(string uri)",
  "function contractURI() view returns (string)",
  "function totalSupply() view returns (uint32)",
  "function maxSupply() view returns (uint32)",
  "function seed() view returns (uint256)",
  "function seedBlock() view returns (uint64)",
  "function commitSeed()",
  "function revealSeed()",
  "function withdraw()",
  "function mint(uint256 index, uint256 quantity, bytes32[] proof) payable",
  "function creatorOwed() view returns (uint256)",
  "event Created(address indexed drop, address indexed creator, string name, string symbol, uint32 maxSupply, uint16 platformBps)",
]);

const marketFeeAbi = parseAbi(["function pendingEta() view returns (uint64)", "function applyFee()", "function feeBps() view returns (uint16)"]);

const KST = (y: number, m: number, d: number, h: number) => Math.floor(Date.UTC(y, m - 1, d, h - 9) / 1000);
export const TAL_SCHEDULE = {
  gtd: KST(2026, 9, 26, 21),
  allowlist: KST(2026, 9, 27, 21),
  publicAt: KST(2026, 9, 28, 21),
  revealAt: KST(2026, 9, 29, 21),
};
/** Phases were pushed to 2028-01-01 on 2026-09-26: the whitelist event gets its date once the site is bug-free. */
export const TAL_TBA = 1830297600;
const UPLOADS = "/srv/jangteo/uploads";
const SITE = "https://jangteo.org";

const deployments = resolve(config.root, "../contracts/deployments");
const read = (f: string) => (existsSync(`${deployments}/${f}`) ? JSON.parse(readFileSync(`${deployments}/${f}`, "utf8")) : null);
export const talAddress = (): Address | null => read("91342.tal.json")?.tal ?? null;

/** Stores a JSON document the way api/nft-json.php does: named by the SHA-256 of its bytes. */
function store(doc: object): string {
  const body = JSON.stringify(doc);
  const hash = createHash("sha256").update(body).digest("hex");
  const path = `${UPLOADS}/${hash}.json`;
  if (!existsSync(path)) writeFileSync(path, body, { mode: 0o644 });
  return `/uploads/${hash}.json`;
}

/** Wallets with Jangteo points, plus the team wallets that test the drop end to end. */
function pointsWallets(): Address[] {
  const p = JSON.parse(readFileSync(resolve(config.webroot, "points.json"), "utf8")) as { entries: { address: Address; total: number }[] };
  const team = [config.wallets.deployer, ...config.wallets.farm].filter(Boolean).map((w) => w!.address.toLowerCase() as Address);
  return [...new Set([...p.entries.filter((e) => e.total > 0).map((e) => e.address.toLowerCase() as Address), ...team])].sort();
}

function collectionDoc(lists: Record<string, string>) {
  return {
    kind: "collection",
    description:
      "Tal are the carved wooden masks of Korean mask dance: the aristocrat, the bride, the trickster, the old woman, the goblin. 1,000 of them, drawn entirely on-chain on GIWA, with traits no one can know until the reveal. Jangteo's own collection.",
    image: `${SITE}/insa/tal-cover.svg`,
    links: { site: `${SITE}/#/insa/tal` },
    lists,
    phaseNames: { "0": "Guaranteed", "1": "Allowlist", "2": "Public" },
  };
}

export async function createTal() {
  if (talAddress()) throw new Error(`Tal already exists at ${talAddress()}`);
  const insa = read("91342.insa.json");
  const deployer = config.wallets.deployer;
  if (!insa || !deployer) throw new Error("need 91342.insa.json and the deployer key");
  const gtd = pointsWallets();
  const gtdUrl = store({ kind: "allowlist", addresses: gtd });
  const s = TAL_SCHEDULE;
  const phases = [
    { start: BigInt(s.gtd), end: BigInt(s.allowlist), price: 0n, perWallet: 1, root: merkleRoot(gtd) },
    { start: BigInt(s.allowlist), end: BigInt(s.publicAt), price: parseEther("0.0005"), perWallet: 3, root: merkleRoot(gtd) },
    { start: BigInt(s.publicAt), end: 0n, price: parseEther("0.001"), perWallet: 5, root: zeroHash },
  ];
  const contractURI = SITE + store(collectionDoc({ "0": gtdUrl, "1": gtdUrl }));
  const cfg = { name: "Tal", symbol: "TAL", creator: deployer.address, payout: deployer.address, maxSupply: 1000, royaltyBps: 500, baseURI: "", contractURI, renderer: insa.talRenderer as Address };
  const { hash, result } = await write({ key: deployer.key, address: insa.insaFactory, abi: dropAbi, functionName: "create", args: [cfg, phases] });
  writeFileSync(`${deployments}/91342.tal.json`, JSON.stringify({ tal: result }, null, 2) + "\n");
  console.log("Tal", result, explorerTx(hash), `${gtd.length} guaranteed wallets`);
}

export function talTask(store_: Store): Task {
  const deployer = config.wallets.deployer!;
  return {
    id: "nft:tal",
    title: "탈 Tal: allowlist, reveal, income",
    everyMs: 10 * 60_000,
    lane: `giwa:${deployer.address}`,
    async run() {
      const tal = talAddress();
      if (!tal) return { summary: "no Tal drop yet" };
      const now = Math.floor(Date.now() / 1000);
      const done: string[] = [];
      try {
        // Allowlist: everyone with points, re-set until 15 minutes before the phase opens.
        const phases = await giwa.readContract({ address: tal, abi: dropAbi, functionName: "phases" });
        const al = phases[1];
        if (al && Number(al.start) - now > 15 * 60) {
          const list = pointsWallets();
          const root = merkleRoot(list);
          if (root !== al.root) {
            const url = store({ kind: "allowlist", addresses: list });
            const gtdUrl = (await currentLists(tal))["0"]!;
            await write({ key: deployer.key, address: tal, abi: dropAbi, functionName: "setPhase", args: [1n, { ...al, root }] });
            await write({ key: deployer.key, address: tal, abi: dropAbi, functionName: "setContractURI", args: [SITE + store(collectionDoc({ "0": gtdUrl, "1": url }))] });
            done.push(`allowlist → ${list.length} wallets`);
          }
        }
        // When a phase opens, a team wallet mints one to prove the phase works end to end
        // (the allowlist proof included), and Telegram hears about it either way.
        const farm = config.wallets.farm[0];
        for (const [i, p] of phases.entries()) {
          const key = `tal:smoke:${i}`;
          if (!farm || store_.get<boolean>(key) || now < Number(p.start) || (p.end !== 0n && now >= Number(p.end))) continue;
          store_.set(key, true);
          try {
            const proof = p.root === zeroHash ? [] : merkleProof(await allowlistOf(tal, i), farm.address);
            if (proof === null) throw new Error("team wallet not on this phase's list");
            const { hash } = await write({ key: farm.key, address: tal, abi: dropAbi, functionName: "mint", args: [BigInt(i), 1n, proof], value: p.price });
            done.push(`phase ${i + 1} OPEN, test mint ok ${explorerTx(hash)}`);
          } catch (err) {
            return { summary: `Tal phase ${i + 1} opened but the test mint FAILED: ${reason(err).slice(0, 120)}`, notify: "alert" };
          }
        }
        // Reveal: at sell-out or REVEAL_AT.
        const [seed, seedBlock, total, max] = await Promise.all([
          giwa.readContract({ address: tal, abi: dropAbi, functionName: "seed" }),
          giwa.readContract({ address: tal, abi: dropAbi, functionName: "seedBlock" }),
          giwa.readContract({ address: tal, abi: dropAbi, functionName: "totalSupply" }),
          giwa.readContract({ address: tal, abi: dropAbi, functionName: "maxSupply" }),
        ]);
        // Reveal at sell-out, or a few days after the last phase opened; never while the dates are TBA.
        const lastStart = Math.max(...phases.map((p) => Number(p.start)));
        const revealAt = lastStart >= TAL_TBA ? Infinity : Math.max(TAL_SCHEDULE.revealAt, lastStart + 86_400);
        if (seed === 0n && total > 0 && (total >= max || now >= revealAt)) {
          const head = await giwa.getBlockNumber();
          if (seedBlock === 0n || head > seedBlock + 256n) {
            await write({ key: deployer.key, address: tal, abi: dropAbi, functionName: "commitSeed" });
            done.push("reveal committed");
          } else if (head > seedBlock) {
            const { hash } = await write({ key: deployer.key, address: tal, abi: dropAbi, functionName: "revealSeed" });
            done.push(`REVEALED ${explorerTx(hash)}`);
          }
        }
        // An announced market fee applies itself once its 48 hours are over (applyFee is open to anyone).
        const insa = read("91342.insa.json");
        if (insa?.insaMarket) {
          const eta = await giwa.readContract({ address: insa.insaMarket, abi: marketFeeAbi, functionName: "pendingEta" });
          if (eta > 0n && BigInt(now) >= eta) {
            await write({ key: deployer.key, address: insa.insaMarket, abi: marketFeeAbi, functionName: "applyFee" });
            done.push(`Insadong market fee now ${(await giwa.readContract({ address: insa.insaMarket, abi: marketFeeAbi, functionName: "feeBps" })) / 100}%`);
          }
        }
        // Mint income, once it is worth the gas.
        const owed = await giwa.readContract({ address: tal, abi: dropAbi, functionName: "creatorOwed" });
        if (owed >= parseEther("0.005")) {
          await write({ key: deployer.key, address: tal, abi: dropAbi, functionName: "withdraw" });
          done.push(`income ${Number(owed) / 1e18} ETH collected`);
        }
        store_.set("tal:last", { at: now, total, done });
        return { summary: done.length ? done.join(" · ") : `Tal ${total}/${max} minted`, notify: done.some((d) => d.startsWith("REVEALED") || d.includes("OPEN") || d.includes("market fee")) ? "info" : undefined };
      } catch (err) {
        return { summary: `Tal: ${reason(err).slice(0, 120)}`, notify: "alert" };
      }
    },
  };
}

async function allowlistOf(tal: Address, phase: number): Promise<Address[]> {
  const url = (await currentLists(tal))[String(phase)];
  if (!url) throw new Error(`no allowlist file for phase ${phase + 1}`);
  return (JSON.parse(readFileSync(resolve(UPLOADS, url.split("/").pop()!), "utf8")) as { addresses: Address[] }).addresses;
}

async function currentLists(tal: Address): Promise<Record<string, string>> {
  const uri = await giwa.readContract({ address: tal, abi: dropAbi, functionName: "contractURI" });
  const file = resolve(UPLOADS, uri.split("/").pop()!);
  return (JSON.parse(readFileSync(file, "utf8")) as { lists?: Record<string, string> }).lists ?? {};
}

/** Re-publish the collection details (same allowlists) after editing collectionDoc. */
export async function refreshTalMeta() {
  const tal = talAddress();
  const deployer = config.wallets.deployer;
  if (!tal || !deployer) throw new Error("no Tal or deployer");
  const uri = SITE + store(collectionDoc(await currentLists(tal)));
  const now = await giwa.readContract({ address: tal, abi: dropAbi, functionName: "contractURI" });
  if (uri === now) return console.log("unchanged");
  const { hash } = await write({ key: deployer.key, address: tal, abi: dropAbi, functionName: "setContractURI", args: [uri] });
  console.log("contractURI", uri, explorerTx(hash));
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "create") await createTal();
if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "meta") await refreshTalMeta();
