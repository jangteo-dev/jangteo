// Push every Tal phase that has not started to a placeholder date far ahead (dates to be announced).
import { explorerTx, giwa, write } from "../src/chain.ts";
import { config } from "../src/config.ts";
import { dropAbi, talAddress } from "../src/nft/tal.ts";
export const TBA = 1830297600n; // 2028-01-01 00:00 UTC: "date to be announced"
const tal = talAddress()!;
const d = config.wallets.deployer!;
const phases = await giwa.readContract({ address: tal, abi: dropAbi, functionName: "phases" });
for (const [i, p] of phases.entries()) {
  const start = TBA + BigInt(i) * 86_400n;
  const end = p.end === 0n ? 0n : start + (p.end - p.start);
  if (p.start >= TBA) continue;
  const { hash } = await write({ key: d.key, address: tal, abi: dropAbi, functionName: "setPhase", args: [BigInt(i), { ...p, start, end }] });
  console.log(`phase ${i} → TBA`, explorerTx(hash));
}
console.log((await giwa.readContract({ address: tal, abi: dropAbi, functionName: "phases" })).map((p) => `${p.start}-${p.end}`).join(" | "));
