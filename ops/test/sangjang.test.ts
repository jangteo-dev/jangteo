import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListing } from "../src/sangjang/upbit.ts";

const n = (title: string) => ({ id: 1, title, at: 0 });

test("KRW listing notices yield their tickers", () => {
  assert.deepEqual(parseListing(n("바이프로스트(BFC) KRW, USDT 마켓 디지털 자산 추가"))?.tickers, ["BFC"]);
  assert.deepEqual(parseListing(n("폴리스웜(NCT) KRW 마켓 디지털 자산 추가"))?.tickers, ["NCT"]);
  assert.deepEqual(parseListing(n("클러스터프로토콜(CP) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)"))?.tickers, ["CP"]);
  assert.deepEqual(
    parseListing(n("페이팔유에스디(PYUSD), 제이피와이코인(JPYC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓) (JPYC 거래지원 개시 시점 추가 변경 안내)"))?.tickers,
    ["PYUSD", "JPYC"],
  );
});

test("non-KRW listings, warnings, delistings and network notices are ignored", () => {
  assert.equal(parseListing(n("렌조(REZ) 신규 거래지원 안내 (USDT 마켓) (거래지원 개시 시점 추가 변경 안내)")), null);
  assert.equal(parseListing(n("소폰(SOPH) 거래 유의 종목 지정 안내")), null);
  assert.equal(parseListing(n("아이콘(ICX) 거래지원 종료 안내 (10/19 15:00)")), null);
  assert.equal(parseListing(n("유에스디코인(USDC) 입출금 가능 네트워크 추가 안내 (Arc 네트워크)")), null);
  assert.equal(parseListing(n("업비트 코인빌리기 신규 대여 자산 추가 안내 (ENA 외 5종)")), null);
});

test("cancellations are flagged for a human, not auto-resolved", () => {
  const p = parseListing(n("헤미(HEMI), 유즈리스(USELESS) 신규 거래지원 안내 (KRW, BTC 마켓) (헤미(HEMI) 거래지원 취소 안내)"));
  assert.ok(p?.cancelled);
  assert.deepEqual(p?.tickers, ["HEMI", "USELESS"]);
});
