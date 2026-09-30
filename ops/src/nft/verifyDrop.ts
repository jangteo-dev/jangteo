import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { encodeAbiParameters, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { giwa } from "../chain.ts";
import { config } from "../config.ts";

const views = parseAbi([
  "struct Phase { uint64 start; uint64 end; uint128 price; uint32 perWallet; bytes32 root; }",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function creator() view returns (address)",
  "function payout() view returns (address)",
  "function maxSupply() view returns (uint32)",
  "function royaltyBps() view returns (uint16)",
  "function baseURI() view returns (string)",
  "function contractURI() view returns (string)",
  "function renderer() view returns (address)",
  "function treasury() view returns (address)",
  "function platformBps() view returns (uint16)",
  "function phases() view returns (Phase[])",
]);

/**
 * The constructor arguments of an InsaDrop, rebuilt from its state. Exact only while nothing has
 * changed since launch (creator, phases, metadata), which is when drops are verified.
 */
export async function dropCtorArgs(drop: Address): Promise<Hex> {
  const r = <T>(functionName: string) => giwa.readContract({ address: drop, abi: views, functionName } as never) as Promise<T>;
  const [name, symbol, creator, payout, max, roy, base, curi, rend, tre, pbps, phases] = await Promise.all([
    r<string>("name"), r<string>("symbol"), r<Address>("creator"), r<Address>("payout"), r<number>("maxSupply"), r<number>("royaltyBps"),
    r<string>("baseURI"), r<string>("contractURI"), r<Address>("renderer"), r<Address>("treasury"), r<number>("platformBps"),
    r<{ start: bigint; end: bigint; price: bigint; perWallet: number; root: Hex }[]>("phases"),
  ]);
  return encodeAbiParameters(parseAbiParameters("(string,string,address,address,uint32,uint16,string,string,address), (uint64,uint64,uint128,uint32,bytes32)[], address, uint16"), [
    [name, symbol, creator, payout, max, roy, base, curi, rend],
    phases.map((p) => [p.start, p.end, p.price, p.perWallet, p.root] as const),
    tre,
    pbps,
  ]);
}

/** Verify a drop on the GIWA explorer through forge (Blockscout). */
export async function verifyDrop(drop: Address): Promise<boolean> {
  const args = await dropCtorArgs(drop);
  try {
    execFileSync("forge", ["verify-contract", "--chain", "91342", "--verifier", "blockscout", "--verifier-url", "https://sepolia-explorer.giwa.io/api/", drop, "InsaDrop", "--constructor-args", args], {
      cwd: resolve(config.root, "../contracts"),
      stdio: "pipe",
      timeout: 240_000,
    });
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2]) console.log(await verifyDrop(process.argv[2] as Address));
