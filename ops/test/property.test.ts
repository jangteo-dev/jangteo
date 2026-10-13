import { test } from "node:test";
import assert from "node:assert/strict";
import { propertyAction, PS } from "../src/property.ts";

const MONTH = 2_592_000n;
const base = { status: PS.Active, sold: 1000n, totalShares: 1000n, endAt: 1000n, rentPerPeriod: 10n, lastPeriodAt: 10_000n, reserve: 30n, due: 0n };

test("funding: closes once sold out or past the deadline, not before", () => {
  const f = { ...base, status: PS.Funding, sold: 10n, endAt: 5000n };
  assert.equal(propertyAction(f, 4999, MONTH, 0n), null);
  assert.equal(propertyAction(f, 5000, MONTH, 0n), "finalize");
  assert.equal(propertyAction({ ...f, sold: 1000n }, 1, MONTH, 0n), "finalize");
});

test("active: books rent exactly when a period has passed", () => {
  assert.equal(propertyAction(base, 10_000 + Number(MONTH) - 1, MONTH, 1000n), null);
  assert.equal(propertyAction(base, 10_000 + Number(MONTH), MONTH, 1000n), "accrue");
});

test("active: pays rent that waited for eligible shares", () => {
  const waiting = { ...base, due: 10n };
  assert.equal(propertyAction(waiting, 10_001, MONTH, 0n), null);
  assert.equal(propertyAction(waiting, 10_001, MONTH, 5n), "accrue");
  assert.equal(propertyAction({ ...waiting, reserve: 0n }, 10_001, MONTH, 5n), null);
});

test("no keeper work for land, failed or sold properties", () => {
  const late = 10_000 + 5 * Number(MONTH);
  assert.equal(propertyAction({ ...base, rentPerPeriod: 0n }, late, MONTH, 1000n), null);
  assert.equal(propertyAction({ ...base, status: PS.Failed }, late, MONTH, 1000n), null);
  assert.equal(propertyAction({ ...base, status: PS.Sold }, late, MONTH, 1000n), null);
});
