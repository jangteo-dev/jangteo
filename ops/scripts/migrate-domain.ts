/**
 * Points every Insadong collection whose creator is one of our wallets at jangteo.org: the page
 * details (contractURI) and token metadata (baseURI) are re-stored with the new domain inside,
 * content-addressed as always, and set on-chain by the creator. Dry run unless --send.
 *   node scripts/migrate-domain.ts [--send]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseAbi, type Address, type Hex } from "viem";
import { explorerTx, giwa, write } from "../src/chain.ts";
import { config } from "../src/config.ts";

const OLD = "https://gye.rygroup.asia";
const NEW = "https://jangteo.org";
const UPLOADS = "/srv/jangteo/uploads";
const send = process.argv.includes("--send");
const abi = parseAbi([
  "function creator() view returns (address)",
  "function baseURI() view returns (string)",
  "function contractURI() view returns (string)",
  "function frozen() view returns (bool)",
  "function name() view returns (string)",
  "function setBaseURI(string)",
  "function setContractURI(string)",
  "function drops(uint256) view returns (address)",
  "function dropCount() view returns (uint256)",
]);
const keys = new Map<string, Hex>(
  [config.wallets.deployer, ...config.wallets.farm].filter(Boolean).map((w) => [w!.address.toLowerCase(), w!.key as Hex]),
);

/** Stores a document the way api/nft-json.php does and returns its public URL. */
function store(doc: unknown): string {
  const body = JSON.stringify(doc);
  const h = createHash("sha256").update(body).digest("hex");
  const f = `${UPLOADS}/${h}.json`;
  if (!existsSync(f)) writeFileSync(f, body, { mode: 0o644 });
  return `${NEW}/uploads/${h}.json`;
}
const retarget = (s: string) => s.split(OLD).join(NEW);
const localDoc = (url: string): unknown | null => {
  const m = url.match(/\/uploads\/([0-9a-f]{64})\.json$/);
  return m && existsSync(`${UPLOADS}/${m[1]}.json`) ? JSON.parse(readFileSync(`${UPLOADS}/${m[1]}.json`, "utf8")) : null;
};

/** The same metadata under the new domain, or null when nothing changes. */
function moved(uri: string): string | null {
  if (!uri.includes(OLD)) return null;
  const nft = uri.match(/\/nft\/([0-9a-f]{64})\/$/);
  if (nft) {
    // An uploaded collection: its manifest lists images by URL.
    const m = JSON.parse(readFileSync(`${UPLOADS}/${nft[1]}.json`, "utf8"));
    const doc = JSON.parse(retarget(JSON.stringify(m)));
    const body = JSON.stringify(doc);
    const h = createHash("sha256").update(body).digest("hex");
    if (!existsSync(`${UPLOADS}/${h}.json`)) writeFileSync(`${UPLOADS}/${h}.json`, body, { mode: 0o644 });
    return `${NEW}/nft/${h}/`;
  }
  const doc = localDoc(uri);
  return doc ? store(JSON.parse(retarget(JSON.stringify(doc)))) : retarget(uri);
}

const insa = JSON.parse(readFileSync("../contracts/deployments/91342.insa.json", "utf8"));
const n = await giwa.readContract({ address: insa.insaFactory, abi, functionName: "dropCount" });
for (let i = 0n; i < n; i++) {
  const drop = await giwa.readContract({ address: insa.insaFactory, abi, functionName: "drops", args: [i] });
  const [creator, base, curi, frozen, name] = await Promise.all(
    (["creator", "baseURI", "contractURI", "frozen", "name"] as const).map((functionName) => giwa.readContract({ address: drop, abi, functionName } as never)),
  ) as [Address, string, string, boolean, string];
  const key = keys.get(creator.toLowerCase());
  const nb = moved(base);
  const nc = moved(curi);
  console.log(`${name} ${drop.slice(0, 10)} creator ${key ? "ours" : "someone else"}${frozen ? " FROZEN" : ""}`);
  if (nb) console.log(`  baseURI  ${base}\n        → ${nb}`);
  if (nc) console.log(`  contract ${curi}\n        → ${nc}`);
  if (!send || !key) continue;
  if (nb && !frozen) console.log("  setBaseURI", explorerTx((await write({ key, address: drop, abi, functionName: "setBaseURI", args: [nb] })).hash));
  if (nc) console.log("  setContractURI", explorerTx((await write({ key, address: drop, abi, functionName: "setContractURI", args: [nc] })).hash));
}
