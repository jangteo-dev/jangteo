import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi, type Address, type Hex } from "viem";
import { explorerTx, giwa, reason, write } from "./chain.ts";
import { config } from "./config.ts";
import type { Task, TaskResult } from "./engine/scheduler.ts";

export function stallAddresses(): { cheongyak: Address; yut: Address; tokenFactory: Address } | null {
  const p = resolve(config.root, "../contracts/deployments/91342.stalls.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { cheongyak: Address; yut: Address; tokenFactory: Address }) : null;
}

export function launchpadAddresses(): { cheongyakV2: Address; swapFactory: Address; swapRouter: Address } | null {
  const p = resolve(config.root, "../contracts/deployments/91342.launchpad.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { cheongyakV2: Address; swapFactory: Address; swapRouter: Address }) : null;
}

/** 청약 v2 keeps the v1 settlement flow but nests its terms and escrows fees per quote token. */
export const cheongyakV2Abi = parseAbi([
  "struct Terms { address token; address quote; bytes32 name; uint128 totalTokens; uint128 price; uint64 startAt; uint64 endAt; uint16 equalBps; uint128 minDeposit; uint128 maxDeposit; uint128 softCap; uint16 tgeBps; uint32 cliff; uint32 vesting; uint16 liqBps; uint32 lpLock; }",
  "struct Offering { Terms t; address issuer; uint16 feeBps; uint8 status; bool verified; uint32 subscribers; uint128 totalDeposit; uint128 liqEscrow; uint8 pass; uint32 cursor; uint128 equalEach; uint128 sumEqual; uint256 sumRemainder; uint256 ratioWad; uint128 allocated; uint128 raised; uint64 settledAt; bool issuerPaid; address pair; uint256 lpAmount; uint128 liqQuote; uint128 liqTokens; bool lpWithdrawn; }",
  "function offeringCount() view returns (uint256)",
  "function offering(uint256 id) view returns (Offering)",
  "function settle(uint256 id, uint32 batch)",
  "function payIssuer(uint256 id)",
  "function feesAccrued(address quote) view returns (uint256)",
  "function sweepFees(address quote)",
]);

export const cheongyakAbi = parseAbi([
  "function offeringCount() view returns (uint256)",
  "function offering(uint256 id) view returns ((address issuer,address token,bytes32 name,uint128 totalTokens,uint128 price,uint64 startAt,uint64 endAt,uint16 equalBps,uint16 feeBps,uint128 minDeposit,uint128 maxDeposit,uint8 status,uint32 subscribers,uint128 totalDeposit,uint8 pass,uint32 cursor,uint128 equalEach,uint128 sumEqual,uint256 sumRemainder,uint256 ratioWad,uint128 allocated,uint128 raised,bool issuerPaid))",
  "function settle(uint256 id, uint32 batch)",
  "function payIssuer(uint256 id)",
  "function feesAccrued() view returns (uint256)",
  "function sweepFees()",
]);

export const yutAbi = parseAbi([
  "function gameCount() view returns (uint256)",
  "function game(uint256 id) view returns ((address[2] players,uint128 stake,uint8 status,uint8 turn,uint8 phase,uint8 extra,uint8 pendingCount,uint64 deadline,uint64 lastBlock,address winner,uint16 feeBps,bytes32[2] link,bytes32[2] salt,uint16[2] throws,int8[8] pending,uint8[8] pos,uint8[8] route))",
  "function claimTimeout(uint256 id)",
  "function feesAccrued() view returns (uint256)",
  "function sweepFees()",
]);

const CY = { Scheduled: 1, Settling: 2, Settled: 3, Failed: 4 } as const;
// Wall clock runs a little ahead of GIWA block time: settling right at endAt reverts NotEnded.

const bytes32Name = (h: Hex) => Buffer.from(h.slice(2), "hex").toString("utf8").replace(/\0+$/, "");

/** 청약 v2: settle (which also seeds the 장터 스왑 pool) and pay issuers; failed soft caps are reported. */
async function settleV2(keeper: { address: Address; key: Hex }, address: Address, now: number, done: string[]): Promise<bigint> {
  const n = await giwa.readContract({ address, abi: cheongyakV2Abi, functionName: "offeringCount" });
  for (let id = 0n; id < n; id++) {
    let o = await giwa.readContract({ address, abi: cheongyakV2Abi, functionName: "offering", args: [id] });
    const name = bytes32Name(o.t.name);
    if ((o.status === CY.Scheduled || o.status === CY.Settling) && now >= Number(o.t.endAt) + 10) {
      for (let i = 0; i < 50 && (o.status === CY.Scheduled || o.status === CY.Settling); i++) {
        await write({ key: keeper.key, address, abi: cheongyakV2Abi, functionName: "settle", args: [id, 150] });
        o = await giwa.readContract({ address, abi: cheongyakV2Abi, functionName: "offering", args: [id] });
      }
      if (o.status === CY.Settled)
        done.push(`v2 #${id} ${name} settled: ${o.subscribers} subscribers${o.lpAmount > 0n ? " · pool seeded, LP locked" : o.t.liqBps ? " · pool skipped (price moved)" : ""}`);
      if (o.status === CY.Failed) done.push(`v2 #${id} ${name} missed its soft cap: deposits refundable`);
    }
    if (o.status === CY.Settled && !o.issuerPaid) {
      const { hash } = await write({ key: keeper.key, address, abi: cheongyakV2Abi, functionName: "payIssuer", args: [id] });
      done.push(`v2 #${id} ${name} issuer paid ${explorerTx(hash)}`);
    }
  }
  return n;
}

/** Runs 청약 settlement in batches once a window closes, then pays the issuer. */
export function cheongyakTask(keeper: { address: Address; key: Hex }): Task {
  return {
    id: "cheongyak:settle",
    title: "Offering settlement",
    everyMs: 2 * 60_000,
    jitterMs: 10_000,
    timeoutMs: 10 * 60_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const s = stallAddresses();
      if (!s) return { summary: "Offerings not deployed", nextAt: Date.now() + 10 * 60_000 };
      const n = await giwa.readContract({ address: s.cheongyak, abi: cheongyakAbi, functionName: "offeringCount" });
      const now = Date.now() / 1000;
      const done: string[] = [];
      for (let id = 0n; id < n; id++) {
        let o = await giwa.readContract({ address: s.cheongyak, abi: cheongyakAbi, functionName: "offering", args: [id] });
        const name = Buffer.from(o.name.slice(2), "hex").toString("utf8").replace(/\0+$/, "");
        if ((o.status === CY.Scheduled || o.status === CY.Settling) && now >= Number(o.endAt) + 10) {
          for (let i = 0; i < 50 && o.status !== CY.Settled; i++) {
            await write({ key: keeper.key, address: s.cheongyak, abi: cheongyakAbi, functionName: "settle", args: [id, 150] });
            o = await giwa.readContract({ address: s.cheongyak, abi: cheongyakAbi, functionName: "offering", args: [id] });
          }
          if (o.status === CY.Settled) done.push(`#${id} ${name} settled: ${o.subscribers} subscribers`);
        }
        if (o.status === CY.Settled && !o.issuerPaid) {
          const { hash } = await write({ key: keeper.key, address: s.cheongyak, abi: cheongyakAbi, functionName: "payIssuer", args: [id] });
          done.push(`#${id} ${name} issuer paid ${explorerTx(hash)}`);
        }
      }
      const lp = launchpadAddresses();
      const n2 = lp ? await settleV2(keeper, lp.cheongyakV2, now, done) : 0n;
      return done.length ? { summary: done.join("\n"), notify: "info" } : { summary: `${n + n2} offerings, nothing to settle` };
    },
  };
}

/** Ends 윷놀이 games whose player to move ran out of time, so stakes never sit stuck. */
export function yutTimeoutTask(keeper: { address: Address; key: Hex }): Task {
  return {
    id: "yut:timeouts",
    title: "Yut timeouts",
    everyMs: 60_000,
    jitterMs: 5_000,
    lane: `giwa:${keeper.address}`,
    async run(): Promise<TaskResult> {
      const s = stallAddresses();
      if (!s) return { summary: "Yut not deployed", nextAt: Date.now() + 10 * 60_000 };
      const n = await giwa.readContract({ address: s.yut, abi: yutAbi, functionName: "gameCount" });
      const now = Date.now() / 1000;
      let playing = 0;
      const ended: string[] = [];
      // Only recent games can still be running; scan the last 200.
      for (let id = n > 200n ? n - 200n : 0n; id < n; id++) {
        const g = await giwa.readContract({ address: s.yut, abi: yutAbi, functionName: "game", args: [id] });
        if (g.status !== 2) continue;
        playing++;
        if (now <= Number(g.deadline) + 5) continue;
        try {
          const { hash } = await write({ key: keeper.key, address: s.yut, abi: yutAbi, functionName: "claimTimeout", args: [id] });
          ended.push(`#${id} ended on time ${explorerTx(hash)}`);
        } catch (err) {
          ended.push(`#${id}: ${reason(err)}`);
        }
      }
      return ended.length ? { summary: ended.join("\n"), notify: "info" } : { summary: `${n} games, ${playing} playing` };
    },
  };
}
