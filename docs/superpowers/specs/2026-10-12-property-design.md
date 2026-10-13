# 장터 부동산 (Jangteo Property) — design

Status: approved by user 2026-10-12 (options A+B listing, exit option 1). Testnet only, simulated assets.

## Goal

Fractional property ownership on GIWA Sepolia: a property is split into shares sold for tKRW, holders
receive monthly rent pro rata, shares trade on a built-in market, and when the property is sold the
proceeds are paid out to holders who redeem their shares. Every state has an exit: nothing can stall,
no funds can be stranded by the design.

## Contracts

### `JangteoProperty` (registry, one deployment)

`Ownable2Step`, `ReentrancyGuard`. Quote token is fixed: tKRW (immutable). Gate: `DojangGate`.

Per property:

| Field | Meaning |
|---|---|
| `issuer` | creator; receives proceeds, pays rent, sells the property |
| `share` | its own `PropertyShare` ERC-20 (0 decimals: 1 unit = 1 share) |
| `totalShares`, `price` | shares for sale, tKRW (wei) per share |
| `minShares` | soft cap; below it at the deadline the sale fails |
| `endAt` | sale deadline (1 h – 30 days after creation) |
| `rentPerPeriod` | tKRW paid to all holders every 30 days (0 allowed: land) |
| `reserveMonths` | periods of rent held back from proceeds (≥3 if rent > 0, ≤24) |
| `verified` | curator badge (owner `setVerified`) |
| `status` | `Funding → Active | Failed`, `Active → Sold` |

Creation is open to Dojang-verified wallets. Constraint at creation:
`reserveMonths × rentPerPeriod ≤ minShares × price × (1 − feeBps)` so the reserve is always fundable.

**Sale.** `buy(id, shares)` (gated, Funding, before `endAt`, not over `totalShares`) takes
`shares × price` tKRW and mints shares to the buyer at once. Shares cannot move while Funding.
`finalize(id)` (anyone) once sold out or past `endAt`:
- sold ≥ `minShares` → Active: fee `feeBps` (2%) to `feesAccrued`, `reserveMonths × rent` kept as
  rent reserve, the rest transferred to the issuer. Rent clock starts.
- otherwise → Failed. `refund(id)` burns the caller's shares and returns `shares × price`.
Issuer or curator may `cancel(id)` while Funding → Failed (full refunds). After Active nobody can
touch holders' money.

**Rent.** Rent never loops. `accrue(id)` (anyone; also run inside every state change) computes
`periods = (now − lastPeriodAt) / 30 days`, adds `periods × rent` to `due`, then pays
`min(due, reserve)` from the reserve to holders by raising `accPerShare` over the eligible supply
(`totalSupply − shares held in market escrow`). If the eligible supply is 0 the payment waits.
`due > 0` after paying = 연체 (late) shown in the UI; arrears are paid first when the issuer tops up
with `fundReserve(id, amount)` (anyone may fund). Holders `claimRent(id)` any time, even after
selling or redeeming their shares. Balances changes settle rent first (share token hook).

**Share transfers.** `PropertyShare` only moves while Active (and burn on redeem). Receivers must be
Dojang-verified wallets or the registry (market escrow); this keeps shares out of AMM pools where
rent would be unclaimable, and mirrors "token securities for verified holders only".

**Market.** `list(id, shares, price)` moves shares into escrow (they stop earning rent),
`buyListing(listing, shares)` (gated, Active) pays `shares × price`; seller gets it minus 1% fee;
partial fills. `cancelListing` any time by the seller (also after Sold, to redeem).

**Exit.** `sell(id, amount)` (issuer, Active): accrue; arrears are paid from the reserve, then from
`amount`; the remaining reserve goes back to the issuer; exit fee 1% of the rest; the remainder is
the redemption pool. Status Sold, `exitSupply = totalSupply`. `redeem(id, shares)` burns and pays
`pool × shares / exitSupply`. Rent stops after Sold (claims of earned rent still work).

**Admin.** `setVerified`, `setGate`, `setFees(treasury, saleBps ≤ 500, tradeBps ≤ 300, exitBps ≤ 300)`
(applies to new properties; each property stores its fees), `sweepFees()` → treasury. No admin path
to holders' funds.

Invariant (fuzzed): `tKRW.balanceOf(registry) ≥ Σ(funding escrow) + Σreserve + Σunclaimed rent +
Σredemption pools left + fees`, and every listed share is held by the registry.

## Web

Routes `#/property` (list; verified first, "simulated asset" + "unverified" labels),
`#/property/:id` (gallery, facts, sale progress, rent schedule + 연체 status, market, my shares /
rent / refund / redeem), `#/property/new` (form with image upload via existing `upload-image.php`;
metadata JSON on-chain ≤ 4 KB). EN/KO strings in `i18n/strings.ts`; nav entry in the Stalls panel;
hub card. Balance guard before every approve (`mustHold`).

## Ops

`property:rent` (10 min): `accrue` every Active property with a period due. `fees:sweep` includes
the registry. Telegram dashboard line. Points part `property`: 1P per ₩1,000 bought (sale + market),
+20 per rent claim day (≤1/day). Stats stall `property`. Seed: three curated, verified demo
properties (Gangnam apartment, Jeonju hanok, Jeju land) with our own illustrations.

## Testing

Forge unit tests for every transition and revert, fuzz on amounts/time, invariant handler
(buy/finalize/refund/list/buyListing/cancel/accrue/fund/claim/sell/redeem with warps). Live e2e on
GIWA Sepolia with QA wallets: success path and failed-sale refund path. UI e2e flow + mobile audit.

## Out of scope (later)

Buy-side bids on the market, holder voting, tokenized stocks (separate spec, next).
