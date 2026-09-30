/** Mirror of YutBoard.sol, used by the house bot to choose moves. */
export const OFF = 255;
export const HOME = 254;

function next(p: number, r: number, first: boolean): [number, number] {
  if (p === OFF) return [1, 0];
  if (p === HOME) return [HOME, 0];
  if (first) {
    if (p === 5) return [20, 1];
    if (p === 10) return [25, 2];
    if (p === 22) return [27, 2];
  }
  if (p === 0) return [HOME, 0];
  if (r === 1) {
    if (p === 24) return [15, 0];
    if (p >= 20 && p <= 23) return [p + 1, 1];
  }
  if (r === 2) {
    if (p === 25) return [26, 2];
    if (p === 26) return [22, 2];
    if (p === 22) return [27, 2];
    if (p === 27) return [28, 2];
    if (p === 28) return [0, 0];
  }
  if (p === 19) return [0, 0];
  return [p + 1, 0];
}

function prev(p: number, r: number): [number, number] {
  if (p === 0) return [19, 0];
  if (r === 1) {
    if (p === 20) return [5, 0];
    if (p >= 21 && p <= 24) return [p - 1, 1];
  }
  if (r === 2) {
    if (p === 25) return [10, 0];
    if (p === 26) return [25, 2];
    if (p === 22) return [26, 2];
    if (p === 27) return [22, 2];
    if (p === 28) return [27, 2];
  }
  if (p === 1) return [0, 0];
  return [p - 1, 0];
}

export function advance(p: number, r: number, steps: number): number {
  if (steps < 0) return prev(p, r)[0];
  for (let i = 0; i < steps; i++) {
    [p, r] = next(p, r, i === 0);
    if (p === HOME) break;
  }
  return p;
}

/** Rough distance still to travel, for preferring progress and judging danger. */
export function remaining(p: number, r: number): number {
  if (p === HOME) return 0;
  let n = 0;
  for (let i = 0; i < 40 && p !== HOME; i++) {
    [p, r] = next(p, r, i === 0);
    n++;
  }
  return n;
}

const onBoard = (p: number) => p !== OFF && p !== HOME;

export interface Choice {
  slot: number;
  piece: number;
  score: number;
}

/**
 * Picks the best (throw, piece) for `me`: capture first, then bring pieces home, then stack,
 * then plain progress; entering a new piece is fine but moving an advanced one home is better.
 */
export function chooseMove(pos: number[], route: number[], pending: number[], me: 0 | 1): Choice | null {
  const mine = [0, 1, 2, 3].map((i) => me * 4 + i);
  const theirs = [0, 1, 2, 3].map((i) => (1 - me) * 4 + i);
  let best: Choice | null = null;
  pending.forEach((v, slot) => {
    const seenFrom = new Set<number>();
    for (const idx of mine) {
      const from = pos[idx];
      if (from === HOME) continue;
      if (v < 0 && !onBoard(from)) continue;
      // A stack moves together, so trying one piece of it is enough.
      if (onBoard(from)) {
        if (seenFrom.has(from)) continue;
        seenFrom.add(from);
      }
      const to = advance(from, route[idx], v);
      let score = 0;
      if (to === HOME) score += 60;
      if (onBoard(to) && theirs.some((j) => pos[j] === to)) score += 100;
      if (onBoard(to) && mine.some((j) => j !== idx && pos[j] === to)) score += 12;
      score += remaining(from, route[idx]) - remaining(to, 0);
      if (from === OFF) score -= 2;
      if (!best || score > best.score) best = { slot, piece: idx - me * 4, score };
    }
  });
  return best;
}
