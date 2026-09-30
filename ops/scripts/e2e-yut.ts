// Live end-to-end check: FARM1 sits at an open 윷 table (the house bot's) and plays to the end.
// cd ops && node scripts/e2e-yut.ts
import { randomBytes } from "node:crypto";
import { keccak256, maxUint256, parseAbi, toHex, type Hex } from "viem";
import { giwa, write } from "../src/chain.ts";
import { config, gyeDeployment } from "../src/config.ts";
import { stallAddresses, yutAbi } from "../src/stalls.ts";
import { chooseMove } from "../src/yut/board.ts";

const me = config.wallets.farm.find((f) => f.label === "FARM1")!;
const { yut } = stallAddresses()!;
const tkrw = gyeDeployment()!.tkrw;
const abi = parseAbi(["function join(uint256,bytes32,bytes32)", "function throwSticks(uint256,bytes32)", "function move(uint256,uint8,uint8)", "function pass(uint256,uint8)", "function claim()", "function claimable(address) view returns (uint256)"]);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function drip()"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const n = await giwa.readContract({ address: yut, abi: yutAbi, functionName: "gameCount" });
let id = -1n;
for (let i = n - 1n; i >= 0n; i--) {
  const g = await giwa.readContract({ address: yut, abi: yutAbi, functionName: "game", args: [i] });
  if (g.status === 1 && g.players[0].toLowerCase() !== me.address.toLowerCase()) { id = i; break; }
}
if (id < 0n) throw new Error("no open table");
if ((await giwa.readContract({ address: tkrw, abi: erc, functionName: "balanceOf", args: [me.address] })) < 10n ** 22n) await write({ key: me.key, address: tkrw, abi: erc, functionName: "drip" });
await write({ key: me.key, address: tkrw, abi: erc, functionName: "approve", args: [yut, maxUint256] });
await sleep(1500);
const secret = toHex(randomBytes(32)) as Hex;
const chain: Hex[] = [secret];
for (let k = 1; k <= 256; k++) chain.push(keccak256(chain[k - 1]));
await write({ key: me.key, address: yut, abi, functionName: "join", args: [id, chain[256], toHex(randomBytes(32))] });
console.log("joined game", id);
const start = await giwa.readContract({ address: tkrw, abi: erc, functionName: "balanceOf", args: [me.address] });
let actions = 0;
for (let step = 0; step < 600; step++) {
  const g = await giwa.readContract({ address: yut, abi: yutAbi, functionName: "game", args: [id] });
  // Reads can land on an RPC node a block behind: right after joining it may still say "Open".
  if (g.status === 1) { await sleep(1000); continue; }
  if (g.status !== 2) {
    console.log("finished. winner", g.winner === me.address ? "FARM1" : "BOT", "after", actions, "of our actions, throws", g.throws);
    const prize = await giwa.readContract({ address: yut, abi, functionName: "claimable", args: [me.address] });
    console.log("FARM1 claimable", prize);
    break;
  }
  const seat = g.players[0].toLowerCase() === me.address.toLowerCase() ? 0 : 1;
  if (g.turn !== seat) { await sleep(1500); continue; }
  try {
    if (g.phase === 0) {
      if ((await giwa.getBlockNumber()) < g.lastBlock + 2n) { await sleep(700); continue; }
      await write({ key: me.key, address: yut, abi, functionName: "throwSticks", args: [id, chain[256 - (g.throws[seat] + 1)]] });
    } else {
      const pending = g.pending.slice(0, g.pendingCount).map(Number);
      const c = chooseMove(g.pos.map(Number), g.route.map(Number), pending, seat as 0 | 1);
      if (c) await write({ key: me.key, address: yut, abi, functionName: "move", args: [id, c.slot, c.piece] });
      else await write({ key: me.key, address: yut, abi, functionName: "pass", args: [id, Math.max(0, pending.findIndex((v) => v < 0))] });
    }
    actions++;
  } catch (e) { console.log("retry:", String((e as Error).message).slice(0, 90)); await sleep(1500); }
}
process.exit(0);
