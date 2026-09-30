import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, chooseMove, HOME, OFF } from "../src/yut/board.ts";

const empty = () => ({ pos: Array(8).fill(OFF), route: Array(8).fill(0) });

test("board mirrors the contract's paths", () => {
  assert.equal(advance(OFF, 0, 5), 5);
  assert.equal(advance(5, 0, 3), 22);
  assert.equal(advance(22, 1, 1), 27);
  assert.equal(advance(22, 2, 4), HOME);
  assert.equal(advance(20, 1, -1), 5);
  assert.equal(advance(19, 0, 2), HOME);
});

test("bot captures when it can", () => {
  const { pos, route } = empty();
  pos[0] = 2; // bot (player 0) piece on 2
  pos[4] = 4; // opponent on 4
  const c = chooseMove(pos, route, [2, 1], 0);
  assert.deepEqual([c?.slot, c?.piece], [0, 0], "개 from 2 lands on 4");
});

test("bot brings a piece home over plain progress", () => {
  const { pos, route } = empty();
  pos[0] = 0; // on 참먹이
  pos[1] = 3;
  const c = chooseMove(pos, route, [1], 0);
  assert.equal(c?.piece, 0);
});

test("a 빽도 with nothing on the board has no move", () => {
  const { pos, route } = empty();
  assert.equal(chooseMove(pos, route, [-1], 0), null);
});
