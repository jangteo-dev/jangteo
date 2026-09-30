import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Address, WalletClient } from "viem";
import { loadDeployment, type Deployment } from "./lib/chain";
import { connect, disconnectWallet, discoverWallets, type Announced } from "./lib/wallet";
import { friendlyError } from "./lib/gye";
import { useLang } from "./i18n";

interface Toast {
  id: number;
  kind: "ok" | "err" | "busy";
  text: string;
}

interface AppState {
  deployment: Deployment | null | undefined;
  account: Address | null;
  wallet: WalletClient | null;
  wallets: Announced[];
  connectWith: (w: Announced) => Promise<void>;
  disconnect: () => void;
  /** Bumps after every confirmed transaction so views re-read the chain. */
  tick: number;
  /** Runs a wallet action with progress / success / error toasts. */
  run: (label: string, done: string, fn: (w: WalletClient) => Promise<unknown>) => Promise<boolean>;
  toasts: Toast[];
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { t } = useLang();
  const [deployment, setDeployment] = useState<Deployment | null | undefined>(undefined);
  const [account, setAccount] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [wallets, setWallets] = useState<Announced[]>([]);
  const [linked, setLinked] = useState<Announced | null>(null);
  const [tick, setTick] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    void loadDeployment().then(setDeployment);
    return discoverWallets(setWallets);
  }, []);

  // Chain state moves every second on GIWA; a slow poll keeps pages honest without a socket.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 12_000);
    return () => clearInterval(t);
  }, []);

  const toast = useCallback((t: Omit<Toast, "id">, ttl = 6000) => {
    const id = Date.now() + Math.random();
    setToasts((xs) => [...xs.filter((x) => x.kind !== "busy"), { ...t, id }]);
    if (t.kind !== "busy") setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), ttl);
  }, []);

  const connectWith = useCallback(
    async (w: Announced) => {
      try {
        const r = await connect(w.provider);
        setLinked(w);
        setAccount(r.account);
        setWallet(r.wallet);
        w.provider.on?.("accountsChanged", (accs: unknown) => {
          const a = (accs as Address[])[0];
          if (!a) {
            setAccount(null);
            setWallet(null);
          } else void connect(w.provider).then((x) => (setAccount(x.account), setWallet(x.wallet)));
        });
      } catch (err) {
        toast({ kind: "err", text: friendlyError(err, t.errors) });
      }
    },
    [toast, t],
  );

  // One transaction at a time: a second click while the first is still signing or confirming would
  // send against a page that has not caught up yet (a pot already collected, an order already filled).
  const inFlight = useRef(false);
  const run = useCallback<AppState["run"]>(
    async (label, done, fn) => {
      if (!wallet) {
        toast({ kind: "err", text: t.wallet.connectFirst });
        return false;
      }
      if (inFlight.current) {
        toast({ kind: "err", text: t.wallet.busy }, 4000);
        return false;
      }
      inFlight.current = true;
      toast({ kind: "busy", text: label });
      try {
        await fn(wallet);
        toast({ kind: "ok", text: done });
        setTick((x) => x + 1);
        return true;
      } catch (err) {
        toast({ kind: "err", text: friendlyError(err, t.errors) }, 9000);
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [wallet, toast, t],
  );

  return (
    <Ctx.Provider
      value={{ deployment, account, wallet, wallets, connectWith, disconnect: () => (void disconnectWallet(linked?.provider), setLinked(null), setAccount(null), setWallet(null)), tick, run, toasts }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useHashRoute(): string {
  const [route, setRoute] = useState(() => location.hash.slice(1) || "/");
  useEffect(() => {
    const f = () => {
      const next = location.hash.slice(1) || "/";
      setRoute(next);
      // Docs section links scroll to their heading themselves.
      if (!next.startsWith("/docs/")) window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return route;
}

/** Re-runs `load` on mount, when deps change, and on every app tick. */
export function useChain<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null } {
  const { tick } = useApp();
  const { t } = useLang();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(friendlyError(e, t.errors)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error };
}
