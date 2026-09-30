<p align="center">
  <a href="https://jangteo.org"><img src="brand/jangteo-brand-kit/logo/jangteo-lockup-light.svg" alt="장터 Jangteo" width="360"></a>
</p>

<p align="center">
  <b>Korean crypto markets on <a href="https://giwa.io">GIWA</a>, Upbit's Ethereum layer 2.</b><br>
  Swap, launch, trade NFTs, subscribe to offerings and play yut, one verified person per wallet.
</p>

<p align="center">
  <a href="https://jangteo.org"><img alt="Website" src="https://img.shields.io/badge/web-jangteo.org-1f2a44"></a>
  <a href="https://x.com/jangteo_org"><img alt="X" src="https://img.shields.io/badge/X-@jangteo__org-000000?logo=x"></a>
  <img alt="Network" src="https://img.shields.io/badge/GIWA%20Sepolia-91342-2f4a9e">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-3a7d5c">
</p>

---

## What's inside

| Stall | What it does |
|---|---|
| **스왑 Swap** | Uniswap V2 AMM, plus an aggregator that routes through every DEX on GIWA. Limit and DCA orders. |
| **뻥튀기 Ppeongtwigi** | Token launchpad on a bonding curve. At 4.2 ETH the curve graduates to Jangteo Swap with its liquidity locked forever. Creator fees are paid in ETH. |
| **인사동 Insadong** | NFT marketplace. Anyone can create a collection by uploading art, with whitelist and public phases and a royalty of their choice. |
| **청약 Offerings** | Token sales allocated the Korean IPO way: an equal share for every subscriber and the rest pro rata. |
| **장외 Premarket** | Trade tokens before they exist, with collateral. |
| **상장 Listings** | Prediction markets on the next Upbit KRW listings. |
| **계 Gye** | On-chain rotating savings circles with a reputation record and escrowed credit. |
| **윷놀이 Yut** | One-on-one yut for a stake. Throws come from a hash chain and the next block, so nobody can steer them. |
| **브릿지 Bridge** | ETH between Ethereum and GIWA through GIWA's own bridge, with an optional fast exit. |
| **포인트 Points** | Season points for everything above, counted only from on-chain events. Includes a daily roulette, quests and friend invites. |

Rankings, offerings, circles and the roulette are open to **[Dojang](https://docs.giwa.io/giwa-ecosystem/dojang.md) Verified Addresses**, so one person counts once.

## Repository

```
contracts/   Solidity (Foundry): every Jangteo contract, with unit, fuzz and invariant tests
web/         The app: Vite + React + viem, English and Korean
ops/         Keepers and indexers: settlement, bridge relays, order execution, points, health checks
brand/       Logo, colours and social assets
scripts/     Deployment helpers
```

## Build and test

```bash
# contracts
cd contracts
forge install --no-git foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0
forge test

# web
cd web && pnpm install && pnpm dev

# ops (keeper keys come from an env file kept outside the repository)
cd ops && pnpm install && pnpm test
```

## Contracts on GIWA Sepolia

All verified on the [GIWA explorer](https://sepolia-explorer.giwa.io).

| Contract | Address |
|---|---|
| Swap factory | [`0x7333…4BD1`](https://sepolia-explorer.giwa.io/address/0x73331f9080972D224a80B91DdD844585C57d4BD1) |
| Swap router | [`0x7789…8528`](https://sepolia-explorer.giwa.io/address/0x7789b16634b95801fFBFE4d2F7A90B1cd41c8528) |
| Aggregator | [`0x2FA9…D1BC`](https://sepolia-explorer.giwa.io/address/0x2FA909C6b98497Ff3b5B10AbA7A0Db98Ab5CD1BC) |
| Limit and DCA orders | [`0x5Eec…0C46`](https://sepolia-explorer.giwa.io/address/0x5Eec48923F7eDd11185379115D9A1f18c2040C46) |
| Ppeongtwigi | [`0x0b5A…0505`](https://sepolia-explorer.giwa.io/address/0x0b5A5A5E9397Eb5065E4712EAB3cfC0F6C520505) |
| Ppeongtwigi router | [`0x8099…A70D`](https://sepolia-explorer.giwa.io/address/0x8099DbFb54aAE43f3cA0E4ce5bc732eba6e0A70D) |
| Insadong factory | [`0x9aD7…3F8e`](https://sepolia-explorer.giwa.io/address/0x9aD7a62616Dac475259912A13A45673C05663F8e) |
| Insadong market | [`0xF17C…91E0`](https://sepolia-explorer.giwa.io/address/0xF17C6472788a23dA5756BE3789501F137e4d91E0) |
| Offerings | [`0x7304…FCDA`](https://sepolia-explorer.giwa.io/address/0x73041B40b2300E3Fbd7f680bB7029A9EC1BdFCDA) |
| Premarket | [`0x3F49…f1ba`](https://sepolia-explorer.giwa.io/address/0x3F49F6b1528de66F32fafd1aa29251F01e8Cf1ba) |
| Listings | [`0xb807…A8eE`](https://sepolia-explorer.giwa.io/address/0xb8072aD677CE6b53619e5e8db0849D78e8ADA8eE) |
| Gye factory | [`0x469C…b9ab`](https://sepolia-explorer.giwa.io/address/0x469CDf0246Bc0D5837ebB977C4ef31daec24b9ab) |
| Yut | [`0x4EB6…957E`](https://sepolia-explorer.giwa.io/address/0x4EB69dA44aA6d85A384488e58557745E97Cb957E) |
| Bridge withdrawals | [`0xAf1F…3990`](https://sepolia-explorer.giwa.io/address/0xAf1FBbF8f31e7C403F7ab857a6254F5929A63990) |
| Fast exit | [`0xc2E8…2cbC`](https://sepolia-explorer.giwa.io/address/0xc2E8026a6d4141FEC5182d79d1DB68B1CD322cbC) |
| Daily roulette | [`0x1144…Bf74`](https://sepolia-explorer.giwa.io/address/0x1144522d39215462b4F85bf743Df7062F914Bf74) |
| Invites | [`0xc4b2…3AC8`](https://sepolia-explorer.giwa.io/address/0xc4b2aE70b135CD6A9F5b7f143Ea9d205C0c03AC8) |

The full list lives in [`contracts/deployments/`](contracts/deployments).

## Security

Found a vulnerability? Please email **developer@jangteo.org** instead of opening a public issue.

## Links

- Website: [jangteo.org](https://jangteo.org)
- X: [@jangteo_org](https://x.com/jangteo_org)
- Contact: developer@jangteo.org

Jangteo runs on GIWA Sepolia, a testnet. Test tokens have no value.

## License

[MIT](LICENSE)
