// Live run of 장터 펌프 through graduation on GIWA Sepolia: FARM1 launches, three trader wallets
// buy and sell in turn until the curve reaches 4.2 ETH, then keep trading on the 장터 스왑 pool
// through the Pump router. Every step logs price, progress and what came back.
// cd ops && node scripts/e2e-pump-graduate.ts
import { formatEther, maxUint256, parseAbi, parseEther, type Address, type Hex } from "viem";
import { giwa, write } from "../src/chain.ts";
import { config } from "../src/config.ts";
import { pumpAbi, pumpAddresses } from "../src/pump.ts";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const traders = [1, 2, 3].map((i) => ({ label: `T${i}`, address: env(`GIWA_TRADER${i}_ADDRESS`) as Address, key: env(`GIWA_TRADER${i}_KEY`) as Hex }));
const creator = config.wallets.farm[0];
const { pump, pumpRouter } = pumpAddresses()!;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const p = parseAbi([
  "function create(string,string,string) payable returns (address)",
  "function buy(address,uint256,uint256) payable returns (uint256)",
  "function sell(address,uint256,uint256,uint256) returns (uint256)",
  "function quoteBuy(address,uint256) view returns (uint256,uint256,uint256)",
  "function price(address) view returns (uint256)",
  "function progressBps(address) view returns (uint256)",
  "function tokenCount() view returns (uint256)",
  "function tokens(uint256) view returns (address)",
]);
const r = parseAbi([
  "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256,uint256,address[],address,uint256) returns (uint256[])",
]);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 900);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

async function state(token: Address) {
  const [price, prog, l] = await Promise.all([
    giwa.readContract({ address: pump, abi: p, functionName: "price", args: [token] }),
    giwa.readContract({ address: pump, abi: p, functionName: "progressBps", args: [token] }),
    giwa.readContract({ address: pump, abi: pumpAbi, functionName: "launch", args: [token] }),
  ]);
  return { price: Number(formatEther(price)), progress: Number(prog) / 100, graduated: l.graduated, realEth: formatEther(l.realEth) };
}

// Wait for the bridged ETH.
for (let i = 0; ; i++) {
  const bals = await Promise.all(traders.map((t) => giwa.getBalance({ address: t.address })));
  log("trader balances", bals.map((b) => formatEther(b)).join(" / "));
  if (bals.every((b) => b >= parseEther("2"))) break;
  if (i > 60) throw new Error("bridge did not arrive");
  await sleep(15_000);
}

await write({
  key: creator.key,
  address: pump,
  abi: p,
  functionName: "create",
  args: ["Bibimbap Club", "BBMP", JSON.stringify({ about: "Everything in one bowl. The first 장터 펌프 token to graduate on GIWA Sepolia." })],
  value: parseEther("0.01"),
});
await sleep(3000);
const n = await giwa.readContract({ address: pump, abi: p, functionName: "tokenCount" });
const token = await giwa.readContract({ address: pump, abi: p, functionName: "tokens", args: [n - 1n] });
log("launched BBMP", token, await state(token));

for (const t of traders) await write({ key: t.key, address: token, abi: erc, functionName: "approve", args: [pump, maxUint256] });
for (const t of traders) await write({ key: t.key, address: token, abi: erc, functionName: "approve", args: [pumpRouter, maxUint256] });
await sleep(3000);

// ── on the curve ──
let step = 0;
while (!(await state(token)).graduated && step < 60) {
  const t = traders[step % 3];
  const bal = await giwa.readContract({ address: token, abi: erc, functionName: "balanceOf", args: [t.address] });
  const sell = bal > 0n && rnd() < 0.3;
  try {
    if (sell) {
      const amt = (bal * BigInt(Math.floor(15 + rnd() * 30))) / 100n;
      await write({ key: t.key, address: pump, abi: p, functionName: "sell", args: [token, amt, 0n, dl()] });
      log(`${t.label} sold ${formatEther(amt).slice(0, 10)}M-ish tokens`, await state(token));
    } else {
      const eth = parseEther((0.12 + rnd() * 0.45).toFixed(3));
      const before = await giwa.getBalance({ address: t.address });
      await write({ key: t.key, address: pump, abi: p, functionName: "buy", args: [token, 0n, dl()], value: eth });
      const s = await state(token);
      const spent = before - (await giwa.getBalance({ address: t.address }));
      log(`${t.label} bought with ${formatEther(eth)} ETH (spent ${formatEther(spent).slice(0, 8)} incl. gas)`, s);
      if (s.graduated) log("GRADUATED on this buy — change came back to", t.label);
    }
  } catch (err) {
    log(`${t.label} step failed: ${String((err as Error).message).split("\n")[0]}`);
  }
  step++;
  await sleep(8000 + rnd() * 12000);
}

// ── on the pool, through the same router ──
log("now trading on 장터 스왑 through the Pump router");
for (let i = 0; i < 6; i++) {
  const t = traders[i % 3];
  try {
    if (i % 3 === 2) {
      const bal = await giwa.readContract({ address: token, abi: erc, functionName: "balanceOf", args: [t.address] });
      await write({ key: t.key, address: pumpRouter, abi: r, functionName: "swapExactTokensForETH", args: [bal / 5n, 0n, [token, WETH], t.address, dl()] });
      log(`${t.label} sold 20% on the pool`);
    } else {
      const eth = parseEther((0.03 + rnd() * 0.08).toFixed(3));
      await write({ key: t.key, address: pumpRouter, abi: r, functionName: "swapExactETHForTokens", args: [0n, [WETH, token], t.address, dl()], value: eth });
      log(`${t.label} bought on the pool with ${formatEther(eth)} ETH`);
    }
  } catch (err) {
    log(`${t.label} pool step failed: ${String((err as Error).message).split("\n")[0]}`);
  }
  await sleep(10_000);
}
log("done. token page: https://jangteo.org/#/ppeongtwigi/" + token);
