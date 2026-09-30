// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GyeBase} from "./GyeBase.t.sol";
import {GyeCircle} from "../src/GyeCircle.sol";
import {GyeFactory} from "../src/GyeFactory.sol";
import {GyeReputation} from "../src/GyeReputation.sol";

contract GyeCircleTest is GyeBase {
    // ─────────────────────────────── filling ────────────────────────────────

    function test_ActivatesWhenFull() public {
        GyeCircle c = _circle(4, GyeCircle.Mode.Ordered, 0);
        assertEq(uint8(c.phase()), uint8(GyeCircle.Phase.Active));
        assertEq(c.round(), 1);
        assertEq(usd.balanceOf(address(c)), 4 * C, "collateral");
    }

    function test_UnverifiedCannotJoin() public {
        GyeCircle c = _openCircle(4);
        address stranger = makeAddr("stranger");
        usd.mint(stranger, 1e12);
        vm.startPrank(stranger);
        usd.approve(address(c), type(uint256).max);
        vm.expectRevert(GyeCircle.NotEligible.selector);
        c.join();
        vm.stopPrank();
    }

    function test_BrokenScrollDoesNotRevertGate() public {
        scroll.setBroken(true);
        assertFalse(gate.isEligible(people[0]));
    }

    function test_LeaveKeepsJoinOrderAndRefunds() public {
        GyeCircle c = _openCircle(5);
        _join(c, people[1]);
        _join(c, people[2]);
        _join(c, people[3]);
        uint256 before = usd.balanceOf(people[2]);
        vm.prank(people[2]);
        c.leave();
        assertEq(usd.balanceOf(people[2]), before + C);
        address[] memory m = c.members();
        assertEq(m.length, 3);
        assertEq(m[0], people[0]);
        assertEq(m[1], people[1]);
        assertEq(m[2], people[3]);
        assertEq(rep.recordOf(people[2]).active, 0);
    }

    function test_CancelAfterFillDeadline() public {
        GyeCircle c = _openCircle(5);
        _join(c, people[1]);
        vm.expectRevert(GyeCircle.FillOpen.selector);
        c.cancel();
        vm.warp(block.timestamp + 3 days + 1);
        c.cancel();
        _claimAll(c);
        assertEq(usd.balanceOf(address(c)), 0);
        assertEq(rep.recordOf(people[0]).active, 0);
    }

    function test_NewcomerLimitedToOneActiveCircle() public {
        _circle(3, GyeCircle.Mode.Ordered, 0);
        GyeCircle other = _openCircle3(3); // creator people[3]
        vm.startPrank(people[0]);
        usd.approve(address(other), type(uint256).max);
        vm.expectRevert(GyeCircle.ReputationBlocked.selector);
        other.join();
        vm.stopPrank();
    }

    // ─────────────────────────────── ordered ────────────────────────────────

    function test_OrderedHappyPathEveryoneWhole() public {
        GyeCircle c = _circle(4, GyeCircle.Mode.Ordered, 0);
        uint256[] memory start = _balances(4);
        for (uint256 r; r < 4; ++r) {
            _payAll(c);
            _settle(c);
            _assertBooks(c);
            assertTrue(c.memberOf(people[r]).received, "order");
            assertEq(c.memberOf(people[r]).receivedRound, r + 1);
        }
        assertEq(uint8(c.phase()), uint8(GyeCircle.Phase.Completed));
        _claimAll(c);
        assertEq(usd.balanceOf(address(c)), 0, "drained");
        for (uint256 i; i < 4; ++i) {
            assertEq(usd.balanceOf(people[i]), start[i] + C, "whole incl. collateral back");
            GyeReputation.Record memory rec = rep.recordOf(people[i]);
            assertEq(rec.completed, 1);
            assertEq(rec.active, 0);
            assertEq(rec.provenUsd, 400e18, "4 x $100 proven");
        }
        assertEq(eas.count(), 4, "one clean attestation each");
    }

    function test_NewcomerFirstWinnerIsFullySecured() public {
        GyeCircle c = _circle(5, GyeCircle.Mode.Ordered, 0);
        _payAll(c);
        _settle(c);
        GyeCircle.Member memory w = c.memberOf(people[0]);
        // remaining obligation 4C; collateral C already escrowed → hold 3C, get 2C now.
        assertEq(w.escrow, 4 * C);
        assertEq(w.claimable, 2 * C);
        assertEq(w.creditUsd, 0);
    }

    // ─────────────────────────────── defaults ───────────────────────────────

    function test_WinnerWhoVanishesHurtsNobody() public {
        GyeCircle c = _circle(4, GyeCircle.Mode.Ordered, 0);
        uint256[] memory start = _balances(4);
        _payAll(c);
        _settle(c); // people[0] wins, fully secured
        vm.prank(people[0]);
        c.claim();
        for (uint256 r = 1; r < 4; ++r) {
            for (uint256 i = 1; i < 4; ++i) {
                _pay(c, people[i]);
            }
            _settle(c);
            _assertBooks(c);
        }
        _claimAll(c);
        for (uint256 i = 1; i < 4; ++i) {
            assertEq(usd.balanceOf(people[i]), start[i] + C, "honest members whole");
        }
        GyeCircle.Member memory v = c.memberOf(people[0]);
        assertEq(v.missed, 3);
        assertFalse(v.defaulted, "escrow covered everything");
        GyeReputation.Record memory rec = rep.recordOf(people[0]);
        assertEq(rec.completed, 0);
        assertEq(rec.late, 1);
    }

    function test_PreRecipientDebtSelfHeals() public {
        GyeCircle c = _circle(4, GyeCircle.Mode.Ordered, 0);
        uint256[] memory start = _balances(4);
        address late = people[3];
        // rounds 1 and 2: `late` skips. Round 1 covered by collateral, round 2 is short.
        for (uint256 r; r < 2; ++r) {
            for (uint256 i; i < 3; ++i) {
                _pay(c, people[i]);
            }
            _settle(c);
            _assertBooks(c);
        }
        assertEq(c.memberOf(late).debt, C);
        assertEq(c.memberOf(people[1]).owed, C, "round-2 winner holds the IOU");
        // rounds 3-4 everyone pays; `late` wins round 4 and its pot repays the IOU.
        for (uint256 r; r < 2; ++r) {
            _payAll(c);
            _settle(c);
            _assertBooks(c);
        }
        assertEq(c.memberOf(late).debt, 0);
        assertEq(c.memberOf(people[1]).owed, 0);
        _claimAll(c);
        assertEq(usd.balanceOf(address(c)), 0);
        for (uint256 i; i < 4; ++i) {
            assertEq(usd.balanceOf(people[i]), start[i] + C, "everyone whole");
        }
        assertEq(rep.recordOf(late).late, 1);
        assertEq(rep.recordOf(people[0]).completed, 1);
    }

    function test_TrustedMemberGetsCreditAndDefaultIsRecorded() public {
        // Build history: people[0..3] finish a clean circle → $400 proven each.
        GyeCircle warmup = _circle(4, GyeCircle.Mode.Ordered, 0);
        for (uint256 r; r < 4; ++r) {
            _payAll(warmup);
            _settle(warmup);
        }
        _claimAll(warmup);
        assertEq(rep.holdbackBps(people[0]), 8_000);

        // New 6-person circle, people[0] first again (trusted), others are fresh.
        vm.startPrank(people[0]);
        GyeCircle c = factory.createCircle(_cfg(6, GyeCircle.Mode.Ordered), true);
        usd.approve(address(c), type(uint256).max);
        vm.stopPrank();
        for (uint256 i = 4; i < 9; ++i) {
            _join(c, people[i]);
        }
        uint256[] memory start = _balances(9);
        _payAll(c);
        _settle(c);
        GyeCircle.Member memory w = c.memberOf(people[0]);
        // remaining 5C = $500; tier credit 20% = $100 ≤ proven $400 → allowed $100.
        assertEq(w.escrow, 4 * C, "escrow covers remaining minus credit");
        assertEq(w.creditUsd, 100e18);
        assertEq(rep.recordOf(people[0]).creditInUse, 100e18);

        vm.prank(people[0]);
        c.claim();
        // people[0] vanishes; escrow covers 4 rounds, the 5th is a real default.
        for (uint256 r = 1; r < 6; ++r) {
            for (uint256 i = 4; i < 9; ++i) {
                _pay(c, people[i]);
            }
            _settle(c);
            _assertBooks(c);
        }
        GyeCircle.Member memory v = c.memberOf(people[0]);
        assertTrue(v.defaulted);
        assertEq(v.debt, C, "loss capped at the credit extended");
        GyeReputation.Record memory rec = rep.recordOf(people[0]);
        assertEq(rec.defaults, 1);
        assertFalse(rep.canJoin(people[0]));
        assertEq(rep.holdbackBps(people[0]), 10_000);
        assertEq(rep.availableCredit(people[0]), 0);

        _claimAll(c);
        uint256 lost;
        for (uint256 i = 4; i < 9; ++i) {
            uint256 b = usd.balanceOf(people[i]);
            if (b < start[i] + C) lost += start[i] + C - b;
        }
        assertEq(lost, C, "honest members lose exactly the vouched credit, never more");
    }

    // ─────────────────────────────── auction ────────────────────────────────

    function test_AuctionDiscountIsSharedAsInterest() public {
        GyeCircle c = _circle(4, GyeCircle.Mode.Auction, 0);
        _payAll(c);
        vm.prank(people[2]);
        c.bid(40e6);
        vm.prank(people[1]);
        vm.expectRevert(GyeCircle.BidTooLow.selector);
        c.bid(40e6);
        vm.prank(people[1]);
        vm.expectRevert(GyeCircle.BidTooHigh.selector);
        c.bid(121e6); // 30% of 400
        _settle(c);
        assertTrue(c.memberOf(people[2]).received);
        // 40 shared by the 3 other payers: 13.333333 each, dust to the winner.
        assertEq(c.memberOf(people[0]).claimable, 13_333_333);
        _assertBooks(c);
    }

    function test_AuctionUnpaidCannotBid() public {
        GyeCircle c = _circle(3, GyeCircle.Mode.Auction, 0);
        vm.prank(people[1]);
        vm.expectRevert(GyeCircle.CannotBid.selector);
        c.bid(1e6);
    }

    function test_AuctionWithoutBidsFallsBackToRandomPayer() public {
        GyeCircle c = _circle(4, GyeCircle.Mode.Auction, 0);
        _pay(c, people[3]);
        _settle(c);
        assertTrue(c.memberOf(people[3]).received, "only payer is eligible");
    }

    // ──────────────────────────────── random ────────────────────────────────

    function test_RandomEveryoneReceivesExactlyOnce() public {
        GyeCircle c = _circle(6, GyeCircle.Mode.Random, 0);
        for (uint256 r; r < 6; ++r) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode(r)))));
            _payAll(c);
            _settle(c);
        }
        for (uint256 i; i < 6; ++i) {
            assertTrue(c.memberOf(people[i]).received);
        }
        _claimAll(c);
        assertEq(usd.balanceOf(address(c)), 0);
    }

    // ──────────────────────────────── guards ────────────────────────────────

    function test_CannotSettleEarlyOrPayTwice() public {
        GyeCircle c = _circle(3, GyeCircle.Mode.Ordered, 0);
        vm.expectRevert(GyeCircle.RoundOpen.selector);
        c.settle();
        _pay(c, people[0]);
        vm.prank(people[0]);
        vm.expectRevert(GyeCircle.AlreadyPaid.selector);
        c.contribute();
    }

    function test_AttestationFailureNeverBlocksCircle() public {
        eas.setFail(true);
        GyeCircle c = _circle(3, GyeCircle.Mode.Ordered, 0);
        for (uint256 r; r < 3; ++r) {
            _payAll(c);
            _settle(c);
        }
        assertEq(uint8(c.phase()), uint8(GyeCircle.Phase.Completed));
        assertEq(rep.recordOf(people[0]).completed, 1);
    }

    function test_FactoryRejectsBadConfigs() public {
        GyeCircle.Config memory cfg = _cfg(4, GyeCircle.Mode.Ordered);
        cfg.size = 1;
        vm.expectRevert(GyeFactory.BadConfig.selector);
        factory.createCircle(cfg, false);
        cfg = _cfg(4, GyeCircle.Mode.Ordered);
        cfg.roundDuration = 10;
        vm.expectRevert(GyeFactory.BadConfig.selector);
        factory.createCircle(cfg, false);
        cfg = _cfg(4, GyeCircle.Mode.Ordered);
        cfg.maxDiscountBps = 100;
        vm.expectRevert(GyeFactory.BadConfig.selector);
        factory.createCircle(cfg, false);
    }

    function test_OnlyCirclesWriteReputation() public {
        vm.expectRevert(GyeReputation.NotCircle.selector);
        rep.onDefault(people[0], 1);
    }

    function test_CloneCannotBeReinitialized() public {
        GyeCircle c = _circle(3, GyeCircle.Mode.Ordered, 0);
        vm.expectRevert(GyeCircle.AlreadyInitialized.selector);
        c.initialize(_cfg(3, GyeCircle.Mode.Ordered), address(this), rep, gate, 1, 0, address(0));
    }

    // ───────────────────────────────── fees ──────────────────────────────────

    function test_PlatformFeeFromEveryPotToTreasury() public {
        address treasury = makeAddr("treasury");
        vm.prank(owner);
        factory.setFee(treasury, 100); // 1%
        GyeCircle c = _circle(4, GyeCircle.Mode.Ordered, 0);
        assertEq(c.feeBps(), 100);
        for (uint256 r; r < 4; ++r) {
            _payAll(c);
            _settle(c);
            _assertBooks(c);
        }
        assertEq(c.feesAccrued(), 4 * (4 * C) / 100, "1% of four pots");
        _claimAll(c);
        c.sweepFees();
        assertEq(usd.balanceOf(treasury), 16e6);
        assertEq(usd.balanceOf(address(c)), 0, "nothing left behind");
        vm.expectRevert(GyeCircle.NothingToClaim.selector);
        c.sweepFees();
    }

    function test_FeeIsFixedAtCreation() public {
        address treasury = makeAddr("treasury");
        vm.prank(owner);
        factory.setFee(treasury, 100);
        GyeCircle c = _circle(3, GyeCircle.Mode.Ordered, 0);
        vm.prank(owner);
        factory.setFee(treasury, 300);
        assertEq(c.feeBps(), 100, "running circle keeps its fee");
    }

    function test_FeeCapAndTreasuryRequired() public {
        vm.startPrank(owner);
        vm.expectRevert(GyeFactory.BadConfig.selector);
        factory.setFee(makeAddr("t"), 301);
        vm.expectRevert(GyeFactory.BadConfig.selector);
        factory.setFee(address(0), 100);
        vm.stopPrank();
    }

    // ─────────────────────────────── fuzzing ────────────────────────────────

    /// @dev Random payment behaviour across a full circle. No tokens are ever created or lost,
    ///      and the books balance after every round.
    function testFuzz_ConservationUnderAnyPaymentPattern(uint256 seed, uint8 sizeRaw, uint8 modeRaw) public {
        uint8 size = uint8(bound(sizeRaw, 2, 10));
        GyeCircle.Mode mode = GyeCircle.Mode(modeRaw % 3);
        GyeCircle c = _circle(size, mode, 0);
        uint256 totalBefore = _sum(_balances(size)) + usd.balanceOf(address(c));
        for (uint256 r; r < size; ++r) {
            address[] memory m = c.members();
            for (uint256 i; i < m.length; ++i) {
                if (uint256(keccak256(abi.encode(seed, r, i))) % 4 != 0) _pay(c, m[i]);
            }
            if (mode == GyeCircle.Mode.Auction) {
                for (uint256 i; i < m.length; ++i) {
                    GyeCircle.Member memory x = c.memberOf(m[i]);
                    if (!x.received && c.hasPaid(m[i])) {
                        vm.prank(m[i]);
                        try c.bid(uint128(1e6 + (uint256(keccak256(abi.encode(seed, r, i, "b"))) % 100e6))) {} catch {}
                    }
                }
            }
            _settle(c);
            _assertBooks(c);
        }
        assertEq(uint8(c.phase()), uint8(GyeCircle.Phase.Completed));
        _claimAll(c);
        assertEq(usd.balanceOf(address(c)), 0, "fully drained after claims");
        assertEq(_sum(_balances(size)), totalBefore, "conservation");
    }

    // ─────────────────────────────── helpers ────────────────────────────────

    function _openCircle(uint8 size) internal returns (GyeCircle c) {
        vm.startPrank(people[0]);
        usd.approve(address(factory), type(uint256).max);
        c = factory.createCircle(_cfg(size, GyeCircle.Mode.Ordered), true);
        vm.stopPrank();
    }

    function _openCircle3(uint8 size) internal returns (GyeCircle c) {
        vm.startPrank(people[3]);
        usd.approve(address(factory), type(uint256).max);
        c = factory.createCircle(_cfg(size, GyeCircle.Mode.Ordered), true);
        vm.stopPrank();
    }

    function _balances(uint256 n) internal view returns (uint256[] memory b) {
        b = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            b[i] = usd.balanceOf(people[i]);
        }
    }

    function _sum(uint256[] memory b) internal pure returns (uint256 s) {
        for (uint256 i; i < b.length; ++i) {
            s += b[i];
        }
    }
}
