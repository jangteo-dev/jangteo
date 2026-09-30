import { createWalletClient, custom, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { chain } from "./chain";

interface Announced {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

const found = new Map<string, Announced>();

export function discoverWallets(onChange: (w: Announced[]) => void) {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<Announced>).detail;
    found.set(d.info.uuid, d);
    onChange([...found.values()]);
  };
  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (legacy && found.size === 0) {
    found.set("legacy", { info: { uuid: "legacy", name: "Browser wallet", icon: "", rdns: "injected" }, provider: legacy });
    onChange([...found.values()]);
  }
  return () => window.removeEventListener("eip6963:announceProvider", handler);
}

export type { Announced };

export async function connect(provider: EIP1193Provider): Promise<{ account: Address; wallet: WalletClient }> {
  // A wallet that already trusts the site answers eth_requestAccounts silently. Asking for the
  // permission again always opens its account picker, so Connect means a real, visible choice.
  try {
    await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] } as never);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 4001) throw err; // declined in the wallet
    // Wallets without the method fall back to the plain request below.
  }
  const [account] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  await ensureChain(provider);
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  return { account, wallet };
}

/** Drops the site's permission in wallets that support it, so the next Connect asks again. */
export async function disconnectWallet(provider?: EIP1193Provider) {
  await provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] } as never).catch(() => {});
}

async function ensureChain(provider: EIP1193Provider) {
  const hex = `0x${chain.id.toString(16)}` as const;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: "GIWA Sepolia",
          nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://sepolia-rpc.giwa.io"],
          blockExplorerUrls: ["https://sepolia-explorer.giwa.io"],
        },
      ],
    });
  }
}
