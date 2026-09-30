import { keccak256, maxUint256, parseAbiItem, parseUnits, toHex, type Address, type Hex, type WalletClient } from "viem";
import { GyeWonAbi, YutGameAbi } from "./abi";
import { chain, client, confirmed, mustHold } from "./chain";

export const YUT_STATUS = ["None", "Open", "Playing", "Done", "Cancelled"] as const;
export const OFF = 255;
export const HOME = 254;
const CHAIN = 256;

export type YutGameState = Awaited<ReturnType<typeof readGame>>;

export async function readGame(addr: Address, id: number) {
  const g = await client.readContract({ address: addr, abi: YutGameAbi, functionName: "game", args: [BigInt(id)] });
  return {
    id,
    players: g.players as readonly [Address, Address],
    stake: g.stake,
    status: YUT_STATUS[g.status],
    turn: g.turn,
    phase: g.phase === 0 ? ("throwing" as const) : ("moving" as const),
    extra: g.extra,
    pending: g.pending.slice(0, g.pendingCount).map(Number),
    deadline: Number(g.deadline),
    lastBlock: Number(g.lastBlock),
    winner: g.winner,
    feeBps: g.feeBps,
    salt: g.salt,
    throws: g.throws,
    pos: g.pos.map(Number),
    route: g.route.map(Number),
  };
}

export async function listGames(addr: Address, max = 60) {
  const n = Number(await client.readContract({ address: addr, abi: YutGameAbi, functionName: "gameCount" }));
  const ids = Array.from({ length: Math.min(n, max) }, (_, i) => n - 1 - i);
  return Promise.all(ids.map((id) => readGame(addr, id)));
}

export const NAMES_KO: Record<number, string> = { [-1]: "빽도", 1: "도", 2: "개", 3: "걸", 4: "윷", 5: "모" };

// ─────────────────────────── the secret hash chain ───────────────────────────
//
// The secret is keccak256(signature over a fixed message + the game's salt). Wallets sign
// deterministically, so the same wallet can always re-derive it; a copy is also kept locally.

const MESSAGE = (salt: Hex) => `Jangteo 윷놀이\n\nSign to create this game's secret dice seed. It never leaves your browser and costs nothing.\n\nSeed: ${salt}`;
const memo = new Map<string, Hex[]>();

function chainFrom(secret: Hex): Hex[] {
  const c: Hex[] = [secret];
  for (let k = 1; k <= CHAIN; k++) c.push(keccak256(c[k - 1]));
  return c;
}

function key(addr: Address, salt: Hex) {
  return `jangteo.yut.${addr.toLowerCase()}.${salt}`;
}

export async function seedChain(wallet: WalletClient, salt: Hex): Promise<Hex[]> {
  const me = wallet.account!.address;
  const k = key(me, salt);
  const cached = memo.get(k);
  if (cached) return cached;
  let secret: Hex | null = null;
  try {
    secret = localStorage.getItem(k) as Hex | null;
  } catch {
    // storage may be blocked; fall back to signing
  }
  if (!secret) {
    const sig = await wallet.signMessage({ account: wallet.account!, message: MESSAGE(salt) });
    secret = keccak256(sig);
    try {
      localStorage.setItem(k, secret);
    } catch {
      // the wallet can re-derive it next time
    }
  }
  const c = chainFrom(secret);
  memo.set(k, c);
  return c;
}

export const newSalt = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));

// ───────────────────────────────── writes ─────────────────────────────────

async function send(wallet: WalletClient, req: object) {
  const hash = await wallet.writeContract(req as Parameters<WalletClient["writeContract"]>[0]);
  const rc = await confirmed(hash);
  if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
  return rc;
}

async function approve(wallet: WalletClient, token: Address, spender: Address, amount: bigint) {
  await mustHold(token, wallet.account!.address, amount);
  const allowance = await client.readContract({ address: token, abi: GyeWonAbi, functionName: "allowance", args: [wallet.account!.address, spender] });
  if (allowance < amount) await send(wallet, { account: wallet.account!, chain, address: token, abi: GyeWonAbi, functionName: "approve", args: [spender, maxUint256] });
}

/** Waits until at least two blocks have passed since the last action, as the contract requires. */
async function waitForThrowBlock(lastBlock: number) {
  for (let i = 0; i < 20; i++) {
    const b = Number(await client.getBlockNumber());
    if (b >= lastBlock + 2) return;
    await new Promise((r) => setTimeout(r, 600));
  }
}

export const yut = {
  async create(wallet: WalletClient, addr: Address, token: Address, won: string) {
    const stake = parseUnits(won, 18);
    await approve(wallet, token, addr, stake);
    const salt = newSalt();
    const c = await seedChain(wallet, salt);
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: YutGameAbi, functionName: "create", args: [stake, c[CHAIN], salt] });
  },
  async join(wallet: WalletClient, addr: Address, token: Address, g: YutGameState) {
    await approve(wallet, token, addr, g.stake);
    const salt = newSalt();
    const c = await seedChain(wallet, salt);
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: YutGameAbi, functionName: "join", args: [BigInt(g.id), c[CHAIN], salt] });
  },
  async throwSticks(wallet: WalletClient, addr: Address, shown: YutGameState, me: 0 | 1) {
    // The page's copy can be a throw behind (a quick "throw again" before it refreshed): the link to
    // reveal is chosen from the game as the chain has it now, or the contract refuses the reveal.
    const g = await readGame(addr, shown.id).catch(() => shown);
    const c = await seedChain(wallet, g.salt[me]);
    const link = c[CHAIN - (g.throws[me] + 1)];
    await waitForThrowBlock(g.lastBlock);
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: YutGameAbi, functionName: "throwSticks", args: [BigInt(g.id), link] });
  },
  move(wallet: WalletClient, addr: Address, id: number, slot: number, piece: number) {
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: YutGameAbi, functionName: "move", args: [BigInt(id), slot, piece] });
  },
  pass(wallet: WalletClient, addr: Address, id: number, slot: number) {
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: YutGameAbi, functionName: "pass", args: [BigInt(id), slot] });
  },
  resign(wallet: WalletClient, addr: Address, id: number) {
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: YutGameAbi, functionName: "resign", args: [BigInt(id)] });
  },
  cancel(wallet: WalletClient, addr: Address, id: number) {
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: YutGameAbi, functionName: "cancel", args: [BigInt(id)] });
  },
  claimTimeout(wallet: WalletClient, addr: Address, id: number) {
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: YutGameAbi, functionName: "claimTimeout", args: [BigInt(id)] });
  },
  claim(wallet: WalletClient, addr: Address) {
    return send(wallet, { account: wallet.account!, chain, address: addr, abi: YutGameAbi, functionName: "claim" });
  },
};

export async function winnings(addr: Address, who: Address) {
  return client.readContract({ address: addr, abi: YutGameAbi, functionName: "claimable", args: [who] });
}

// ───────────────────────────── board geometry ─────────────────────────────
// Mirrors YutBoard.sol so the UI can preview where a piece lands.

function next(p: number, r: number, first: boolean): [number, number] {
  if (p === OFF) return [1, 0];
  if (p === HOME) return [HOME, 0];
  if (first) {
    if (p === 5) return [20, 1];
    if (p === 10) return [25, 2];
    if (p === 22) return [27, 2];
  }
  if (p === 0) return [HOME, 0];
  if (r === 1) {
    if (p === 24) return [15, 0];
    if (p >= 20 && p <= 23) return [p + 1, 1];
  }
  if (r === 2) {
    if (p === 25) return [26, 2];
    if (p === 26) return [22, 2];
    if (p === 22) return [27, 2];
    if (p === 27) return [28, 2];
    if (p === 28) return [0, 0];
  }
  if (p === 19) return [0, 0];
  return [p + 1, 0];
}

function prev(p: number, r: number): [number, number] {
  if (p === 0) return [19, 0];
  if (r === 1) {
    if (p === 20) return [5, 0];
    if (p >= 21 && p <= 24) return [p - 1, 1];
  }
  if (r === 2) {
    if (p === 25) return [10, 0];
    if (p === 26) return [25, 2];
    if (p === 22) return [26, 2];
    if (p === 27) return [22, 2];
    if (p === 28) return [27, 2];
  }
  if (p === 1) return [0, 0];
  return [p - 1, 0];
}

export function advance(p: number, r: number, steps: number): number {
  if (steps < 0) return prev(p, r)[0];
  for (let i = 0; i < steps; i++) {
    [p, r] = next(p, r, i === 0);
    if (p === HOME) break;
  }
  return p;
}

/** SVG coordinates (0‥100) for every station. 0 is the bottom-right start corner. */
export const STATION: Record<number, [number, number]> = (() => {
  const s: Record<number, [number, number]> = {};
  const lo = 8;
  const hi = 92;
  const step = (hi - lo) / 5;
  for (let i = 0; i <= 5; i++) s[i] = [hi, hi - step * i]; // right edge, bottom → top
  for (let i = 1; i <= 5; i++) s[5 + i] = [hi - step * i, lo]; // top edge, right → left
  for (let i = 1; i <= 5; i++) s[10 + i] = [lo, lo + step * i]; // left edge, top → bottom
  for (let i = 1; i <= 4; i++) s[15 + i] = [lo + step * i, hi]; // bottom edge, left → right
  const c = 50;
  const d = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  s[20] = d(s[5], [c, c], 1 / 3);
  s[21] = d(s[5], [c, c], 2 / 3);
  s[22] = [c, c];
  s[23] = d([c, c], s[15], 1 / 3);
  s[24] = d([c, c], s[15], 2 / 3);
  s[25] = d(s[10], [c, c], 1 / 3);
  s[26] = d(s[10], [c, c], 2 / 3);
  s[27] = d([c, c], s[0], 1 / 3);
  s[28] = d([c, c], s[0], 2 / 3);
  return s;
})();

export const CORNERS = new Set([0, 5, 10, 15, 22]);

const finished = parseAbiItem("event Finished(uint256 indexed id, address indexed winner, uint256 payout, uint256 fee, uint8 reason)");

/** Why a game ended, from the contract's own record: 0 all pieces home, 1 the loser ran out of time, 2 resigned. */
export async function finishReason(addr: Address, id: number, fromBlock: number): Promise<number | null> {
  try {
    const head = await client.getBlockNumber();
    const from = BigInt(fromBlock);
    const to = from + 9_999n < head ? from + 9_999n : head; // GIWA's RPC answers 10,000 blocks at most
    const logs = await client.getLogs({ address: addr, event: finished, args: { id: BigInt(id) }, fromBlock: from, toBlock: to });
    return logs.length ? Number(logs[0].args.reason) : null;
  } catch {
    return null;
  }
}
