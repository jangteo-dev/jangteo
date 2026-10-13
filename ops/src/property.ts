import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { encodeAbiParameters, parseAbi, type Address, type Hex } from "viem";
import { explorerTx, giwa, reason, write } from "./chain.ts";
import { config } from "./config.ts";
import type { Store } from "./engine/db.ts";
import type { Task, TaskResult } from "./engine/scheduler.ts";

const exec = promisify(execFile);

/** The live registry (30-day rent) unless a file name is given (the e2e registry is `property-e2e`). */
export function propertyAddress(file = "property"): Address | null {
  const p = resolve(config.root, `../contracts/deployments/91342.${file}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { property: Address }).property : null;
}

export const propertyAbi = parseAbi([
  "struct Property { address share; address issuer; uint8 status; bool verified; uint16 saleBps; uint16 tradeBps; uint16 exitBps; uint256 totalShares; uint256 minShares; uint256 price; uint256 endAt; uint256 rentPerPeriod; uint256 reserveMonths; uint256 sold; uint256 activatedAt; uint256 lastPeriodAt; uint256 reserve; uint256 due; uint256 accPerShare; uint256 rentPaid; uint256 rentUnclaimed; uint256 refundable; uint256 salePrice; uint256 pool; uint256 exitSupply; uint256 redeemed; }",
  "struct Terms { uint256 totalShares; uint256 minShares; uint256 price; uint256 duration; uint256 rentPerPeriod; uint256 reserveMonths; }",
  "function count() view returns (uint256)",
  "function property(uint256 id) view returns (Property)",
  "function metadata(uint256 id) view returns (string)",
  "function period() view returns (uint256)",
  "function eligibleShares(uint256 id) view returns (uint256)",
  "function feesAccrued() view returns (uint256)",
  "function claimable(uint256 id, address who) view returns (uint256)",
  "function listingCount() view returns (uint256)",
  "function create(Terms t, string meta) returns (uint256)",
  "function setVerified(uint256 id, bool v)",
  "function buy(uint256 id, uint256 shares)",
  "function finalize(uint256 id)",
  "function cancel(uint256 id)",
  "function refund(uint256 id)",
  "function accrue(uint256 id)",
  "function fundReserve(uint256 id, uint256 amount)",
  "function claimRent(uint256 id) returns (uint256)",
  "function list(uint256 id, uint256 shares, uint256 price) returns (uint256)",
  "function buyListing(uint256 lid, uint256 shares)",
  "function cancelListing(uint256 lid)",
  "function sell(uint256 id, uint256 amount)",
  "function redeem(uint256 id, uint256 shares) returns (uint256)",
  "function sweepFees()",
  "event Bought(uint256 indexed id, address indexed buyer, uint256 shares, uint256 paid)",
  "event ListingFilled(uint256 indexed listing, uint256 indexed id, address indexed buyer, uint256 shares, uint256 paid, uint256 fee)",
  "event RentClaimed(uint256 indexed id, address indexed holder, uint256 amount)",
  "event Created(uint256 indexed id, address indexed issuer, address share, string metadata)",
]);

export const PS = { Funding: 1, Active: 2, Failed: 3, Sold: 4 } as const;

/** What one keeper pass should do for a property, decided from its state alone (pure, tested). */
export function propertyAction(
  p: { status: number; sold: bigint; totalShares: bigint; endAt: bigint; rentPerPeriod: bigint; lastPeriodAt: bigint; reserve: bigint; due: bigint },
  now: number,
  period: bigint,
  eligible: bigint,
): "finalize" | "accrue" | null {
  const t = BigInt(now);
  if (p.status === PS.Funding) return p.sold >= p.totalShares || t >= p.endAt ? "finalize" : null;
  if (p.status !== PS.Active || p.rentPerPeriod === 0n) return null;
  if (t >= p.lastPeriodAt + period) return "accrue"; // a period passed: book it (and pay what the reserve covers)
  if (p.due > 0n && p.reserve > 0n && eligible > 0n) return "accrue"; // rent was waiting for eligible shares
  return null;
}

/**
 * 장터 부동산 keeper. Closes every sale whose deadline passed (so buyers never wait on someone to
 * press a button), and books rent the moment a period passes so holders see it without claiming.
 * Both calls are permissionless; the keeper only pays gas.
 */
export function propertyKeeperTask(keeper: { address: Address; key: Hex }, file = "property"): Task {
  return {
    id: file === "property" ? "property:keeper" : `${file}:keeper`,
    title: "Property keeper",
    everyMs: file === "property" ? 5 * 60_000 : 60_000,
    jitterMs: 10_000,
    timeoutMs: 5 * 60_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const addr = propertyAddress(file);
      if (!addr) return { summary: "Property not deployed", nextAt: Date.now() + 30 * 60_000 };
      const [n, period] = await Promise.all([
        giwa.readContract({ address: addr, abi: propertyAbi, functionName: "count" }),
        giwa.readContract({ address: addr, abi: propertyAbi, functionName: "period" }),
      ]);
      // Chain time, not ours: the newest block can trail the wall clock by a few seconds, and a
      // finalize sent before the block passes endAt would only revert with NotYet.
      const now = Number((await giwa.getBlock()).timestamp);
      const done: string[] = [];
      let active = 0;
      for (let id = 0n; id < n; id++) {
        const p = await giwa.readContract({ address: addr, abi: propertyAbi, functionName: "property", args: [id] });
        if (p.status === PS.Active) active++;
        const eligible = p.status === PS.Active ? await giwa.readContract({ address: addr, abi: propertyAbi, functionName: "eligibleShares", args: [id] }) : 0n;
        const act = propertyAction(p, now, period, eligible);
        if (!act) continue;
        try {
          const { hash } = await write({ key: keeper.key, address: addr, abi: propertyAbi, functionName: act, args: [id] });
          done.push(`#${id} ${act} ${explorerTx(hash)}`);
        } catch (err) {
          // GIWA reads can lag a block behind a fresh write: a "NotYet" here is retried next pass.
          done.push(`#${id} ${act} skipped: ${reason(err).slice(0, 80)}`);
        }
      }
      return { summary: done.length ? done.join("\n") : `${n} properties, ${active} earning rent, nothing due` };
    },
  };
}

/** Each property's share token is created by the registry; keep them verified on the explorer. */
export function propertyVerifyTask(store: Store): Task {
  return {
    id: "property:verify",
    title: "Property share verification",
    everyMs: 20 * 60_000,
    jitterMs: 60_000,
    timeoutMs: 10 * 60_000,
    lane: "forge",
    async run(): Promise<TaskResult> {
      const out: string[] = [];
      const done = new Set(store.get<string[]>("property:verified") ?? []);
      for (const file of ["property", "property-e2e"]) {
        const addr = propertyAddress(file);
        if (!addr) continue;
        const n = await giwa.readContract({ address: addr, abi: propertyAbi, functionName: "count" });
        for (let id = 0n; id < n; id++) {
          const p = await giwa.readContract({ address: addr, abi: propertyAbi, functionName: "property", args: [id] });
          const share = p.share.toLowerCase();
          if (done.has(share)) continue;
          const args = encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "uint256" }], [`Jangteo Property #${id}`, `JPROP${id}`, id]);
          try {
            await exec(
              "forge",
              ["verify-contract", p.share, "src/property/PropertyShare.sol:PropertyShare", "--verifier", "blockscout", "--verifier-url", "https://sepolia-explorer.giwa.io/api/", "--constructor-args", args, "--watch"],
              { cwd: resolve(config.root, "../contracts"), timeout: 180_000 },
            );
            done.add(share);
            out.push(`verified JPROP${id} (${file})`);
          } catch (err) {
            const msg = reason(err);
            if (/already verified/i.test(msg)) done.add(share);
            else out.push(`JPROP${id}: ${msg.slice(0, 100)}`);
          }
        }
      }
      store.set("property:verified", [...done]);
      return { summary: out.length ? out.join("\n") : `all property shares verified (${done.size})` };
    },
  };
}
