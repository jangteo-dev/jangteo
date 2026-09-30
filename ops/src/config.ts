import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hex, Address } from "viem";

const ROOT = resolve(import.meta.dirname, "..");

for (const file of [process.env.GIWA_ENV_FILE ?? resolve(ROOT, ".env"), resolve(ROOT, "../keys/keeper.env"), resolve(ROOT, "../keys/mail.env")]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

function list(name: string, fallback = ""): string[] {
  return (process.env[name] ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface FarmWallet {
  label: string;
  address: Address;
  key: Hex;
  email?: string;
}

function wallet(label: string): FarmWallet | null {
  const address = process.env[`GIWA_${label}_ADDRESS`];
  const key = process.env[`GIWA_${label}_KEY`];
  if (!address || !key) return null;
  const n = label.replace(/\D/g, "");
  return { label, address: address as Address, key: key as Hex, email: process.env[`MAIL_GIWA${n}_USER`] };
}

export const DEPLOYMENT_FILE = resolve(ROOT, "../contracts/deployments/91342.json");

export interface GyeDeployment {
  factory: Address;
  reputation: Address;
  tkrw: Address;
  gate: Address;
}

/** Read on every call so a deployment made while the service runs is picked up without a restart. */
export function gyeDeployment(): GyeDeployment | null {
  if (!existsSync(DEPLOYMENT_FILE)) return null;
  const d = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Record<string, string>;
  return { factory: d.factory as Address, reputation: d.reputation as Address, tkrw: d.tkrw as Address, gate: d.gate as Address };
}

export const config = {
  root: ROOT,
  dataDir: env("GIWA_DATA_DIR", resolve(ROOT, "data")),
  dryRun: env("GIWA_DRY_RUN", "0") === "1",
  /** Live docroot of the web app; ops publishes runtime JSON (swap stats) next to it. */
  webroot: env("GYE_WEBROOT", "/srv/jangteo/current"),

  rpc: {
    giwa: list("GIWA_RPC", "https://sepolia-rpc.giwa.io,https://sepolia-rpc-flashblocks.giwa.io"),
    l1: list("L1_RPC", "https://ethereum-sepolia-rpc.publicnode.com,https://11155111.rpc.thirdweb.com,https://sepolia.gateway.tenderly.co"),
    explorerApi: env("GIWA_EXPLORER_API", "https://sepolia-explorer.giwa.io/api/v2"),
  },

  wallets: {
    deployer: wallet("DEPLOYER"),
    farm: ["FARM1", "FARM2"].map(wallet).filter((w): w is FarmWallet => w !== null),
  },

  farm: {
    /** Keep this much ETH on L1 after bridging (gas for the bridge tx itself). */
    l1Reserve: BigInt(env("FARM_L1_RESERVE_WEI", "5000000000000000")), // 0.005
    /** Only bridge when L1 balance exceeds reserve by this much. */
    l1MinBridge: BigInt(env("FARM_L1_MIN_BRIDGE_WEI", "10000000000000000")), // 0.01
    /** Top farm wallets up from the deployer when they fall below this on GIWA. */
    l2Floor: BigInt(env("FARM_L2_FLOOR_WEI", "5000000000000000")), // 0.005
    l2TopUp: BigInt(env("FARM_L2_TOPUP_WEI", "20000000000000000")), // 0.02
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    owners: list("TELEGRAM_OWNER_IDS").map(Number),
  },

  github: {
    org: env("GIWA_GITHUB_ORG", "giwa-io"),
    token: process.env.GITHUB_TOKEN ?? "",
  },
};

export type Config = typeof config;
