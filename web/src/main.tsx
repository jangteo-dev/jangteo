import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Address } from "viem";
import "./index.css";
import { AppProvider, useApp, useHashRoute } from "./app";
import { LangProvider } from "./i18n";
import { Footer, Header, Toasts } from "./components/Chrome";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Hub } from "./pages/Hub";
import { captureRef } from "./lib/invite";

captureRef();

// Every page but the hub loads on first visit: the hub stays small and fast on a phone.
const GyeHome = lazy(() => import("./pages/GyeHome").then((m) => ({ default: m.GyeHome })));
const CirclePage = lazy(() => import("./pages/CirclePage").then((m) => ({ default: m.CirclePage })));
const CreatePage = lazy(() => import("./pages/CreatePage").then((m) => ({ default: m.CreatePage })));
const MePage = lazy(() => import("./pages/MePage").then((m) => ({ default: m.MePage })));
const Listings = lazy(() => import("./pages/Listings").then((m) => ({ default: m.Listings })));
const ListingPage = lazy(() => import("./pages/ListingPage").then((m) => ({ default: m.ListingPage })));
const Docs = lazy(() => import("./pages/Docs").then((m) => ({ default: m.Docs })));
const CyList = lazy(() => import("./pages/CyList").then((m) => ({ default: m.CyList })));
const CyPage = lazy(() => import("./pages/CyPage").then((m) => ({ default: m.CyPage })));
const CyNew = lazy(() => import("./pages/CyNew").then((m) => ({ default: m.CyNew })));
const YutLobby = lazy(() => import("./pages/YutLobby").then((m) => ({ default: m.YutLobby })));
const JgList = lazy(() => import("./pages/JgList").then((m) => ({ default: m.JgList })));
const SwapPage = lazy(() => import("./pages/SwapPage").then((m) => ({ default: m.SwapPage })));
const StatsPage = lazy(() => import("./pages/StatsPage").then((m) => ({ default: m.StatsPage })));
const PointsPage = lazy(() => import("./pages/PointsPage").then((m) => ({ default: m.PointsPage })));
const PumpList = lazy(() => import("./pages/PumpList").then((m) => ({ default: m.PumpList })));
const PumpNew = lazy(() => import("./pages/PumpNew").then((m) => ({ default: m.PumpNew })));
const PumpPage = lazy(() => import("./pages/PumpPage").then((m) => ({ default: m.PumpPage })));
const MarketPage = lazy(() => import("./pages/MarketPage").then((m) => ({ default: m.MarketPage })));
const MarketToken = lazy(() => import("./pages/MarketToken").then((m) => ({ default: m.MarketToken })));
const TradePage = lazy(() => import("./pages/TradePage").then((m) => ({ default: m.TradePage })));
const Faq = lazy(() => import("./pages/Faq").then((m) => ({ default: m.Faq })));
const JgPage = lazy(() => import("./pages/JgPage").then((m) => ({ default: m.JgPage })));
const InsaHome = lazy(() => import("./pages/InsaHome").then((m) => ({ default: m.InsaHome })));
const InsaCollection = lazy(() => import("./pages/InsaCollection").then((m) => ({ default: m.InsaCollection })));
const InsaItem = lazy(() => import("./pages/InsaItem").then((m) => ({ default: m.InsaItem })));
const InsaNew = lazy(() => import("./pages/InsaNew").then((m) => ({ default: m.InsaNew })));
const YutPage = lazy(() => import("./pages/YutPage").then((m) => ({ default: m.YutPage })));

function Page({ route }: { route: string }) {
  const circle = route.match(/^\/gye\/c\/(0x[0-9a-fA-F]{40})$/)?.[1] as Address | undefined;
  const market = route.match(/^\/listings\/(\d+)$/)?.[1];
  if (circle) return <CirclePage address={circle} />;
  if (market !== undefined) return <ListingPage id={Number(market)} />;
  const offering = route.match(/^\/cheongyak\/(v1\/)?(\d+)$/);
  if (offering) return <CyPage v={offering[1] ? 1 : 2} id={Number(offering[2])} />;
  const marketToken = route.match(/^\/market\/(0x[0-9a-fA-F]{40})$/)?.[1] as Address | undefined;
  if (marketToken) return <MarketToken token={marketToken} />;
  const tradeToken = route.match(/^\/trade\/(0x[0-9a-fA-F]{40})$/)?.[1] as Address | undefined;
  if (tradeToken) return <TradePage token={tradeToken} />;
  const pumpToken = route.match(/^\/ppeongtwigi\/(0x[0-9a-fA-F]{40})$/)?.[1] as Address | undefined;
  if (pumpToken) return <PumpPage token={pumpToken} />;
  const jgMarket = route.match(/^\/jangoe\/(\d+)$/)?.[1];
  if (jgMarket !== undefined) return <JgPage id={Number(jgMarket)} />;
  const insaItem = route.match(/^\/insa\/c\/(0x[0-9a-fA-F]{40})\/(\d+)$/);
  if (insaItem) return <InsaItem address={insaItem[1] as Address} id={insaItem[2]} />;
  const insaCol = route.match(/^\/insa\/c\/(0x[0-9a-fA-F]{40})$/)?.[1] as Address | undefined;
  if (insaCol) return <InsaCollection address={insaCol} />;
  if (route === "/insa/tal") return <TalRoute />;
  const game = route.match(/^\/yut\/(\d+)$/)?.[1];
  if (game !== undefined) return <YutPage id={Number(game)} />;
  if (route === "/swap" || route.startsWith("/swap?")) return <SwapPage query={new URLSearchParams(route.split("?")[1] ?? "")} />;
  if (route === "/docs" || route.startsWith("/docs/")) return <Docs section={route.split("/")[2]} />;
  switch (route) {
    case "/gye":
      return <GyeHome />;
    case "/gye/new":
      return <CreatePage />;
    case "/listings":
      return <Listings />;
    case "/cheongyak":
      return <CyList />;
    case "/cheongyak/new":
      return <CyNew />;
    case "/yut":
      return <YutLobby />;
    case "/market":
      return <MarketPage />;
    case "/ppeongtwigi":
      return <PumpList />;
    case "/ppeongtwigi/new":
      return <PumpNew />;
    case "/insa":
      return <InsaHome />;
    case "/insa/new":
      return <InsaNew />;
    case "/faq":
      return <Faq />;
    case "/points":
      return <PointsPage />;
    case "/stats":
      return <StatsPage />;
    case "/jangoe":
      return <JgList />;
    case "/me":
      return <MePage />;
    case "/me?tab=id":
      return <MePage query={new URLSearchParams("tab=id")} />;
    default:
      return <Hub />;
  }
}

/** #/insa/tal: Jangteo's own collection, wherever it is deployed. */
function TalRoute() {
  const { deployment } = useApp();
  if (deployment === undefined) return <main className="page page--loading" aria-busy="true" />;
  return deployment?.tal ? <InsaCollection address={deployment.tal} /> : <InsaHome />;
}

function Routes() {
  const route = useHashRoute();
  // Links shared before the move to /gye keep working.
  useEffect(() => {
    const legacy = route.match(/^\/(c\/0x[0-9a-fA-F]{40}|new)$/);
    if (legacy) location.replace(`#/gye/${legacy[1]}`);
    // 뻥튀기 lived at #/pump before it got its own name.
    if (route === "/pump" || route.startsWith("/pump/")) location.replace(`#/ppeongtwigi${route.slice(5)}`);
  }, [route]);
  return (
    <>
      <Header route={route} />
      <ErrorBoundary key={route}>
        <Suspense fallback={<main className="page page--loading" aria-busy="true" />}>
          <Page route={route} />
        </Suspense>
      </ErrorBoundary>
      <Footer />
      <Toasts />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LangProvider>
      <AppProvider>
        <Routes />
      </AppProvider>
    </LangProvider>
  </StrictMode>,
);
