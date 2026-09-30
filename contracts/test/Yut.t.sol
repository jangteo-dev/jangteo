// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {YutBoard} from "../src/yut/YutBoard.sol";
import {YutGame} from "../src/yut/YutGame.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll} from "./mocks/Mocks.sol";

contract YutBoardTest is Test {
    uint8 constant OFF = 255;
    uint8 constant HOME = 254;

    function _go(uint8 p, uint8 r, int8 s) internal pure returns (uint8 to) {
        (to,) = YutBoard.advance(p, r, s);
    }

    function test_EnteringAndOuterRing() public pure {
        assertEq(_go(OFF, 0, 1), 1);
        assertEq(_go(OFF, 0, 5), 5);
        assertEq(_go(4, 0, 5), 9, "passing corner 5 stays on the ring");
        assertEq(_go(18, 0, 2), 0, unicode"19 then 참먹이");
        assertEq(_go(19, 0, 2), HOME);
        assertEq(_go(0, 0, 1), HOME, unicode"any step from 참먹이 is home");
    }

    function test_ShortcutsFromCorners() public pure {
        assertEq(_go(5, 0, 3), 22, unicode"5 → 20, 21, center");
        assertEq(_go(10, 0, 4), 27, unicode"10 → 25, 26, center, 27");
        assertEq(_go(22, 1, 1), 27, "stopping on the center heads home");
        assertEq(_go(22, 2, 3), 0, unicode"center → 27, 28, then 참먹이");
        assertEq(_go(22, 2, 4), HOME, "one more step goes home");
        assertEq(_go(21, 1, 3), 24, "passing the center on A stays on A");
        assertEq(_go(24, 1, 1), 15);
        assertEq(_go(26, 2, 2), 27, "passing the center on B stays on B");
        assertEq(_go(28, 2, 1), 0);
    }

    function test_Backdo() public pure {
        assertEq(_go(20, 1, -1), 5);
        assertEq(_go(25, 2, -1), 10);
        assertEq(_go(1, 0, -1), 0);
        assertEq(_go(0, 0, -1), 19);
        assertEq(_go(27, 2, -1), 22);
    }

    function test_StickOddsMatchFourFairSticks() public pure {
        int8[6] memory vals = [int8(-1), 1, 2, 3, 4, 5];
        uint8[6] memory want = [1, 3, 6, 4, 1, 1];
        for (uint256 k; k < 6; ++k) {
            uint8 n;
            for (uint256 r; r < 16; ++r) {
                if (YutBoard.throwValue(r) == vals[k]) ++n;
            }
            assertEq(n, want[k]);
        }
    }
}

contract YutGameTest is Test {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");
    uint128 constant STAKE = 100_000e18;

    MockToken won;
    MockScroll scroll;
    YutGame yut;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    mapping(address => bytes32[257]) chains;
    mapping(address => uint16) used;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1000);
        won = new MockToken(18);
        scroll = new MockScroll();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        yut = new YutGame(owner, IERC20(address(won)), gate, treasury, 300, 120, 1_000e18);
        for (uint256 i; i < 2; ++i) {
            address p = i == 0 ? alice : bob;
            scroll.set(p, UPBIT, true);
            won.mint(p, 10_000_000e18);
            vm.prank(p);
            won.approve(address(yut), type(uint256).max);
            _makeChain(p, keccak256(abi.encode("secret", p)));
        }
    }

    function _makeChain(address p, bytes32 secret) internal {
        chains[p][0] = secret;
        for (uint256 k = 1; k <= 256; ++k) {
            chains[p][k] = keccak256(abi.encodePacked(chains[p][k - 1]));
        }
        used[p] = 0;
    }

    function _tip(address p) internal view returns (bytes32) {
        return chains[p][256];
    }

    function _start() internal returns (uint256 id, address first, address second) {
        vm.prank(alice);
        id = yut.create(STAKE, _tip(alice), bytes32("salt-a"));
        vm.prank(bob);
        yut.join(id, _tip(bob), bytes32("salt-b"));
        // The opener is fixed by the block after the join: let it exist, then settle it.
        uint256 joined = vm.getBlockNumber();
        vm.roll(joined + 2);
        vm.setBlockhash(joined + 1, keccak256(abi.encode("opener", id)));
        yut.decideOpener(id);
        YutGame.Game memory g = yut.game(id);
        first = g.players[g.turn];
        second = g.players[1 - g.turn];
    }

    /// The joiner cannot choose who opens: in the join block the opener is unknown to everyone,
    /// and it follows the next block's hash, whatever tip the joiner picked.
    function test_JoinerCannotPickTheOpener() public {
        vm.prank(alice);
        uint256 id = yut.create(STAKE, _tip(alice), bytes32("salt-a"));
        vm.prank(bob);
        yut.join(id, _tip(bob), bytes32("salt-b"));
        assertEq(yut.game(id).turn, 2, "undecided in the join block");
        vm.expectRevert(YutGame.TooSoon.selector);
        yut.decideOpener(id);
        uint256 joined = vm.getBlockNumber();
        vm.roll(joined + 2);
        // The same game, different next-block hashes: both openers happen, so the tip alone decides nothing.
        bool sawAlice;
        bool sawBob;
        for (uint256 i; i < 16 && !(sawAlice && sawBob); ++i) {
            vm.setBlockhash(joined + 1, keccak256(abi.encode(i)));
            uint8 t = yut.game(id).turn;
            assertLt(t, 2);
            if (t == 0) sawAlice = true;
            else sawBob = true;
        }
        assertTrue(sawAlice && sawBob, "opener depends on the future block, not on the joiner");
        yut.decideOpener(id);
        uint8 fixedTurn = yut.game(id).turn;
        vm.setBlockhash(joined + 1, keccak256("changed later"));
        assertEq(yut.game(id).turn, fixedTurn, "once settled it never changes");
    }

    /// @dev Throw exactly `want` by choosing the blockhash the outcome is mixed with.
    function _throw(uint256 id, address p, int8 want) internal {
        YutGame.Game memory g = yut.game(id);
        uint256 target = g.lastBlock + 1;
        vm.roll(g.lastBlock + 2);
        bytes32 link = chains[p][256 - used[p] - 1];
        for (uint256 i; ; ++i) {
            bytes32 bh = keccak256(abi.encode(i));
            if (YutBoard.throwValue(uint256(keccak256(abi.encodePacked(link, bh)))) == want) {
                vm.setBlockhash(target, bh);
                break;
            }
        }
        used[p] += 1;
        vm.prank(p);
        yut.throwSticks(id, link);
    }

    function _move(uint256 id, address p, uint8 slot, uint8 piece) internal {
        vm.roll(block.number + 1);
        vm.prank(p);
        yut.move(id, slot, piece);
    }

    function _mine(YutGame.Game memory g, uint8 player, uint8 piece) internal pure returns (uint8) {
        return g.pos[player * 4 + piece];
    }

    // ─────────────────────────────── lobby ──────────────────────────────────

    function test_CreateJoinEscrowsBothStakes() public {
        (uint256 id,,) = _start();
        assertEq(won.balanceOf(address(yut)), 2 * STAKE);
        assertEq(uint8(yut.game(id).status), uint8(YutGame.Status.Playing));
    }

    function test_UnverifiedCannotPlay() public {
        address eve = makeAddr("eve");
        won.mint(eve, 1e24);
        vm.startPrank(eve);
        won.approve(address(yut), type(uint256).max);
        vm.expectRevert(YutGame.NotEligible.selector);
        yut.create(STAKE, bytes32(uint256(1)), 0);
        vm.stopPrank();
    }

    function test_CancelOpenGameRefunds() public {
        vm.prank(alice);
        uint256 id = yut.create(STAKE, _tip(alice), 0);
        vm.prank(alice);
        yut.cancel(id);
        uint256 before = won.balanceOf(alice);
        vm.prank(alice);
        yut.claim();
        assertEq(won.balanceOf(alice), before + STAKE);
    }

    // ─────────────────────────────── throwing ───────────────────────────────

    function test_ThrowNeedsTheNextLinkAndTheRightPlayer() public {
        (uint256 id, address first, address second) = _start();
        vm.roll(block.number + 2);
        vm.prank(second);
        vm.expectRevert(YutGame.NotYourTurn.selector);
        yut.throwSticks(id, chains[second][255]);
        vm.prank(first);
        vm.expectRevert(YutGame.BadReveal.selector);
        yut.throwSticks(id, chains[first][254]);
    }

    function test_CannotThrowInTheSameOrNextBlock() public {
        vm.prank(alice);
        uint256 id = yut.create(STAKE, _tip(alice), bytes32("salt-a"));
        vm.prank(bob);
        yut.join(id, _tip(bob), bytes32("salt-b"));
        uint256 joined = vm.getBlockNumber();
        // Join block: nobody (not even the opener) can throw yet.
        for (uint256 k; k < 2; ++k) {
            address p = k == 0 ? alice : bob;
            vm.prank(p);
            vm.expectRevert(YutGame.TooSoon.selector);
            yut.throwSticks(id, chains[p][255]);
        }
        // The next block exists only once we are past it; one block later is still too soon.
        vm.roll(joined + 1);
        vm.prank(alice);
        vm.expectRevert(YutGame.TooSoon.selector);
        yut.throwSticks(id, chains[alice][255]);
    }

    function test_YutGivesAnotherThrowThenMovesInAnyOrder() public {
        (uint256 id, address first,) = _start();
        uint8 me = yut.game(id).turn;
        _throw(id, first, 4); // 윷 → throw again
        assertEq(uint8(yut.game(id).phase), uint8(YutGame.Phase.Throwing));
        _throw(id, first, 3); // 걸
        YutGame.Game memory g = yut.game(id);
        assertEq(uint8(g.phase), uint8(YutGame.Phase.Moving));
        assertEq(g.pendingCount, 2);
        _move(id, first, 1, 0); // 걸 first: piece 0 → 3
        _move(id, first, 0, 0); // then 윷: 3 → 7
        g = yut.game(id);
        assertEq(_mine(g, me, 0), 7);
        assertEq(g.turn, 1 - me, "turn passes");
    }

    function test_BackdoWithNothingOnBoardIsLost() public {
        (uint256 id, address first,) = _start();
        uint8 me = yut.game(id).turn;
        _throw(id, first, -1);
        YutGame.Game memory g = yut.game(id);
        assertEq(g.pendingCount, 0);
        assertEq(g.turn, 1 - me);
    }

    // ─────────────────────────── stacking / capture ─────────────────────────

    function test_StackedPiecesMoveTogether() public {
        (uint256 id, address first, address second) = _start();
        uint8 me = yut.game(id).turn;
        _throw(id, first, 4);
        _throw(id, first, 2);
        _move(id, first, 1, 0); // piece 0 → 2
        _move(id, first, 0, 1); // piece 1 → 4
        _throw(id, second, 1);
        _move(id, second, 0, 0);
        _throw(id, first, 2);
        _move(id, first, 0, 0); // piece 0: 2 → 4, now stacked with piece 1
        _throw(id, second, 1);
        _move(id, second, 0, 1);
        _throw(id, first, 3);
        _move(id, first, 0, 1); // moving piece 1 carries piece 0: 4 → 7
        YutGame.Game memory g = yut.game(id);
        assertEq(_mine(g, me, 0), 7);
        assertEq(_mine(g, me, 1), 7);
    }

    function test_CaptureSendsBackAndGrantsAThrow() public {
        (uint256 id, address first, address second) = _start();
        uint8 me = yut.game(id).turn;
        _throw(id, first, 2);
        _move(id, first, 0, 0); // first: piece 0 on 2
        _throw(id, second, 2);
        _move(id, second, 0, 0); // second lands on 2: capture
        YutGame.Game memory g = yut.game(id);
        assertEq(_mine(g, me, 0), 255, "captured piece is back off the board");
        assertEq(g.turn, 1 - me, "capturer keeps the turn");
        assertEq(uint8(g.phase), uint8(YutGame.Phase.Throwing), "and throws again");
    }

    // ──────────────────────────────── endings ───────────────────────────────

    function test_BringingAllPiecesHomeWinsThePotMinusFee() public {
        (uint256 id, address first, address second) = _start();
        // Each turn `first` throws 모 four times (each earns another throw), then a 빽도 that is lost
        // because nothing is on the board. Four 모 walk one piece home: →5, 20‥24, 15‥19, 0 → home.
        // `second` only ever throws a lost 빽도, so the turn comes straight back.
        for (uint8 p; p < 4; ++p) {
            for (uint8 k; k < 4; ++k) _throw(id, first, 5);
            _throw(id, first, -1);
            for (uint8 k; k < 4; ++k) _move(id, first, 0, p);
            if (p < 3) _throw(id, second, -1);
        }
        YutGame.Game memory g = yut.game(id);
        assertEq(uint8(g.status), uint8(YutGame.Status.Done));
        assertEq(g.winner, first);
        uint256 pot = 2 * uint256(STAKE);
        assertEq(yut.claimable(first), pot - pot * 300 / 10_000);
        assertEq(yut.feesAccrued(), pot * 300 / 10_000);
        uint256 before = won.balanceOf(first);
        vm.prank(first);
        yut.claim();
        assertEq(won.balanceOf(first), before + pot - pot * 300 / 10_000);
        yut.sweepFees();
        assertEq(won.balanceOf(treasury), pot * 300 / 10_000);
        assertEq(won.balanceOf(address(yut)), 0);
        vm.prank(second);
        vm.expectRevert(YutGame.NothingToClaim.selector);
        yut.claim();
    }

    function test_TimeoutLosesTheGame() public {
        (uint256 id, address first, address second) = _start();
        vm.expectRevert(YutGame.NotTimedOut.selector);
        yut.claimTimeout(id);
        vm.warp(block.timestamp + 121);
        yut.claimTimeout(id);
        assertEq(yut.game(id).winner, second);
        vm.roll(block.number + 2);
        vm.prank(first);
        vm.expectRevert(YutGame.WrongStatus.selector);
        yut.throwSticks(id, chains[first][255]);
    }

    function test_ResignHandsTheWin() public {
        (uint256 id, address first, address second) = _start();
        vm.prank(first);
        yut.resign(id);
        assertEq(yut.game(id).winner, second);
    }

    function test_ThrowWindowClosesBeforeBlockhashExpires() public {
        (uint256 id, address first,) = _start();
        YutGame.Game memory g = yut.game(id);
        vm.roll(g.lastBlock + 241);
        vm.prank(first);
        vm.expectRevert(YutGame.TooLate.selector);
        yut.throwSticks(id, chains[first][255]);
    }

    // ──────────────────────────────── fuzzing ───────────────────────────────

    /// @dev Plays whole games with random throws and random legal moves. Every game ends, the
    ///      winner gets exactly pot − fee, and no token is created or lost.
    function testFuzz_RandomGamesAlwaysSettle(uint256 seed) public {
        (uint256 id,,) = _start();
        for (uint256 step; step < 3000; ++step) {
            YutGame.Game memory g = yut.game(id);
            if (g.status != YutGame.Status.Playing) break;
            address p = g.players[g.turn];
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            if (used[p] >= 250) {
                vm.warp(block.timestamp + 121);
                yut.claimTimeout(id);
                break;
            }
            if (g.phase == YutGame.Phase.Throwing) {
                int8[6] memory vals = [int8(-1), 1, 2, 3, 4, 5];
                _throw(id, p, vals[r % 6]);
            } else {
                uint8 slot = uint8(r % g.pendingCount);
                bool moved;
                for (uint8 k; k < 4 && !moved; ++k) {
                    uint8 piece = uint8((r >> 8) + k) % 4;
                    vm.roll(block.number + 1);
                    vm.prank(p);
                    try yut.move(id, slot, piece) {
                        moved = true;
                    } catch {}
                }
                if (!moved) {
                    vm.prank(p);
                    yut.pass(id, slot);
                }
            }
        }
        YutGame.Game memory end = yut.game(id);
        assertEq(uint8(end.status), uint8(YutGame.Status.Done), "game finished");
        uint256 pot = 2 * uint256(STAKE);
        assertEq(yut.claimable(end.winner) + yut.feesAccrued(), pot);
        assertEq(won.balanceOf(address(yut)), pot, "all stakes still held until claimed");
    }
}
