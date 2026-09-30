/**
 * Clicks through the live site with a real wallet: a test EIP-1193 provider, injected into the
 * page, signs with a farm key here in Node. Every flow waits for the app's own success toast.
 *   node scripts/ui-e2e.ts <flow,...> [--wallet=2]
 */
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.ts";
import { go } from "./ui-lib.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const RPC = "https://sepolia-rpc.giwa.io";
const chain = { id: 91342, name: "GIWA Sepolia", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
// --wallet=1|2 → FARM1/FARM2, --wallet=t1..t3 → the TRADER wallets.
const which = process.argv.find((a) => a.startsWith("--wallet="))?.split("=")[1] ?? "2";
const key = (which.startsWith("t") ? process.env[`GIWA_TRADER${which.slice(1)}_KEY`] : config.wallets.farm[Number(which) - 1].key) as Hex;
const account = privateKeyToAccount(key);
const L1RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const l1chain = { id: 11155111, name: "Sepolia", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [L1RPC] } } } as const;
const clients = {
  91342: { chain, pub: createPublicClient({ chain, transport: http(RPC, { retryCount: 6, retryDelay: 800 }) }), wal: createWalletClient({ account, chain, transport: http(RPC, { retryCount: 6, retryDelay: 800 }) }) },
  11155111: { chain: l1chain, pub: createPublicClient({ chain: l1chain, transport: http(L1RPC, { retryCount: 6, retryDelay: 800 }) }), wal: createWalletClient({ account, chain: l1chain, transport: http(L1RPC, { retryCount: 6, retryDelay: 800 }) }) },
} as const;
let current: 91342 | 11155111 = 91342;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [account.address];
    case "eth_chainId":
      return `0x${current.toString(16)}`;
    case "net_version":
      return String(current);
    case "wallet_switchEthereumChain": {
      const id = Number((params[0] as { chainId: string }).chainId);
      if (id !== 91342 && id !== 11155111) throw new Error(`unknown chain ${id}`);
      current = id;
      return null;
    }
    case "wallet_addEthereumChain":
    case "wallet_requestPermissions":
      return null;
    case "eth_sendTransaction": {
      const t = params[0] as { to: Hex; data?: Hex; value?: Hex; gas?: Hex };
      // A public RPC that rate-limits the send is retried (a real wallet has its own node); a revert is not.
      const c = clients[current];
      for (let i = 0; ; i++) {
        try {
          return await c.wal.sendTransaction({ account, to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined, gas: t.gas ? BigInt(t.gas) : undefined, chain: c.chain } as never);
        } catch (e) {
          const m = (e as Error).message;
          if (i >= 8 || !/rate limit|RPC Request failed|429|timed out|nonce/i.test(m) || /revert/i.test(m)) throw e;
          await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        }
      }
    }
    case "personal_sign":
      return account.signMessage({ message: { raw: params[0] as Hex } });
    case "eth_signTypedData_v4":
      return account.signTypedData(JSON.parse(params[1] as string));
    default:
      return clients[current].pub.request({ method, params } as never);
  }
}

const INJECT = `
(() => {
  const listeners = {};
  const provider = {
    isMetaMask: false,
    request: async ({ method, params }) => {
      const r = await window.__e2eRpc(method, params ?? []);
      if (r && r.__error) { const e = new Error(r.__error); e.code = 4001; throw e; }
      if (method === "wallet_switchEthereumChain") (listeners.chainChanged ?? []).forEach((f) => f(params[0].chainId));
      return r;
    },
    on: (e, f) => { (listeners[e] ??= []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== f); },
  };
  window.ethereum = provider;
  const info = { uuid: "e2e-wallet", name: "E2E Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "test.e2e" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;

type Page = any;
const results: string[] = [];


async function main() {
  console.log("start");
  const wanted = (process.argv[2] ?? "").split(",").filter(Boolean);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
  await p.exposeFunction("__e2eRpc", async (m: string, params: unknown[]) => {
    try {
      return await rpc(m, params);
    } catch (e) {
      console.log("  RPC-ERR", m, (e as Error).message.replace(/\s+/g, " ").slice(0, 600));
      return { __error: (e as Error).message.slice(0, 300) };
    }
  });
  await p.addInitScript(INJECT);
  p.setDefaultTimeout(30_000);
  p.on("pageerror", (e: Error) => console.log("  PAGEERROR", e.message.slice(0, 300), (e.stack ?? "").split("\n").slice(1, 4).join(" | ")));
  p.on("response", async (r: any) => {
    if (r.status() >= 400) console.log("  HTTP", r.status(), r.url().slice(0, 120), (r.request().postData() ?? "").slice(0, 160));
  });
  await go(p, "#/");
  console.log("wallets seen:", await p.evaluate(() => !!(window as any).ethereum));
  await p.getByRole("button", { name: "Connect wallet" }).first().click();
  await p.waitForTimeout(1000);
  const connected = (await p.textContent("header")) ?? "";
  results.push(`connect: ${connected.includes(account.address.slice(0, 6)) ? "PASS" : "FAIL"}`);
  const all = await import("./ui-flows.ts");
  for (const name of wanted) {
    const f = all.flows[name];
    if (!f) {
      results.push(`${name}: unknown flow`);
      continue;
    }
    try {
      console.log("flow", name);
      results.push(`${name}: PASS ${await f(p)}`);
    } catch (e) {
      await p.screenshot({ path: `/tmp/claude-0/-root/fffb2a43-d9ee-4815-8364-e42aa7bf993f/scratchpad/e2e_${name}.png`, fullPage: true }).catch(() => {});
      results.push(`${name}: FAIL ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
    }
  }
  console.log(`wallet ${account.address}\n` + results.join("\n"));
  await b.close();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
