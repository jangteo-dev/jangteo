import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  parseAbi,
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Abi,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { giwaSepolia, sepolia } from "viem/chains";
import { config } from "./config.ts";
import { logger } from "./engine/log.ts";

const log = logger("chain");

function transport(urls: string[]) {
  return patient(
    fallback(
      urls.map((u) => http(u, { timeout: 15_000, retryCount: 2, retryDelay: 400 })),
      { rank: false, retryCount: 1 },
    ),
  );
}

/**
 * GIWA's public RPC answers bursts with -32016 "over rate limit", which viem does not retry. This
 * wraps a transport so rate-limited requests wait and try again (up to ~40 s) instead of failing
 * the whole task; every other error passes straight through.
 */
function patient<T extends Transport>(inner: T): T {
  return ((opts: Parameters<T>[0]) => {
    const t = inner(opts);
    return {
      ...t,
      async request(args: Parameters<typeof t.request>[0]) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await t.request(args);
          } catch (err) {
            const m = `${(err as Error)?.message ?? ""} ${(err as { details?: string })?.details ?? ""}`;
            if (attempt >= 6 || !/over rate limit|-32016|\b429\b/i.test(m)) throw err;
            await new Promise((r) => setTimeout(r, Math.min(12_000, 700 * 2 ** attempt) + Math.random() * 400));
          }
        }
      },
    };
  }) as T;
}

// Parallel reads are folded into multicalls: one request instead of dozens against the rate limit.
export const giwa: PublicClient = createPublicClient({
  chain: giwaSepolia,
  transport: transport(config.rpc.giwa),
  batch: { multicall: { wait: 16 } },
}) as PublicClient;
export const l1: PublicClient = createPublicClient({ chain: sepolia, transport: transport(config.rpc.l1) }) as PublicClient;

export function signer(key: Hex, chain: Chain = giwaSepolia): { account: Account; wallet: WalletClient } {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({
    account,
    chain,
    transport: transport(chain.id === giwaSepolia.id ? config.rpc.giwa : config.rpc.l1),
  });
  return { account, wallet };
}

export interface WriteArgs {
  key: Hex;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  chain?: "giwa" | "l1";
}

/**
 * Simulate → send → wait. Simulation first means a revert costs nothing and returns the
 * decoded reason. In dry-run mode only the simulation happens.
 */
export async function write(w: WriteArgs): Promise<{ hash: Hex | null; result: unknown }> {
  const onL1 = w.chain === "l1";
  const client = onL1 ? l1 : giwa;
  const { account, wallet } = signer(w.key, onL1 ? sepolia : giwaSepolia);
  const { request, result } = await client.simulateContract({
    account,
    address: w.address,
    abi: w.abi,
    functionName: w.functionName,
    args: w.args ?? [],
    value: w.value,
  } as never);
  if (config.dryRun) {
    log.info(`[dry-run] ${w.functionName} from ${account.address}`);
    return { hash: null, result };
  }
  const hash = await wallet.writeContract(request as never);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${w.functionName} reverted on-chain (${hash})`);
  // GIWA's RPC is a pool of nodes: before the next step reads state, wait until the node answering
  // us has seen this block, or it is simulated against the state before it (a keeper's second step
  // reverting with the first step's precondition).
  for (let i = 0; i < 16; i++) {
    if ((await client.getBlockNumber({ cacheTime: 0 }).catch(() => 0n)) > receipt.blockNumber) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return { hash, result };
}

export async function sendEth(key: Hex, to: Address, value: bigint): Promise<Hex | null> {
  const { account, wallet } = signer(key);
  if (config.dryRun) return null;
  const hash = await wallet.sendTransaction({ account, to, value, chain: giwaSepolia });
  const receipt = await giwa.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`transfer reverted (${hash})`);
  return hash;
}

/** Turn viem's verbose errors into one line for Telegram. */
export function reason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.reason ?? revert.shortMessage;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

export const explorerTx = (h: Hex | null) => (h ? `https://sepolia-explorer.giwa.io/tx/${h}` : "(dry-run)");

// ─────────────────────────────── addresses ────────────────────────────────

export const ADDR = {
  l1StandardBridge: "0x77b2ffc0F57598cAe1DB76cb398059cF5d10A7E7",
  dojangScroll: "0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9",
  faucetExtension: "0x63CCe2b569A7bC35895ee24306c1512fefc06121",
  verifiedToken: "0xBCdB22f56642DE57624CfC2fBb9eE398cF3CA268",
  verifiedTokenFaucet: "0xfe4b4F5f2f8843dC9Ca75E563f2f7eB0f44Ae83e",
  upIdRegistry: "0x091D00004f21eb2Fc30964A8a4995692d9b49628",
} as const satisfies Record<string, Address>;

export const TESTNET_FAUCET_ATTESTER = "0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678" as Hex;

// ────────────────────────────────── ABIs ──────────────────────────────────

export const abi = {
  l1Bridge: parseAbi(["function bridgeETHTo(address to, uint32 minGasLimit, bytes extraData) payable"]),
  scroll: parseAbi(["function isVerified(address addr, bytes32 attesterId) view returns (bool)"]),
  faucetExt: parseAbi([
    "function fee() view returns (uint256)",
    "function payAndIssueEAS() payable returns (bytes32)",
  ]),
  tokenFaucet: parseAbi([
    "function claim()",
    "function lastClaimedAt(address) view returns (uint256)",
    "function claimInterval() view returns (uint256)",
  ]),
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ]),
  upId: parseAbi([
    "function register(string name)",
    "function isClaimable(string name) view returns (bool)",
    "function hasActiveName(address owner) view returns (bool)",
  ]),
  gyeFactory: parseAbi([
    "function circleCount() view returns (uint256)",
    "function circles(uint256 offset, uint256 limit) view returns (address[])",
  ]),
  gyeCircle: parseAbi([
    "function settleable() view returns (bool)",
    "function settle()",
    "function phase() view returns (uint8)",
    "function round() view returns (uint8)",
    "function deadline() view returns (uint64)",
  ]),
  tkrw: parseAbi(["function drip()", "function lastDrip(address) view returns (uint256)"]),
};
