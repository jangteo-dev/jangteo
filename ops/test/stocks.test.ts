import { test } from "node:test";
import assert from "node:assert/strict";
import { agree, cleanNum, toWei } from "../src/stocks/feed.ts";
import { candles, toPost } from "../src/stocks/tasks.ts";
import type { Quote } from "../src/stocks/feed.ts";

test("cleanNum reads Naver's formatted numbers and rejects anything else", () => {
  assert.equal(cleanNum("1,608,000"), "1608000");
  assert.equal(cleanNum("-0.52"), "-0.52");
  assert.equal(cleanNum("229.28"), "229.28");
  assert.equal(cleanNum("N/A"), null);
  assert.equal(cleanNum(undefined), null);
  assert.equal(cleanNum("1e5"), null);
});

test("toWei: won exact, dollars × rate exact to 6 decimals", () => {
  assert.equal(toWei("250500", 0), 250500n * 10n ** 18n);
  // 229.28 × 1331.80 = 305,355.104
  assert.equal(toWei("229.28", 1, "1331.8000"), 305355104000000000000000n);
  assert.throws(() => toWei("229.28", 1));
});

test("agree: tolerance in basis points of the smaller price", () => {
  assert.equal(agree(100, 103, 300), true);
  assert.equal(agree(100, 103.1, 300), false);
  assert.equal(agree(0, 100, 300), false);
});

const q = (sym: string, open: boolean) => ({ sym, open }) as Quote;
test("toPost: open markets always, a closing market at once, closed ones every 30 min", () => {
  const now = 10_000;
  const last = { A: { open: true, at: now - 15 }, B: { open: false, at: now - 60 }, C: { open: false, at: now - 1800 } };
  const out = toPost([q("A", false), q("B", false), q("C", false), q("D", false), q("E", true)], last, now).map((x) => x.sym);
  assert.deepEqual(out, ["A", "C", "D", "E"]);
});

test("candles bucket ticks into OHLC", () => {
  const c = candles([{ t: 60, price: 10 }, { t: 70, price: 12 }, { t: 100, price: 9 }, { t: 125, price: 11 }], 60);
  assert.deepEqual(c, [
    { time: 60, open: 10, high: 12, low: 9, close: 9 },
    { time: 120, open: 11, high: 11, low: 11, close: 11 },
  ]);
});

import { positions } from "../src/stocks/tasks.ts";
test("positions: average cost, partial sells keep the average", () => {
  const p = positions([
    { who: "a", sym: "X", side: "buy", krw: 1000, shares: 10 },
    { who: "a", sym: "X", side: "buy", krw: 3000, shares: 10 },
    { who: "a", sym: "X", side: "sell", krw: 1500, shares: 5 },
  ]);
  assert.equal(p.a.X.shares, 15);
  assert.equal(p.a.X.cost, 3000); // average 200 a share before and after
  const q = positions([{ who: "b", sym: "Y", side: "buy", krw: 10, shares: 1 }, { who: "b", sym: "Y", side: "sell", krw: 12, shares: 1 }]);
  assert.equal(q.b.Y, undefined);
});

import { mergeCandles } from "../src/stocks/tasks.ts";
test("mergeCandles: our ticks win their bucket, exchange history fills the rest", () => {
  const c = (time: number, close: number) => ({ time, open: close, high: close, low: close, close });
  assert.deepEqual(mergeCandles([c(60, 1), c(120, 2), c(180, 3)], [c(120, 9), c(240, 4)]).map((x) => [x.time, x.close]), [
    [60, 1],
    [120, 9],
    [180, 3],
    [240, 4],
  ]);
});
