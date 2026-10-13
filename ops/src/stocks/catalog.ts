import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi, stringToHex, type Address, type Hex } from "viem";
import { config } from "../config.ts";

/** The 16 stocks 장터 주식 lists, with where each one's price comes from. */
export interface Stock {
  sym: string; // on-chain market id (bytes32 of this string)
  region: 0 | 1; // 0 = Korea, 1 = US
  naver: string; // Naver Finance code
  yahoo: string; // Yahoo Finance symbol
  name: string;
  nameKo: string;
  ticker: string; // j-token symbol
}

export const STOCKS: Stock[] = [
  { sym: "005930", region: 0, naver: "005930", yahoo: "005930.KS", name: "Samsung Electronics", nameKo: "삼성전자", ticker: "jSAMSUNG" },
  { sym: "000660", region: 0, naver: "000660", yahoo: "000660.KS", name: "SK hynix", nameKo: "SK하이닉스", ticker: "jSKHYNIX" },
  { sym: "373220", region: 0, naver: "373220", yahoo: "373220.KS", name: "LG Energy Solution", nameKo: "LG에너지솔루션", ticker: "jLGES" },
  { sym: "005380", region: 0, naver: "005380", yahoo: "005380.KS", name: "Hyundai Motor", nameKo: "현대차", ticker: "jHYUNDAI" },
  { sym: "035420", region: 0, naver: "035420", yahoo: "035420.KS", name: "NAVER", nameKo: "NAVER", ticker: "jNAVER" },
  { sym: "035720", region: 0, naver: "035720", yahoo: "035720.KS", name: "Kakao", nameKo: "카카오", ticker: "jKAKAO" },
  { sym: "207940", region: 0, naver: "207940", yahoo: "207940.KS", name: "Samsung Biologics", nameKo: "삼성바이오로직스", ticker: "jSAMBIO" },
  { sym: "105560", region: 0, naver: "105560", yahoo: "105560.KS", name: "KB Financial", nameKo: "KB금융", ticker: "jKB" },
  { sym: "NVDA", region: 1, naver: "NVDA.O", yahoo: "NVDA", name: "NVIDIA", nameKo: "엔비디아", ticker: "jNVDA" },
  { sym: "AAPL", region: 1, naver: "AAPL.O", yahoo: "AAPL", name: "Apple", nameKo: "애플", ticker: "jAAPL" },
  { sym: "TSLA", region: 1, naver: "TSLA.O", yahoo: "TSLA", name: "Tesla", nameKo: "테슬라", ticker: "jTSLA" },
  { sym: "MSFT", region: 1, naver: "MSFT.O", yahoo: "MSFT", name: "Microsoft", nameKo: "마이크로소프트", ticker: "jMSFT" },
  { sym: "GOOGL", region: 1, naver: "GOOGL.O", yahoo: "GOOGL", name: "Alphabet", nameKo: "알파벳", ticker: "jGOOGL" },
  { sym: "AMZN", region: 1, naver: "AMZN.O", yahoo: "AMZN", name: "Amazon", nameKo: "아마존", ticker: "jAMZN" },
  { sym: "META", region: 1, naver: "META.O", yahoo: "META", name: "Meta", nameKo: "메타", ticker: "jMETA" },
  { sym: "COIN", region: 1, naver: "COIN.O", yahoo: "COIN", name: "Coinbase", nameKo: "코인베이스", ticker: "jCOIN" },
];

export const symId = (sym: string): Hex => stringToHex(sym, { size: 32 });

export function stocksAddresses(): { stocks: Address; stockOracle: Address } | null {
  const p = resolve(config.root, "../contracts/deployments/91342.stocks.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { stocks: Address; stockOracle: Address }) : null;
}

export const oracleAbi = parseAbi([
  "function post(bytes32[] syms, uint128[] prices, bool[] open)",
  "function priceOf(bytes32 sym) view returns (uint256 price, uint256 updatedAt, bool open)",
  "event Posted(bytes32 indexed sym, uint256 price, bool open)",
  "event Rejected(bytes32 indexed sym, uint256 price, uint256 last)",
]);

export const stocksAbi = parseAbi([
  "struct Market { address token; bytes32 sym; uint8 region; bool buyPaused; uint256 volume; }",
  "function marketCount() view returns (uint256)",
  "function market(uint256 i) view returns (Market)",
  "function marketOf(bytes32 sym) view returns (Market)",
  "function quoteOf(bytes32 sym) view returns (uint256 price, uint256 updatedAt, bool tradable, uint256 buyRoomKrw)",
  "function cash() view returns (uint256)",
  "function liability() view returns (uint256)",
  "function nav() view returns (uint256)",
  "function lpPrice() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function feesAccrued() view returns (uint256)",
  "function tradeBps() view returns (uint16)",
  "function protocolShareBps() view returns (uint16)",
  "function deposit(uint256 krw, uint256 minLp) returns (uint256)",
  "function withdraw(uint256 lp, uint256 minKrw) returns (uint256)",
  "function buy(bytes32 sym, uint256 krwIn, uint256 minShares) returns (uint256)",
  "function sell(bytes32 sym, uint256 shares, uint256 minKrw) returns (uint256)",
  "function sweepFees()",
  "event Bought(bytes32 indexed sym, address indexed buyer, uint256 krwIn, uint256 shares, uint256 price, uint256 fee)",
  "event Sold(bytes32 indexed sym, address indexed seller, uint256 shares, uint256 krwOut, uint256 price, uint256 fee)",
  "event Deposited(address indexed lp, uint256 krw, uint256 minted, uint256 nav)",
  "event Withdrawn(address indexed lp, uint256 burned, uint256 krw, uint256 fee, uint256 nav)",
]);
