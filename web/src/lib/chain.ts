import { createPublicClient, http, fallback, type Address } from "viem";
import { giwaSepolia } from "viem/chains";

export const chain = giwaSepolia;
export const explorer = "https://sepolia-explorer.giwa.io";

export const client = createPublicClient({
  chain,
  transport: import.meta.env.VITE_RPC_URL
    ? http(import.meta.env.VITE_RPC_URL)
    : fallback([http("https://sepolia-rpc.giwa.io"), http("https://sepolia-rpc-flashblocks.giwa.io")]),
  batch: { multicall: true },
});

/**
 * A receipt, once the node answering our reads has also seen its block. GIWA's public RPC is a pool
 * of nodes; a read right after a transaction (an allowance after an approve) can land on one that
 * is a block behind, and the next step would be simulated against the old state and refused.
 */
/**
 * Logs over a long block range. GIWA's main RPC answers at most 10,000 blocks per request; the
 * flashblocks endpoint still takes 100,000. Big chunks there first, small ones anywhere if refused.
 */
const logClient = createPublicClient({ chain, transport: http("https://sepolia-rpc-flashblocks.giwa.io", { retryCount: 4, retryDelay: 600 }) });
export async function logsInRange<T>(from: bigint, to: bigint, get: (c: typeof client, a: bigint, b: bigint) => Promise<T[]>): Promise<T[]> {
  const run = async (c: typeof client, step: bigint) => {
    const out: T[] = [];
    for (let a = from; a <= to; a += step) out.push(...(await get(c, a, a + step - 1n > to ? to : a + step - 1n)));
    return out;
  };
  try {
    return await run(logClient as typeof client, 100_000n);
  } catch {
    return run(client, 10_000n);
  }
}

/**
 * Links Jangteo wrote before its move to jangteo.org (token images, NFT metadata recorded on-chain)
 * point at the retired gye.rygroup.asia; the same files live on under jangteo.org.
 */
export const currentUrl = (u: string) => u.replace(/^https:\/\/gye\.rygroup\.asia\//, "https://jangteo.org/");

const balAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;

/** Stops before any approval when the wallet can't cover the amount (named so friendlyError can explain it). */
export async function mustHold(token: Address, owner: Address, amount: bigint) {
  const bal = await client.readContract({ address: token, abi: balAbi, functionName: "balanceOf", args: [owner] });
  if (bal < amount) throw new Error("NotEnoughBalance");
}

export async function confirmed(hash: `0x${string}`) {
  const rc = await client.waitForTransactionReceipt({ hash });
  for (let i = 0; i < 16; i++) {
    if ((await client.getBlockNumber({ cacheTime: 0 }).catch(() => 0n)) > rc.blockNumber) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return rc;
}

export interface Deployment {
  chainId: number;
  factory: Address;
  reputation: Address;
  gate: Address;
  tkrw: Address;
  schemaUid: `0x${string}`;
  sangjang?: Address;
  cheongyak?: Address;
  tokenFactory?: Address;
  cheongyakV2?: Address;
  swapFactory?: Address;
  swapRouter?: Address;
  jangoe?: Address;
  pump?: Address;
  pumpRouter?: Address;
  /** 뻥튀기 v1: coins launched before 2026-09-26 keep trading there. */
  pumpV1?: Address;
  pumpRouterV1?: Address;
  /** Routes through every DEX on GIWA. */
  aggregator?: Address;
  /** 장터 브릿지 on Ethereum Sepolia (L1). */
  bridge?: Address;
  /** Withdrawal front door on GIWA (to Ethereum Sepolia). */
  withdraw?: Address;
  /** 장터 빠른 출금: exit on GIWA, vault on Ethereum Sepolia. */
  fastExit?: Address;
  fastVault?: Address;
  /** 오늘의 룰렛 (JangteoDaily). */
  daily?: Address;
  invite?: Address;
  /** Limit orders + DCA (JangteoOrders). */
  orders?: Address;
  /** 인사동 Insadong: NFT drops, the NFT market, and Jangteo's own collection 탈 Tal. */
  insaFactory?: Address;
  insaMarket?: Address;
  tal?: Address;
  yut?: Address;
  yutHouse?: Address;
  implementation?: Address;
  dojangScroll?: Address;
  eas?: Address;
}

/** Addresses are served next to the app so a redeploy never needs a rebuild. */
export async function loadDeployment(): Promise<Deployment | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}deployment.json`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as Deployment;
  } catch {
    return null;
  }
}

// GIWA playground: one-click testnet identity (TESTNET FAUCET attester).
export const DOJANG = {
  scroll: "0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9" as Address,
  faucetExtension: "0x63CCe2b569A7bC35895ee24306c1512fefc06121" as Address,
  upbit: "0xd99b42e778498aa3c9c1f6a012359130252780511687a35982e8e52735453034" as `0x${string}`,
  testnet: "0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678" as `0x${string}`,
};

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
