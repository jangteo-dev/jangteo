# 장터 주식 (Jangteo Stocks) — design

Status: approved by user 2026-10-12 (model A: oracle-priced synthetic stocks, Korean + US, LP vault with
fee share like Arcodian FX Pool v2). Testnet only, simulated assets.

## Markets

16 stocks, priced in tKRW per share (US prices × live USD/KRW):
KR 005930 Samsung Electronics, 000660 SK hynix, 373220 LG Energy Solution, 005380 Hyundai Motor,
035420 NAVER, 035720 Kakao, 207940 Samsung Biologics, 105560 KB Financial.
US NVDA, AAPL, TSLA, MSFT, GOOGL, AMZN, META, COIN.
Tokens `j<SYMBOL>` (18 decimals: fractional shares).

## Prices and hours

Ops reads Naver Finance realtime (`polling.finance.naver.com`) and cross-checks Yahoo Finance; posts
only when they agree (3% when both are live, 10% otherwise) and Naver reports `marketStatus=OPEN` and
`TRADING`. Korean hours therefore follow KRX + Nextrade (08:00–20:00 KST), US the regular session,
holidays included, with no hard-coded calendar. USD/KRW from Naver FX, cross-checked with Yahoo `KRW=X`.

`StockOracle`: one reporter (dedicated key, not the deployer), `post(syms, prices, open)`. A post that
moves a price more than 30% from a price under an hour old is rejected. Reporter change is
`proposeReporter` + 48 h timelock; `removeReporter` is instant (stops trading, moves no funds).

## Exchange + vault: `JangteoStocks` (also the LP token JSLP)

- Trading needs a fresh price (≤ 90 s) with `open = true`; otherwise buy/sell revert `MarketClosed`.
- `buy(sym, krwIn, minShares)`: Dojang-verified wallets only; fee 0.30% (80% stays in the vault for LPs,
  20% protocol); shares = (krwIn − fee) / price, minted.
- `sell(sym, shares, minKrw)`: anyone holding the token; burn; pays shares × price − 0.30%.
- Exposure caps at buy time: one stock's value ≤ 25% of vault cash, all stocks ≤ 75%. Sells never
  blocked by caps.
- Vault: `cash = tKRW balance − protocol fees`; `liability = Σ supply × last price`;
  `NAV = max(cash − liability, 0)`. LP `deposit(krw, minLp)` mints `krw × supply / NAV` (first deposit
  locks 1,000 wei LP at 0xdead); `withdraw(lp, minKrw)` pays `lp × NAV / supply` minus 0.30% (stays for
  LPs), after a 24 h lock from the last deposit (the lock travels with LP transfers).
- No owner path to funds: owner can list markets (≤ 32), pause buying a market, change fees within
  caps (trade ≤ 1%, LP ≤ 1%, protocol share ≤ 50%), and sweep only accrued protocol fees.

## Web

`#/stocks` board (KR / US tabs, open/closed + next open, red up / blue down), `#/stocks/:sym`
(TradingView candles built from oracle posts at 1m/5m/1h plus daily history, KST axis, ticket in ₩ or
shares, my position + P&L, on-chain tape), `#/stocks/pool` (deposit/withdraw, JSLP value, 7-day fee APR,
utilisation and exposure per stock, JSLP value chart). EN/KO, "simulated asset" label, phone layout.

## Ops

`stocks:oracle` (15 s while any market is open), `stocks:index` (stocks.json + stocks/<sym>.json
candles to the webroot), `stocks:seed` (team wallets drip test won daily into the vault as labelled
protocol-owned liquidity, until ₩50M), fee sweep, share-token verification, Telegram 📈 line, points
part `stocks` (1 P per ₩1,000 traded, LP 1 P per ₩1,000 per day), stats stall.

## Testing

Forge unit + fuzz + invariant (solvency, NAV, fee split, LP lock, caps, no stuck funds); live e2e on
GIWA Sepolia while KR market is open; UI e2e + mobile audit.
