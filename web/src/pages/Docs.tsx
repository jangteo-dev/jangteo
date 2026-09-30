import { useEffect, type ReactNode } from "react";
import { useApp } from "../app";
import { explorer, type Deployment } from "../lib/chain";
import { useLang, type Lang } from "../i18n";
import { DocsKo } from "./DocsKo";

interface Section {
  id: string;
  title: string;
  children?: { id: string; title: string }[];
}



const TOC_EN: Section[] = [
  { id: "overview", title: "Overview" },
  {
    id: "start",
    title: "Getting started",
    children: [
      { id: "start-wallet", title: "Wallet and network" },
      { id: "start-identity", title: "Verified identity" },
      { id: "start-won", title: "Test won" },
    ],
  },
  {
    id: "trade",
    title: "Market and trading",
    children: [
      { id: "trade-market", title: "The market" },
      { id: "trade-view", title: "The trade view" },
    ],
  },
  {
    id: "swap",
    title: "Swap and aggregator",
    children: [
      { id: "swap-pools", title: "Jangteo Swap pools" },
      { id: "swap-agg", title: "Routing across GIWA" },
    ],
  },
  {
    id: "orders",
    title: "Limit orders and DCA",
    children: [
      { id: "orders-how", title: "How orders fill" },
      { id: "orders-safety", title: "Keepers and the 48-hour delay" },
    ],
  },
  {
    id: "insa",
    title: "Insadong (NFTs)",
    children: [
      { id: "insa-drops", title: "Drops and phases" },
      { id: "insa-market", title: "Listings, offers, royalties" },
      { id: "insa-tal", title: "Tal" },
    ],
  },
  {
    id: "pump",
    title: "Ppeongtwigi",
    children: [
      { id: "pump-curve", title: "The curve and graduation" },
      { id: "pump-fees", title: "Fees and limits" },
    ],
  },
  {
    id: "bridge",
    title: "Bridge",
    children: [
      { id: "bridge-in", title: "To GIWA" },
      { id: "bridge-out", title: "To Ethereum" },
      { id: "bridge-fast", title: "Fast withdrawals" },
    ],
  },
  {
    id: "gye",
    title: "Savings circles",
    children: [
      { id: "gye-round", title: "A round, step by step" },
      { id: "gye-modes", title: "Who takes the pot" },
      { id: "gye-holdback", title: "Holdback and credit" },
      { id: "gye-missed", title: "Missed payments" },
      { id: "gye-record", title: "Your record" },
      { id: "gye-limits", title: "Limits and fees" },
    ],
  },
  {
    id: "sangjang",
    title: "Listing markets",
    children: [
      { id: "sj-payout", title: "How payouts work" },
      { id: "sj-notice", title: "The notice rule" },
      { id: "sj-resolve", title: "Settling a market" },
      { id: "sj-curation", title: "Which coins get a market" },
      { id: "sj-limits", title: "Limits and fees" },
    ],
  },
  {
    id: "cheongyak",
    title: "Offerings",
    children: [
      { id: "cy-alloc", title: "How allocation works" },
      { id: "cy-protect", title: "Minimum raise, unlocks, liquidity" },
      { id: "cy-issuers", title: "For issuers" },
    ],
  },
  {
    id: "points",
    title: "Points",
    children: [{ id: "points-daily", title: "Daily roulette and quests" }],
  },
  {
    id: "jangoe",
    title: "Premarket",
    children: [
      { id: "jg-trade", title: "Offers and trades" },
      { id: "jg-deliver", title: "Delivery and defaults" },
    ],
  },
  {
    id: "yut",
    title: "Yut",
    children: [
      { id: "yut-rules", title: "Rules" },
      { id: "yut-dice", title: "Fair throws" },
      { id: "yut-time", title: "Time and stakes" },
    ],
  },
  { id: "contracts", title: "Contracts" },
  { id: "trust", title: "What we can and can't do" },
  { id: "faq", title: "Questions" },
];

const TOC_KO: Section[] = [
  { id: "overview", title: "개요" },
  {
    id: "start",
    title: "시작하기",
    children: [
      { id: "start-wallet", title: "지갑과 네트워크" },
      { id: "start-identity", title: "본인 인증" },
      { id: "start-won", title: "테스트 원화" },
    ],
  },
  {
    id: "trade",
    title: "마켓과 거래",
    children: [
      { id: "trade-market", title: "마켓" },
      { id: "trade-view", title: "거래 화면" },
    ],
  },
  {
    id: "swap",
    title: "스왑과 애그리게이터",
    children: [
      { id: "swap-pools", title: "장터 스왑 풀" },
      { id: "swap-agg", title: "GIWA 전체 경로 탐색" },
    ],
  },
  {
    id: "orders",
    title: "지정가와 적립식 주문",
    children: [
      { id: "orders-how", title: "체결 방식" },
      { id: "orders-safety", title: "키퍼와 48시간 유예" },
    ],
  },
  {
    id: "insa",
    title: "인사동 (NFT)",
    children: [
      { id: "insa-drops", title: "드롭과 단계" },
      { id: "insa-market", title: "판매, 제안, 로열티" },
      { id: "insa-tal", title: "탈" },
    ],
  },
  {
    id: "pump",
    title: "뻥튀기",
    children: [
      { id: "pump-curve", title: "커브와 졸업" },
      { id: "pump-fees", title: "수수료와 한도" },
    ],
  },
  {
    id: "bridge",
    title: "브릿지",
    children: [
      { id: "bridge-in", title: "GIWA로" },
      { id: "bridge-out", title: "이더리움으로" },
      { id: "bridge-fast", title: "빠른 출금" },
    ],
  },
  {
    id: "gye",
    title: "계모임",
    children: [
      { id: "gye-round", title: "한 회차의 흐름" },
      { id: "gye-modes", title: "곗돈 받는 방식" },
      { id: "gye-holdback", title: "맡기는 돈과 신용" },
      { id: "gye-missed", title: "납입을 놓치면" },
      { id: "gye-record", title: "내 기록" },
      { id: "gye-limits", title: "한도와 수수료" },
    ],
  },
  {
    id: "sangjang",
    title: "상장 예측",
    children: [
      { id: "sj-payout", title: "배당 계산" },
      { id: "sj-notice", title: "공지 시각 규칙" },
      { id: "sj-resolve", title: "정산 과정" },
      { id: "sj-curation", title: "마켓이 열리는 코인" },
      { id: "sj-limits", title: "한도와 수수료" },
    ],
  },
  {
    id: "cheongyak",
    title: "청약",
    children: [
      { id: "cy-alloc", title: "배정 방식" },
      { id: "cy-protect", title: "최소 모집액, 락업, 유동성" },
      { id: "cy-issuers", title: "발행사 안내" },
    ],
  },
  {
    id: "points",
    title: "장터 포인트",
    children: [{ id: "points-daily", title: "오늘의 룰렛과 미션" }],
  },
  {
    id: "jangoe",
    title: "장외",
    children: [
      { id: "jg-trade", title: "주문과 체결" },
      { id: "jg-deliver", title: "인도와 미인도" },
    ],
  },
  {
    id: "yut",
    title: "윷놀이",
    children: [
      { id: "yut-rules", title: "규칙" },
      { id: "yut-dice", title: "공정한 윷" },
      { id: "yut-time", title: "시간과 판돈" },
    ],
  },
  { id: "contracts", title: "컨트랙트" },
  { id: "trust", title: "운영자가 할 수 있는 일과 없는 일" },
  { id: "faq", title: "자주 묻는 질문" },
];

const TOC: Record<Lang, Section[]> = { en: TOC_EN, ko: TOC_KO };

export const won = (n: number) => `₩${n.toLocaleString("en-US")}`;

type Addr = (label: string, a?: string, note?: ReactNode, l1?: boolean) => ReactNode;

export type { Addr };

export function Docs({ section }: { section?: string }) {
  const { deployment: d } = useApp();
  const { lang } = useLang();
  const toc = TOC[lang];

  useEffect(() => {
    if (!section) return;
    document.getElementById(section)?.scrollIntoView({ block: "start" });
  }, [section, lang]);

  const addr: Addr = (label, a, note, l1) =>
    a ? (
      <tr>
        <th scope="row">{label}</th>
        <td>
          <a href={l1 ? `https://sepolia.etherscan.io/address/${a}` : `${explorer}/address/${a}`} target="_blank" rel="noreferrer">
            <code>{a}</code>
          </a>
          {note && <span className="docs__note">{note}</span>}
        </td>
      </tr>
    ) : null;

  return (
    <main className="page docs">
      <aside className="docs__toc" aria-label="Contents">
        <p className="docs__toc-title">{lang === "ko" ? "문서" : "Docs"}</p>
        <ol>
          {toc.map((s) => (
            <li key={s.id}>
              <a href={`#/docs/${s.id}`} aria-current={section === s.id ? "true" : undefined}>
                {s.title}
              </a>
              {s.children && (
                <ol>
                  {s.children.map((c) => (
                    <li key={c.id}>
                      <a href={`#/docs/${c.id}`} aria-current={section === c.id ? "true" : undefined}>
                        {c.title}
                      </a>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ol>
      </aside>

      {lang === "ko" ? <DocsKo d={d} addr={addr} /> : <DocsEn d={d} addr={addr} />}
    </main>
  );
}

function DocsEn({ d, addr }: { d: Deployment | null | undefined; addr: Addr }) {
  return (
      <article className="docs__body">
        <header id="overview">
          <p className="docs__ko">Jangteo</p>
          <h1>How Jangteo works</h1>
          <p className="lede">
            Jangteo is a market square on GIWA, the Ethereum layer 2 built by Upbit's operator Dunamu. It has a market of every token on
            GIWA with a trade view, a swap that routes across every GIWA exchange, limit orders and DCA, a bridge to and from Ethereum, the
            Ppeongtwigi launchpad, the Insadong NFT market, token offerings with a premarket, Upbit listing markets, savings circles, yut, and a points season.
            Trading, swapping and bridging are open to any wallet. Stalls that count people rather than money (offerings, circles, yut,
            launching a token or a collection, the points ranking) also need a Dojang Verified Address, the on-chain proof that Upbit checked the person
            behind it.
          </p>
          <p>
            Everything runs on the GIWA Sepolia testnet with test ETH and test won (tKRW), which have no value. Contracts hold every
            payment; nobody at Jangteo can move your money. The rules below are the rules in the contracts, with the numbers they use today.
          </p>
        </header>

        <section id="start">
          <h2>Getting started</h2>

          <h3 id="start-wallet">Wallet and network</h3>
          <p>
            Any browser wallet works. When you connect, Jangteo asks your wallet to switch to GIWA Sepolia and adds it if needed. The
            settings, if you'd rather add it yourself:
          </p>
          <table className="docs__table">
            <tbody>
              <tr><th scope="row">Network</th><td>GIWA Sepolia</td></tr>
              <tr><th scope="row">Chain ID</th><td><code>91342</code></td></tr>
              <tr><th scope="row">RPC</th><td><code>https://sepolia-rpc.giwa.io</code></td></tr>
              <tr><th scope="row">Currency</th><td>ETH</td></tr>
              <tr><th scope="row">Explorer</th><td><a href={explorer} target="_blank" rel="noreferrer">sepolia-explorer.giwa.io</a></td></tr>
            </tbody>
          </table>
          <p>
            You need a little test ETH for gas. GIWA's <a href="https://faucet.giwa.io/" target="_blank" rel="noreferrer">faucet</a> gives
            0.005 ETH a day, which covers hundreds of transactions at GIWA's fees.
          </p>

          <h3 id="start-identity">Verified identity</h3>
          <p>
            On mainnet, a wallet qualifies once Upbit Korea has issued it a Dojang Verified Address. On the testnet, GIWA runs a test
            attester that anyone can use: open <a href="#/me">My record</a> and choose <em>Get test verification</em>. It costs 0.001 test
            ETH and takes one transaction.
          </p>

          <h3 id="start-won">Test won</h3>
          <p>
            Circles and markets use tKRW. On <a href="#/me">My record</a>, <em>Draw ₩1,000,000 test won</em> gives you a million once every
            24 hours.
          </p>
        </section>

        <section id="trade">
          <h2>Market and trading</h2>
          <h3 id="trade-market">The market</h3>
          <p>
            <a href="#/market">The market</a> lists every token that trades on GIWA: pools on Jangteo Swap and on every other GIWA exchange
            Jangteo's indexer follows, plus tokens still on a Ppeongtwigi curve. Prices come from the chain itself, block by block, and are shown
            in won at Upbit's live ETH price.
          </p>
          <ul>
            <li>Liquidity below ₩100,000 is marked thin: a price that cheap to move says little about a token.</li>
            <li>Quote assets (WETH copies, test dollars and test won) are tagged and ranked last, so their test supplies don't top the list.</li>
            <li>Token names that contain links are hidden by default; they are the commonest scam on any chain.</li>
            <li>Buy and Sell on any row open a small ticket without leaving the page.</li>
          </ul>
          <h3 id="trade-view">The trade view</h3>
          <p>
            Each token has a trade view against ETH: a candle chart, an order book, a ticket for market, limit and DCA orders, the latest
            trades and your open orders. The order book shows open limit orders on Jangteo together with an estimate of the pools' own depth
            around the market price. Click any level to fill the limit ticket with that price.
          </p>
        </section>

        <section id="swap">
          <h2>Swap and aggregator</h2>
          <h3 id="swap-pools">Jangteo Swap pools</h3>
          <p>
            Jangteo Swap is Uniswap V2 deployed exactly as Uniswap published it. Every swap pays 0.3% into the pool it trades through: 0.25%
            stays with liquidity providers and 0.05% goes to Jangteo, as Uniswap V2's protocol fee. Anyone can add or remove liquidity on the
            Liquidity tab; APR is shown from the last seven days of fees.
          </p>
          <h3 id="swap-agg">Routing across GIWA</h3>
          <p>
            Every swap is quoted twice: through Jangteo Swap's own router, and through Jangteo's aggregator, which searches the pools of every
            exchange on GIWA (Uniswap V2 and V3 forks, Naruswap, KachiSwap and others) for direct routes and routes through one hub token. The
            better result is the one you sign.
          </p>
          <ul>
            <li>Routes that stay inside Jangteo Swap's pools pay no routing fee. Any other route pays 0.1% of the input to Jangteo (the contract caps it at 1%).</li>
            <li>The minimum you accept is enforced by the contract: if the route would pay less, the swap reverts.</li>
            <li>The aggregator holds nothing between swaps. Output goes straight to your wallet, and unspent input from a V3 pool goes back to you.</li>
            <li>
              Some GIWA tokens only trade against a free-to-mint test dollar. Jangteo never opens an ETH pool against such a token, because
              anyone could mint the dollar and drain the ETH.
            </li>
          </ul>
        </section>

        <section id="orders">
          <h2>Limit orders and DCA</h2>
          <h3 id="orders-how">How orders fill</h3>
          <p>
            A limit order sells a token (or ETH) only at your price or better, until it expires (1, 7 or 30 days). A DCA order splits an amount
            into 2 to 365 equal parts and fills one every hour, four hours, day or week, the first right away. A DCA order can also carry a limit:
            a part priced above it (buying) or below it (selling) waits until the price comes back.
          </p>
          <ul>
            <li>Your funds wait in the order contract. Each fill goes through the aggregator's best route and pays straight to your wallet.</li>
            <li>The contract checks every fill against your minimum rate, after its 0.1% fee. It never fills worse.</li>
            <li>Cancel any time: whatever hasn't filled comes back in the same transaction. Anyone can return an expired limit order to its owner.</li>
          </ul>
          <h3 id="orders-safety">Keepers and the 48-hour delay</h3>
          <p>
            Only an approved keeper can fill orders, so nobody can fill a market-priced DCA part through a pool they have rigged. A new keeper, or a
            change to the fee or treasury, only takes effect 48 hours after it is announced on-chain, which leaves time to cancel. Removing a
            keeper is instant. The fee can never exceed 0.5%.
          </p>
        </section>

        <section id="pump">
          <h2>Ppeongtwigi</h2>
          <p>
            Ppeongtwigi is the popped-rice snack of every Korean market: grain goes in under pressure and comes out many times its size. It is also
            Jangteo's launchpad.
          </p>
          <h3 id="pump-curve">The curve and graduation</h3>
          <ul>
            <li>A verified creator names a token and can add an image and links. The supply is fixed at 1 billion when the token is made.</li>
            <li>750 million tokens sell on a bonding curve priced in ETH, which starts from 2 ETH of virtual liquidity so the first buyers cannot take a large share cheaply: every buy raises the price, every sell lowers it. Anyone can trade the curve. (Coins launched before 26 September 2026 use the first curve: 800 million tokens, 1.4 ETH virtual.)</li>
            <li>
              When the curve holds 4.2 ETH, the token pops: trading on the curve stops and the ETH, with enough tokens to match the curve's last
              price, opens a Jangteo Swap pool. The pool's liquidity tokens are sent to a dead address, so that liquidity is locked forever.
              Tokens left over are burned.
            </li>
            <li>The last buy before graduation is filled only up to the line; anything over it is refunded in the same transaction.</li>
            <li>
              The token is an ordinary ERC20 from its first block. Other wallets and bots can trade it through the Ppeongtwigi router, which speaks
              Uniswap V2 and trades the curve before graduation and the pool after.
            </li>
          </ul>
          <h3 id="pump-fees">Fees and limits</h3>
          <ul>
            <li>1% of every curve trade: half to the token's creator, half to Jangteo.</li>
            <li>1% of the curve's ETH at graduation, to Jangteo. After graduation, trading pays the normal Jangteo Swap fee.</li>
            <li>A creator's own first buy is capped at 0.1 ETH (about 5% of the supply), so no launch starts with the creator holding much of the curve.</li>
            <li>Uploaded images are squared, re-encoded and stored on IPFS (or on Jangteo's server when IPFS is unavailable). Links must be https.</li>
          </ul>
        </section>

        <section id="insa">
          <h2>Insadong (NFTs)</h2>
          <p>
            Insadong is Seoul's street of galleries, and Jangteo's NFT market: it launches new collections and trades any ERC-721 on GIWA.
          </p>
          <h3 id="insa-drops">Drops and phases</h3>
          <ul>
            <li>A Dojang-verified creator launches a collection with its own contract: an edition (one artwork for every token) or a metadata folder.</li>
            <li>
              Minting runs in up to five phases, each with a window, a price (or free), a per-wallet cap, and optionally an allowlist. The allowlist
              is a Merkle root on-chain; the page checks the list file against that root before it builds your proof.
            </li>
            <li>A phase can be changed until it starts, never after. Supply can only go down. Metadata can change until the creator freezes it.</li>
            <li>Mint income splits at once: 0.5% to Jangteo (fixed per drop at launch, at most 10%), the rest to the creator.</li>
          </ul>
          <h3 id="insa-market">Listings, offers, royalties</h3>
          <ul>
            <li>
              A listing is a fixed ETH price with an expiry. The NFT stays in the seller's wallet; a listing whose seller no longer owns the item
              cannot be bought, and a buyer always pays exactly the listed price.
            </li>
            <li>An offer escrows ETH for one item or for any item of a collection. The buyer can cancel at any time; anyone can return an expired offer.</li>
            <li>
              Every sale pays the creator's ERC-2981 royalty (capped at 10%), then Jangteo's 0.5% (from 28 September 2026; 2% before. At most 5%, and a new fee only applies 48 hours
              after it is announced), then the seller. A wallet that refuses ETH is credited and withdraws later, so no one can block a sale.
            </li>
          </ul>
          <h3 id="insa-tal">Tal</h3>
          <p>
            Tal is Jangteo's own collection: 1,000 masks of Korean mask dance, drawn entirely on-chain by the Tal renderer from six traits
            (mask, wood, headwear, charm, backdrop, palette). Traits come from a seed taken from a block hash that nobody knows while the mint
            runs, revealed when it sells out or shortly after the public sale opens. Holders get 10% more season points.
          </p>
          <p>The mint opens with a whitelist event, then a public sale. Dates, prices and how to get on the whitelist are announced first on Jangteo's X and Discord.</p>
        </section>

        <section id="bridge">
          <h2>Bridge</h2>
          <p>
            Jangteo's bridge sits in front of GIWA's official bridge contracts. It never holds anyone's funds in between: the fee is taken and the
            rest goes into the official bridge in the same transaction.
          </p>
          <h3 id="bridge-in">To GIWA</h3>
          <p>Send ETH from Ethereum Sepolia and it arrives on GIWA in one to three minutes. Jangteo keeps 0.5%; the smallest deposit is 0.001 ETH.</p>
          <h3 id="bridge-out">To Ethereum</h3>
          <p>
            GIWA is an OP Stack chain with fault proofs. A withdrawal starts on GIWA, is proven on Ethereum about an hour later (once a dispute game
            covers its block), and can be claimed after a 7-day challenge window. Jangteo keeps 0.5% and proves and claims the withdrawal for you
            whenever that fee covers the Ethereum gas; for smaller ones, the Prove and Claim buttons on the bridge tab do it from your wallet.
          </p>
          <h3 id="bridge-fast">Fast withdrawals</h3>
          <ul>
            <li>
              Jangteo pays you on Ethereum from its own ETH a couple of minutes after your GIWA transaction, then collects the official withdrawal a
              week later. The fee is 1% plus 0.0005 ETH; one fast withdrawal is between 0.005 and 0.5 ETH.
            </li>
            <li>Above 0.1 ETH Jangteo waits until GIWA's data for your block is on Ethereum (a few minutes), so a sequencer reorg can't undo a payout.</li>
            <li>
              If Jangteo can't pay early, for example when its ETH on Ethereum runs low, the official withdrawal pays you the whole amount after 7
              days and the fee is refunded. Your ETH never depends on Jangteo.
            </li>
          </ul>
        </section>

        <section id="gye">
          <h2>Savings circles</h2>
          <p>
            A gye is a group that saves together. Every round each member pays the same amount, and one member takes the whole pot.
            After as many rounds as there are members, everyone has taken it exactly once. Whoever takes it early gets an interest-free
            advance; whoever takes it late has saved with the group's discipline behind them.
          </p>
          <p>
            The trouble with a gye has always been the member who takes the pot early and stops paying. Jangteo answers that with identity,
            collateral, holdback and a record that follows you, all enforced by the contract.
          </p>

          <h3 id="gye-round">A round, step by step</h3>
          <ol className="docs__steps">
            <li>
              <strong>Filling.</strong> The creator sets the payment, the number of seats (2 to 50), the round length (10 minutes or more on
              the testnet) and how the pot is given out. Joining puts down one round's payment as collateral. The circle starts the moment the
              last seat fills. A circle that doesn't fill in time can be cancelled by anyone, and collateral goes back.
            </li>
            <li>
              <strong>Paying.</strong> Each round, every member pays before the deadline. Late payments count until the round is closed.
            </li>
            <li>
              <strong>Closing the round.</strong> After the deadline anyone may close it; Jangteo's keeper does it within a minute. Missed
              payments are covered as described under <a href="#/docs/gye-missed">missed payments</a>, one member takes the pot, and the next
              round opens.
            </li>
            <li>
              <strong>Finishing.</strong> After the last round, everyone collects what's left: their collateral, any holdback, and anything
              owed to them. Each member's outcome is written to their record.
            </li>
          </ol>

          <h3 id="gye-modes">Who takes the pot</h3>
          <table className="docs__table">
            <thead>
              <tr><th scope="col">Mode</th><th scope="col">How the pot is given out</th></tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Take turns</th>
                <td>In the order members joined.</td>
              </tr>
              <tr>
                <th scope="row">Draw lots</th>
                <td>At random among members who haven't taken it yet and have paid this round.</td>
              </tr>
              <tr>
                <th scope="row">Bid for it</th>
                <td>
                  Members who have paid this round and haven't taken the pot yet bid the discount they'll accept. The biggest bid wins; the discount is split among everyone
                  else who paid that round, as interest. The creator caps the discount at up to 50% of the pot. With no bids, the pot is
                  drawn by lot.
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            In every mode, members who have paid the current round come first. Only if nobody eligible has paid does the pot go to someone
            who hasn't.
          </p>

          <h3 id="gye-holdback">Holdback and credit</h3>
          <p>
            When you take the pot while you still owe future rounds, part of it is held back in escrow. The escrow pays your remaining rounds
            if you stop, and whatever is left comes back to you at the end. How much is held back depends on your record:
          </p>
          <table className="docs__table docs__table--num">
            <thead>
              <tr><th scope="col">Circles finished cleanly</th><th scope="col">Share of what you still owe that is held back</th><th scope="col">Circles at once</th></tr>
            </thead>
            <tbody>
              <tr><td>0</td><td>100%</td><td>1</td></tr>
              <tr><td>1</td><td>80%</td><td>2</td></tr>
              <tr><td>2</td><td>60%</td><td>3</td></tr>
              <tr><td>3</td><td>40%</td><td>4</td></tr>
              <tr><td>4</td><td>25%</td><td>5</td></tr>
              <tr><td>5 or more</td><td>15%</td><td>5</td></tr>
            </tbody>
          </table>
          <p>
            There is a second limit. The unsecured part can never be larger than your <em>proven repayment</em>: everything you paid in
            circles you finished cleanly, minus credit you are already using elsewhere. Five tiny circles do not buy you a large advance in a
            big one.
          </p>
          <div className="docs__example">
            <p className="docs__example-title">Example</p>
            <p>
              Ten members pay {won(100_000)} a round, so the pot is {won(1_000_000)}. You take it in round 1 and still owe nine rounds,{" "}
              {won(900_000)}.
            </p>
            <p>
              First the 1% platform fee, {won(10_000)}, comes off the pot. As a newcomer, all {won(900_000)} you still owe must be secured.
              Your {won(100_000)} collateral counts, so {won(800_000)} is held back and {won(190_000)} is yours now.
            </p>
            <p>
              With one clean circle behind you, 20% of what you owe ({won(180_000)}) may go unsecured, provided your proven repayment covers
              it. Then {won(620_000)} is held back and {won(370_000)} is yours now.
            </p>
          </div>

          <h3 id="gye-missed">Missed payments</h3>
          <p>When a round closes, each member who didn't pay is handled in this order:</p>
          <ol className="docs__steps">
            <li>The payment comes out of that member's escrow: collateral first, then any holdback.</li>
            <li>
              If the escrow can't cover it, the shortfall becomes that member's debt, and the member who takes this round's pot is owed the
              same amount.
            </li>
            <li>
              A member who hasn't taken the pot yet repays that debt out of their own pot when their turn comes, and the member who was short
              is paid first. These debts settle themselves.
            </li>
            <li>
              A member who has already taken the pot and runs out of escrow is marked as defaulted. That is written to their record for good,
              and they can't join another circle.
            </li>
          </ol>
          <p>
            Anyone can pay back debt early from the circle page. Payments go straight to the members they are owed to. Because of the
            holdback, a newcomer who vanishes costs the others nothing; a trusted member who vanishes can cost at most the credit their record
            vouched for.
          </p>

          <h3 id="gye-record">Your record</h3>
          <p>Each circle ends with one of three outcomes for each member:</p>
          <table className="docs__table">
            <tbody>
              <tr><th scope="row">Clean</th><td>Paid every round on time. Counts toward your tier and your proven repayment.</td></tr>
              <tr><th scope="row">Late</th><td>Missed a round, but escrow or later payments covered it. Recorded, earns no credit.</td></tr>
              <tr><th scope="row">Default</th><td>Took the pot and left debt that escrow couldn't cover. Permanent; no new circles.</td></tr>
            </tbody>
          </table>
          <p>
            Outcomes are also written as attestations to GIWA's Ethereum Attestation Service, next to your Dojang identity. Any other app
            on GIWA can read them without asking Jangteo.
          </p>

          <h3 id="gye-limits">Limits and fees</h3>
          <ul>
            <li>2 to 50 members per circle; the form offers up to 20.</li>
            <li>Members may leave, and get their collateral back, only while the circle is still filling.</li>
            <li>A circle takes members for at most 30 days.</li>
            <li>A platform fee of 1% is taken from each pot when it is paid out. The rate is fixed when a circle is created and can never exceed 3%.</li>
          </ul>
        </section>

        <section id="sangjang">
          <h2>Listing markets</h2>
          <p>
            A new KRW market on Upbit is one of the biggest events a coin can have in Korea. Each listing market asks one question: will this
            coin get a KRW market on Upbit before this date? You back yes or no with test won.
          </p>

          <h3 id="sj-payout">How payouts work</h3>
          <p>
            Markets are parimutuel. All yes bets form one pool and all no bets another. When the market settles, the winning side gets its
            stakes back plus the losing pool, minus a 1% fee, shared in proportion to stake. The odds shown are simply each side's share of
            the money, and they move as people bet.
          </p>
          <div className="docs__example">
            <p className="docs__example-title">Example</p>
            <p>
              A puts {won(100_000)} and B puts {won(200_000)} on yes; {won(500_000)} is on no. Upbit lists the coin. The fee is 1% of the losing
              pool, {won(5_000)}, leaving {won(495_000)} to share one third to A and two thirds to B.
            </p>
            <p>
              A collects {won(265_000)} and B collects {won(530_000)}. Everyone on no loses their stake. If either side is empty when the
              market settles, it is voided and every stake comes back.
            </p>
          </div>

          <h3 id="sj-notice">The notice rule</h3>
          <p>
            Upbit announces a listing with a notice at an exact time, and whoever reads it first could bet on a sure thing. So every bet is
            stamped with its time, and only bets placed <strong>before</strong> the notice count. A bet at the same second or later is
            refunded in full and earns nothing. Nothing is gained by racing the notice.
          </p>

          <h3 id="sj-resolve">Settling a market</h3>
          <ol className="docs__steps">
            <li>
              <strong>Proposal.</strong> Jangteo's resolver reads Upbit's{" "}
              <a href="https://upbit.com/service_center/notice" target="_blank" rel="noreferrer">notice board</a> every minute. When a notice
              adds the coin to the KRW market, it proposes <em>yes</em> with the notice's time. When the deadline passes without one, it
              proposes <em>no</em>.
            </li>
            <li>
              <strong>Challenge window.</strong> For one hour anyone with a verified identity can dispute the proposal by putting up{" "}
              {won(50_000)}. Betting is closed from the proposal on.
            </li>
            <li>
              <strong>Final.</strong> Undisputed proposals become final when the hour is up, and winners can collect. A disputed market is
              decided by the operator; if the dispute was right, the bond is returned, otherwise it goes to the treasury.
            </li>
            <li>
              <strong>Void.</strong> If Upbit cancels a listing it announced, if the coin was announced before the market opened, or if one
              side is empty at the cutoff, the market is voided and every stake is refunded.
            </li>
          </ol>

          <h3 id="sj-curation">Which coins get a market</h3>
          <p>
            A curator keeps about ten markets open, each running 30 days. Candidates are coins with no Upbit KRW market yet that trade with
            real volume on Binance, with extra weight for coins already on Bithumb. Coins that cannot list in Korea are skipped, such as
            privacy coins and tokenized stocks.
          </p>

          <h3 id="sj-limits">Limits and fees</h3>
          <table className="docs__table">
            <tbody>
              <tr><th scope="row">Stake per person, per market</th><td>{won(1_000_000)}</td></tr>
              <tr><th scope="row">Bets per person, per market</th><td>32</td></tr>
              <tr><th scope="row">Fee</th><td>1% of the losing pool, only when a market settles</td></tr>
              <tr><th scope="row">Dispute bond</th><td>{won(50_000)}</td></tr>
              <tr><th scope="row">Challenge window</th><td>1 hour</td></tr>
            </tbody>
          </table>
        </section>

        <section id="cheongyak">
          <h2>Offerings</h2>
          <p>
            Cheongyak is how Koreans subscribe to an IPO. Since 2021, Korean IPOs split their retail shares in two: part goes equally to everyone
            who subscribes, however small, and the rest in proportion to deposits. Jangteo runs token sales on GIWA the same way. Because each
            verified person counts once, the equal half cannot be farmed with extra wallets.
          </p>

          <h3 id="cy-alloc">How allocation works</h3>
          <ol className="docs__steps">
            <li>An issuer puts the tokens in the contract and sets a fixed price, a window, the equal share and a per-person range.</li>
            <li>During the window, verified people deposit test won. You can top up until it closes.</li>
            <li>
              When it closes, the equal share is divided by the number of subscribers. Each person gets that many tokens, or fewer if their
              deposit buys fewer.
            </li>
            <li>What's left goes out in proportion to what each person still wanted, never more than they asked for.</li>
            <li>You pay the offer price only for what you got. Collect your tokens and the rest of your deposit at any time after.</li>
          </ol>
          <div className="docs__example">
            <p className="docs__example-title">Example</p>
            <p>
              1,000 tokens at {won(1_000)} each, half split equally. Four people deposit {won(10_000)}, {won(100_000)}, {won(500_000)} and{" "}
              {won(500_000)}, so they want 10, 100, 500 and 500 tokens.
            </p>
            <p>
              Equal: 500 ÷ 4 = 125 each, capped by demand, so 10, 100, 125 and 125. That uses 360; 640 are left for the two who want more,
              375 each, so each gets 320 more. Final: 10, 100, 445 and 445. The last two pay {won(445_000)} and get {won(55_000)} back.
            </p>
          </div>
          <p>
            The allocation runs in batches after the window closes, so an offering with thousands of subscribers still settles; Jangteo's
            keeper does it within a few minutes. The numbers are exact: the issuer receives exactly what subscribers paid.
          </p>

          <h3 id="cy-protect">Minimum raise, unlocks, liquidity</h3>
          <p>Three terms protect subscribers after the sale. Each is fixed when the offering is created and shown on its page.</p>
          <ul>
            <li>
              <strong>Minimum raise.</strong> If deposits end below it, the offering fails: every deposit comes back in full and the issuer
              takes the tokens back. Nobody is left holding a token from a sale that didn't happen.
            </li>
            <li>
              <strong>Unlocks.</strong> A share of each allocation can unlock at allocation and the rest evenly over time, after an optional
              cliff. Collect whatever has unlocked whenever you like. Refunds are never locked.
            </li>
            <li>
              <strong>Launch liquidity.</strong> Up to half of the proceeds, with tokens the issuer put up in advance, opens a Jangteo Swap pool at
              the offer price. The LP tokens stay in the offering contract for at least 30 days before the issuer can take them, so the
              pool can't be emptied right after launch. If someone has already moved that pool's price by more than 2%, no liquidity is
              added and the issuer is paid in full instead, so allocation never stalls.
            </li>
            <li>
              <strong>Verified.</strong> Jangteo's curators mark issuers they have reviewed. The mark has no power over funds, and it is not a
              guarantee.
            </li>
          </ul>
          <p>
            Jangteo Swap is the unmodified Uniswap V2 contracts, deployed from Uniswap's own published build, so any wallet or tool that
            speaks Uniswap V2 can trade these pools. Trade them on the Swap page: every swap pays the standard 0.3% pool fee, of which
            five sixths goes to liquidity providers and one sixth to the Jangteo treasury. Anyone can add liquidity to a pool, or
            open a new one, on the Liquidity tab: you deposit both tokens at the current price, receive LP tokens for your share, and can
            remove them at any time. Each pool's APR is its liquidity providers' fees over the last 7 days, annualised against its
            current liquidity; Jangteo's keeper recomputes it every 10 minutes.
          </p>

          <h3 id="cy-issuers">For issuers</h3>
          <ul>
            <li>You set the price, how many tokens, when it opens and for how long (up to 30 days), the equal share, and the smallest and largest deposit.</li>
            <li>You choose what subscribers pay in: test won or wrapped ETH.</li>
            <li>You can add a project profile (about, website, X, Telegram, Discord) and edit it until the window closes.</li>
            <li>You can withdraw the offering before it opens. After that it runs to the end.</li>
            <li>
              After allocation you receive the proceeds, less a 2% platform fee and the liquidity share, plus every token nobody took and any
              liquidity tokens the pool didn't use.
            </li>
            <li>On the testnet you can mint a token to try it from the offering form.</li>
          </ul>
        </section>

        <section id="points">
          <h2>Jangteo Points</h2>
          <p>
            Season 1 runs from 23 September to 31 October 2026 (KST). Every stall earns points: swaps and liquidity on Jangteo Swap, aggregator routes and limit or DCA
            fills, bridge moves both ways, Ppeongtwigi trades, Insadong mints and NFT sales, offering subscriptions, premarket trades and deliveries, finished yut games, circle contributions and clean finishes, and listing bets and wins, plus a
            little for every day you are active. The full table is on the <a href="#/points">points page</a>.
          </p>
          <p>
            Points are recomputed from GIWA's on-chain events every five minutes, so anyone can check them. Only Dojang-verified wallets are
            ranked, swaps and games have daily caps, and team wallets are shown but never ranked.
          </p>
          <h3 id="points-daily">Daily roulette and quests</h3>
          <ul>
            <li>
              Once each Korean day a verified wallet can spin the roulette for 10 to 500 points (about 35 on average). The result comes from the
              hash of the block after the spin, which nobody knows when they spin, and there is one spin a day, so it can't be re-rolled.
              Every seventh day in a row adds 100 points.
            </li>
            <li>
              Five quests a day: a swap (+20), a Ppeongtwigi trade (+20), a yut game (+20), an Insadong mint or NFT trade (+20) and a bridge
              move in either direction (+30). Any four on the same day add another 50.
            </li>
          </ul>
        </section>

        <section id="jangoe">
          <h2>Premarket</h2>
          <p>
            The premarket is where offering allocations change hands before they unlock, and where points programs trade
            before their token exists. Nothing can be handed over yet, so every trade is a promise, and the seller backs it with
            collateral held by the contract.
          </p>
          <h3 id="jg-trade">Offers and trades</h3>
          <ol className="docs__steps">
            <li>Any verified person can post an offer to buy or sell a number of units at a price in test won.</li>
            <li>A buy offer locks the full payment. A sell offer locks collateral, usually 100% of the value (150% for points markets).</li>
            <li>Anyone else can take all or part of an offer. Each fill becomes a trade, with the payment and collateral held until delivery.</li>
            <li>Cancel an offer at any time to get back whatever isn't filled.</li>
          </ol>
          <p>
            A market opens for every new offering automatically. The sell side shows each seller's record: how many trades they have
            delivered and how many they missed, across every market.
          </p>
          <h3 id="jg-deliver">Delivery and defaults</h3>
          <ul>
            <li>
              When the token exists, trading stops and the delivery window opens. One unit of an offering allocation is one token, and the window
              lasts until the last token unlocks, plus three days.
            </li>
            <li>A seller who delivers gets the payment and the collateral back, less a 2% fee on the payment. The tokens go straight to the buyer.</li>
            <li>
              A seller who misses the window loses the collateral: the buyer gets the payment back plus the collateral, less the same fee.
              Jangteo's keeper pays this out without the buyer having to do anything.
            </li>
            <li>If the offering fails its minimum raise or is withdrawn, the market is voided and every trade unwinds at no cost.</li>
          </ul>
        </section>

        <section id="yut">
          <h2>Yut</h2>
          <p>
            Yut is the board game Korean families play at Seollal. Jangteo runs it one on one between verified players, for a stake in test
            won held by the contract.
          </p>

          <h3 id="yut-rules">Rules</h3>
          <table className="docs__table">
            <thead>
              <tr><th scope="col">Throw</th><th scope="col">Sticks face up</th><th scope="col">Move</th><th scope="col">Chance</th></tr>
            </thead>
            <tbody>
              <tr><th scope="row">Do</th><td>1 flat</td><td>1</td><td>3 in 16</td></tr>
              <tr><th scope="row">Gae</th><td>2 flat</td><td>2</td><td>6 in 16</td></tr>
              <tr><th scope="row">Geol</th><td>3 flat</td><td>3</td><td>4 in 16</td></tr>
              <tr><th scope="row">Yut</th><td>4 flat</td><td>4, throw again</td><td>1 in 16</td></tr>
              <tr><th scope="row">Mo</th><td>none flat</td><td>5, throw again</td><td>1 in 16</td></tr>
              <tr><th scope="row">Back-do</th><td>only the marked stick flat</td><td>1 back</td><td>1 in 16</td></tr>
            </tbody>
          </table>
          <ul>
            <li>Each player has four pieces. Collect your throws, then spend them one at a time on any piece.</li>
            <li>A piece that stops on a corner takes the shortcut through the centre on its next move; one that stops on the centre heads straight home.</li>
            <li>Landing on your own piece stacks them and they move together. Landing on the other player's sends it back to the start and earns another throw.</li>
            <li>A back-do with nothing on the board is lost. The first to bring all four pieces home wins.</li>
          </ul>

          <h3 id="yut-dice">Fair throws</h3>
          <p>
            When you sit down, your wallet signs a message once. From that signature your browser builds a secret chain of 256 links and
            sends only its end to the contract. Each throw reveals the next link back, and the result mixes that link with the hash of the
            block after the previous move.
          </p>
          <ul>
            <li>Your opponent can't know your next link, so they can't predict your throw.</li>
            <li>Nobody, including the chain's sequencer, knows that block hash when the previous move is sent, and the sequencer never sees your link.</li>
            <li>You can't change your link or the block hash. The only choice left is not throwing, which loses on time.</li>
          </ul>
          <p>
            Who throws first is fixed by the hash of the block after the second player sits down, mixed with both players' commitments. Nobody
            knows that hash when they join, so neither player can choose to open.
          </p>
          <p>Wallets sign the same message the same way, so you can pick a game back up from another device with the same wallet.</p>

          <h3 id="yut-time">Time and stakes</h3>
          <ul>
            <li>Each move has 2 minutes. If the player to move runs out, the other player wins; Jangteo's keeper ends the game for them.</li>
            <li>The winner takes both stakes, less a 3% platform fee. You can resign at any time.</li>
            <li>An open table can be closed by its owner before anyone sits, and the stake comes back.</li>
            <li>Jangteo keeps one ₩10,000 table open with a house player, so there is always someone to play.</li>
          </ul>
        </section>

        <section id="contracts">
          <h2>Contracts</h2>
          <p>
            Every contract is verified, so its source can be read: on GIWA's explorer, and for the two Ethereum contracts on Sourcify and
            Blockscout.
          </p>
          {d ? (
            <table className="docs__table docs__table--addr">
              <tbody>
                {addr("Circle factory", d.factory, "creates each circle")}
                {addr("Circle template", d.implementation, "every circle is a copy of this")}
                {addr("Reputation", d.reputation, "records and EAS attestations")}
                {addr("Identity gate", d.gate, "checks Dojang Verified Address")}
                {addr("Listing markets", d.sangjang)}
                {addr("Offerings v2", d.cheongyakV2, "2% of proceeds")}
                {addr("Offerings, first contract", d.cheongyak, "earlier offerings")}
                {addr("Jangteo Swap factory", d.swapFactory, "Uniswap V2, unmodified")}
                {addr("Jangteo Swap router", d.swapRouter, "Uniswap V2 Router02")}
                {addr("Aggregator", d.aggregator, "routes across GIWA; 0.1% outside Jangteo Swap")}
                {addr("Limit orders and DCA", d.orders, "0.1% per fill; 48-hour keeper delay")}
                {addr("Ppeongtwigi v2", d.pump, "new coins: 2 ETH virtual, 0.1 ETH creator cap")}
                {addr("Ppeongtwigi v2 router", d.pumpRouter, "Uniswap V2 interface")}
                {addr("Ppeongtwigi v1", d.pumpV1, "coins launched before 26 Sep 2026")}
                {addr("Withdrawals", d.withdraw, "GIWA to Ethereum, 0.5%")}
                {addr("Fast withdrawals", d.fastExit, "1% + 0.0005 ETH")}
                {addr("Fast withdrawal vault", d.fastVault, "Ethereum Sepolia", true)}
                {addr("Bridge to GIWA", d.bridge, "Ethereum Sepolia, 0.5%", true)}
                {addr("Daily roulette", d.daily, "one spin a day")}
                {addr("Insadong drops", d.insaFactory, "launches collections, 0.5% of mint income")}
                {addr("Insadong market", d.insaMarket, "listings and offers, 0.5% per sale")}
                {addr("Tal", d.tal, "Jangteo's own collection, drawn on-chain")}
                {addr("Premarket", d.jangoe, "2% of delivered or forfeited payments")}
                {addr("Test token factory", d.tokenFactory, "for trying an offering")}
                {addr("Yut", d.yut, "3% of the pot")}
                {addr("Test won (tKRW)", d.tkrw, "draw ₩1,000,000 a day")}
                {addr("Dojang Scroll", d.dojangScroll, "GIWA")}
                {addr("EAS", d.eas, "GIWA predeploy")}
              </tbody>
            </table>
          ) : (
            <p className="empty">Reading addresses…</p>
          )}
          {d?.schemaUid && (
            <p>
              Circle outcomes use the EAS schema <code>{d.schemaUid}</code>:{" "}
              <code>address circle, uint8 outcome, uint256 contributedUsd, uint256 lossUsd, uint16 missedRounds</code>, where outcome 1 is
              clean, 2 is default and 3 is late.
            </p>
          )}
        </section>

        <section id="trust">
          <h2>What we can and can't do</h2>
          <p>The operator key can:</p>
          <ul>
            <li>list which tokens circles may use, change the shortest round length, and pause new circles;</li>
            <li>set the platform fee for circles created from then on (at most 3%);</li>
            <li>choose which Dojang attesters count as verified;</li>
            <li>decide disputed listing markets, and void a listing market so every stake is refunded;</li>
            <li>set the listing fee (at most 5%), the challenge window and the dispute bond;</li>
            <li>set the offering fee (at most 5%) and the yut fee (at most 10%), time per move and smallest stake, for offerings and games that start afterwards;</li>
            <li>set the aggregator fee (at most 1%) and the bridge fees (at most 1% in, 1% out, 3% fast);</li>
            <li>announce a new order keeper or order fee (at most 0.5%), which only takes effect 48 hours later;</li>
            <li>set Insadong's share of mint income for drops launched afterwards (at most 10%), and announce a new market fee (at most 5%, live after 48 hours).</li>
          </ul>
          <p>It cannot:</p>
          <ul>
            <li>move money out of a circle, or change a running circle's rules or fee;</li>
            <li>send a market's stakes anywhere except back to the people who placed them or to the winners;</li>
            <li>rewrite anyone's record;</li>
            <li>touch deposits in an offering, or stakes in a yut game, except to pay out by the rules above;</li>
            <li>move funds waiting in a limit or DCA order, or fill one below its owner's rate;</li>
            <li>redirect a fast withdrawal: when the official withdrawal lands, it pays whoever fronted it, or the user in full;</li>
            <li>move anyone's NFT, touch the ETH in an offer, or change a running mint phase.</li>
          </ul>
          <p>Known limits, stated plainly:</p>
          <ul>
            <li>
              This is a testnet and the contracts have not had an external audit. They are covered by unit tests, tests against live GIWA pools,
              static analysis and fuzzed invariants (for example, that order escrow always equals what open orders are owed).
            </li>
            <li>One operator key owns the contracts today. Before real money it should move to a multisig with a timelock.</li>
            <li>
              Drawing lots uses randomness from GIWA's sequencer, which could in principle bias it. A value-bearing mainnet version would use
              a verifiable random source.
            </li>
            <li>
              Records follow a wallet address. If one person could hold several Verified Addresses, a default would stay on the wallet where
              it happened.
            </li>
            <li>Listing results come from a resolver reading Upbit's public notices, checked by the challenge window, not from Upbit itself.</li>
          </ul>
          <p>
            The circle contracts are tested for two accounting rules after every action, across thousands of random sequences: the tokens
            held always equal what members are owed, and every debt matches an amount owed to someone.
          </p>
        </section>

        <section id="faq">
          <h2>Questions</h2>
          <dl className="docs__faq">
            <dt>Is this real money?</dt>
            <dd>No. Everything uses test ETH and test won on GIWA Sepolia.</dd>
            <dt>Why do some stalls need a verified identity?</dt>
            <dd>
              A circle only works if the people in it can't vanish and come back as someone new, and a market only works if nobody can split
              themselves into fifty bettors. Verification is what makes both possible without a company holding your money.
            </dd>
            <dt>Who closes rounds and settles markets?</dt>
            <dd>Anyone can. Jangteo runs a keeper that does it within a minute, so nothing waits on a person.</dd>
            <dt>I took the pot. Why did I get less than the full amount?</dt>
            <dd>
              The 1% platform fee comes off first, and part of the pot is held back to cover the rounds you still owe. You get the held-back
              part at the end, less anything used to cover rounds you missed. See <a href="#/docs/gye-holdback">holdback and credit</a>.
            </dd>
            <dt>My bet was refunded. Why?</dt>
            <dd>It was placed at or after the time of Upbit's notice. See <a href="#/docs/sj-notice">the notice rule</a>.</dd>
            <dt>Where are the other questions?</dt>
            <dd>
              On the <a href="#/faq">FAQ page</a>, with the full fee table.
            </dd>
            <dt>Does GIWA have a token or an airdrop?</dt>
            <dd>GIWA's own FAQ says the chain won't issue a token. Jangteo has no token either.</dd>
          </dl>
        </section>
      </article>
  );
}
