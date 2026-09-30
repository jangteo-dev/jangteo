import { randomBytes } from "node:crypto";
import { keccak256, maxUint256, parseAbi, toHex, type Address, type Hex } from "viem";
import { giwa, reason, write } from "../chain.ts";
import { gyeDeployment, type FarmWallet } from "../config.ts";
import type { Store } from "../engine/db.ts";
import type { Task, TaskResult } from "../engine/scheduler.ts";
import { stallAddresses, yutAbi } from "../stalls.ts";
import { chooseMove } from "./board.ts";

const STAKE = 10_000n * 10n ** 18n;
const CHAIN = 256;
const botAbi = parseAbi([
  "function create(uint128 stake, bytes32 tip, bytes32 salt) returns (uint256)",
  "function throwSticks(uint256 id, bytes32 link)",
  "function move(uint256 id, uint8 slot, uint8 piece)",
  "function pass(uint256 id, uint8 slot)",
  "function claim()",
  "function claimable(address) view returns (uint256)",
]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function drip()",
  "function lastDrip(address) view returns (uint256)",
]);

function chainFrom(secret: Hex): Hex[] {
  const c: Hex[] = [secret];
  for (let k = 1; k <= CHAIN; k++) c.push(keccak256(c[k - 1]));
  return c;
}

/**
 * The house player: keeps one small table open so a visitor always has an opponent, then plays
 * its own turns. Its dice secrets are generated here and kept in the ops store.
 */
export function yutBotTask(bot: FarmWallet, store: Store): Task {
  return {
    id: "yut:bot",
    title: "Yut house bot",
    everyMs: 3_000,
    timeoutMs: 90_000,
    lane: `giwa:${bot.address}`,
    async run(): Promise<TaskResult> {
      const s = stallAddresses();
      const d = gyeDeployment();
      if (!s || !d) return { summary: "not deployed", nextAt: Date.now() + 600_000 };
      const yut = s.yut;
      const me = bot.address.toLowerCase();
      const n = await giwa.readContract({ address: yut, abi: yutAbi, functionName: "gameCount" });
      const from = n > 100n ? n - 100n : 0n;
      const games = await Promise.all(
        Array.from({ length: Number(n - from) }, (_, i) => from + BigInt(i)).map(async (id) => ({
          id,
          g: await giwa.readContract({ address: yut, abi: yutAbi, functionName: "game", args: [id] }),
        })),
      );
      const mine = games.filter(({ g }) => g.players.some((p) => p.toLowerCase() === me));

      // Play every game where it is our move.
      for (const { id, g } of mine) {
        if (g.status !== 2) continue;
        const seat = g.players[0].toLowerCase() === me ? 0 : 1;
        if (g.turn !== seat) continue;
        const secret = store.get<Hex>(`yutbot:secret:${g.salt[seat]}`);
        if (!secret) return { summary: `game #${id}: secret lost, cannot play`, notify: "alert" };
        if (g.phase === 0) {
          const block = await giwa.getBlockNumber();
          if (block < g.lastBlock + 2n) return { summary: `game #${id}: waiting a block`, nextAt: Date.now() + 1500 };
          const link = chainFrom(secret)[CHAIN - (g.throws[seat] + 1)];
          await write({ key: bot.key, address: yut, abi: botAbi, functionName: "throwSticks", args: [id, link] });
          return { summary: `game #${id}: threw`, nextAt: Date.now() + 1500 };
        }
        const pending = g.pending.slice(0, g.pendingCount).map(Number);
        const choice = chooseMove(g.pos.map(Number), g.route.map(Number), pending, seat as 0 | 1);
        if (choice) {
          await write({ key: bot.key, address: yut, abi: botAbi, functionName: "move", args: [id, choice.slot, choice.piece] });
          return { summary: `game #${id}: moved piece ${choice.piece}`, nextAt: Date.now() + 1500 };
        }
        const slot = pending.findIndex((v) => v < 0);
        await write({ key: bot.key, address: yut, abi: botAbi, functionName: "pass", args: [id, Math.max(0, slot)] });
        return { summary: `game #${id}: passed a back-do`, nextAt: Date.now() + 1500 };
      }

      // Collect winnings.
      const prize = await giwa.readContract({ address: yut, abi: botAbi, functionName: "claimable", args: [bot.address] });
      if (prize > 0n) {
        await write({ key: bot.key, address: yut, abi: botAbi, functionName: "claim" });
        return { summary: `collected winnings` };
      }

      // Keep one table open.
      const open = mine.some(({ g }) => g.status === 1 && g.players[0].toLowerCase() === me);
      const playing = mine.filter(({ g }) => g.status === 2).length;
      if (!open && playing < 3) {
        const bal = await giwa.readContract({ address: d.tkrw, abi: erc20, functionName: "balanceOf", args: [bot.address] });
        if (bal < STAKE) {
          try {
            await write({ key: bot.key, address: d.tkrw, abi: erc20, functionName: "drip" });
          } catch (err) {
            return { summary: `no test won for a table (${reason(err)})`, nextAt: Date.now() + 3600_000 };
          }
        }
        const allowance = await giwa.readContract({ address: d.tkrw, abi: erc20, functionName: "allowance", args: [bot.address, yut] });
        if (allowance < STAKE) await write({ key: bot.key, address: d.tkrw, abi: erc20, functionName: "approve", args: [yut, maxUint256] });
        const salt = toHex(randomBytes(32));
        const secret = toHex(randomBytes(32));
        store.set(`yutbot:secret:${salt}`, secret);
        await write({ key: bot.key, address: yut, abi: botAbi, functionName: "create", args: [STAKE, chainFrom(secret)[CHAIN], salt] });
        return { summary: "opened a ₩10,000 table", notify: "info" };
      }
      return { summary: `${playing} playing, table ${open ? "open" : "full"}`, nextAt: Date.now() + (playing ? 3000 : 20_000) };
    },
  };
}
