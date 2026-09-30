// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title YutBoard — the 윷판 (yut board) and how a 말 (piece) travels on it.
///
///  Stations (the standard 29-point board, start corner at the bottom right):
///
///        10 ─ 9 ─ 8 ─ 7 ─ 6 ─ 5
///        │ 25               20 │
///       11    26         21    4
///       12       22 (방)       3
///       13    23         27    2
///       14 24               28 │   (27, 28 lead from the centre to 0)
///        15 ─16 ─17 ─18 ─19 ─ 0 (참먹이) → home
///
///  Outer ring: 0 → 1 … 19 → 0. Diagonal A: 5 → 20, 21, 22, 23, 24 → 15.
///  Diagonal B: 10 → 25, 26, 22, 27, 28 → 0.
///  A move that *starts* on a corner takes the shortcut: 5 → A, 10 → B, and the centre (22) → 27
///  (the short way home). Passing a corner without stopping stays on the current line.
///  A piece standing on 0 (참먹이) goes home with any forward step.
library YutBoard {
    uint8 internal constant OFF = 255; // not yet entered
    uint8 internal constant HOME = 254; // finished

    uint8 internal constant OUTER = 0;
    uint8 internal constant DIAG_A = 1;
    uint8 internal constant DIAG_B = 2;

    uint8 internal constant CENTER = 22;

    /// @notice One forward step. `first` is true for the first step of a move.
    function next(uint8 p, uint8 route, bool first) internal pure returns (uint8, uint8) {
        if (p == OFF) return (1, OUTER);
        if (p == HOME) return (HOME, OUTER);
        if (first) {
            if (p == 5) return (20, DIAG_A);
            if (p == 10) return (25, DIAG_B);
            if (p == CENTER) return (27, DIAG_B);
        }
        if (p == 0) return (HOME, OUTER);
        if (route == DIAG_A) {
            if (p == 24) return (15, OUTER);
            if (p >= 20 && p <= 23) return (p + 1, DIAG_A);
        }
        if (route == DIAG_B) {
            if (p == 25) return (26, DIAG_B);
            if (p == 26) return (CENTER, DIAG_B);
            if (p == CENTER) return (27, DIAG_B);
            if (p == 27) return (28, DIAG_B);
            if (p == 28) return (0, OUTER);
        }
        if (p == 19) return (0, OUTER);
        return (p + 1, OUTER);
    }

    /// @notice One step back (빽도). Pieces that are off the board or home cannot move back.
    function prev(uint8 p, uint8 route) internal pure returns (uint8, uint8) {
        if (p == 0) return (19, OUTER);
        if (route == DIAG_A) {
            if (p == 20) return (5, OUTER);
            if (p >= 21 && p <= 24) return (p - 1, DIAG_A);
        }
        if (route == DIAG_B) {
            if (p == 25) return (10, OUTER);
            if (p == 26) return (25, DIAG_B);
            if (p == CENTER) return (26, DIAG_B);
            if (p == 27) return (CENTER, DIAG_B);
            if (p == 28) return (27, DIAG_B);
        }
        if (p == 1) return (0, OUTER);
        return (p - 1, OUTER);
    }

    /// @notice Where a piece ends up after moving `steps` (−1 for 빽도, 1‥5 otherwise).
    function advance(uint8 p, uint8 route, int8 steps) internal pure returns (uint8, uint8) {
        if (steps < 0) return prev(p, route);
        for (uint8 i; i < uint8(steps); ++i) {
            (p, route) = next(p, route, i == 0);
            if (p == HOME) break;
        }
        return (p, route);
    }

    function onBoard(uint8 p) internal pure returns (bool) {
        return p != OFF && p != HOME;
    }

    /// @notice Four sticks, each flat side up with probability ½: 16 equally likely outcomes.
    ///         One stick is marked; 도 shown by the marked stick is 빽도.
    ///   r = 0 → 빽도 (−1), 1‥3 → 도 (1), 4‥9 → 개 (2), 10‥13 → 걸 (3), 14 → 윷 (4), 15 → 모 (5)
    function throwValue(uint256 rand) internal pure returns (int8) {
        uint256 r = rand % 16;
        if (r == 0) return -1;
        if (r <= 3) return 1;
        if (r <= 9) return 2;
        if (r <= 13) return 3;
        if (r == 14) return 4;
        return 5;
    }
}
