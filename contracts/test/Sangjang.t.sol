// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SangjangMarket} from "../src/sangjang/SangjangMarket.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll} from "./mocks/Mocks.sol";

contract SangjangTest is Test {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");
    bytes32 constant SYM = "BERA";
    uint64 constant WINDOW = 1 hours;
    uint128 constant BOND = 50_000e18;
    uint128 constant CAP = 1_000_000e18;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address curator = makeAddr("curator");
    address resolver = makeAddr("resolver");
    MockToken won;
    MockScroll scroll;
    SangjangMarket mkt;
    address[] people;

    function setUp() public {
        vm.warp(1_800_000_000);
        won = new MockToken(18);
        scroll = new MockScroll();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        mkt = new SangjangMarket(owner, IERC20(address(won)), gate, treasury, WINDOW, BOND);
        vm.prank(owner);
        mkt.setRoles(curator, true, false);
        vm.prank(owner);
        mkt.setRoles(resolver, false, true);
        for (uint256 i; i < 8; ++i) {
            address p = makeAddr(string.concat("p", vm.toString(i)));
            people.push(p);
            scroll.set(p, UPBIT, true);
            won.mint(p, 100_000_000e18);
            vm.prank(p);
            won.approve(address(mkt), type(uint256).max);
        }
    }

    function _create() internal returns (uint256 id) {
        vm.prank(curator);
        id = mkt.createMarket(SYM, uint64(block.timestamp + 30 days), CAP);
    }

    function _bet(uint256 id, uint256 who, bool yes, uint128 amt) internal {
        vm.prank(people[who]);
        mkt.bet(id, yes, amt);
    }

    function _claim(uint256 id, uint256 who) internal returns (uint256 got) {
        uint256 before = won.balanceOf(people[who]);
        if (mkt.claimable(id, people[who]) == 0) return 0;
        vm.prank(people[who]);
        mkt.claim(id);
        got = won.balanceOf(people[who]) - before;
    }

    // ─────────────────────────────── betting ────────────────────────────────

    function test_OnlyVerifiedCanBet() public {
        uint256 id = _create();
        address stranger = makeAddr("stranger");
        won.mint(stranger, 1e24);
        vm.startPrank(stranger);
        won.approve(address(mkt), type(uint256).max);
        vm.expectRevert(SangjangMarket.NotEligible.selector);
        mkt.bet(id, true, 1e18);
        vm.stopPrank();
    }

    function test_CapPerIdentity() public {
        uint256 id = _create();
        _bet(id, 0, true, CAP);
        vm.prank(people[0]);
        vm.expectRevert(SangjangMarket.OverCap.selector);
        mkt.bet(id, false, 1);
    }

    function test_OnlyCuratorCreates() public {
        vm.expectRevert(SangjangMarket.NotCurator.selector);
        mkt.createMarket(SYM, uint64(block.timestamp + 1 days), CAP);
    }

    function test_NoBetsAfterClose() public {
        uint256 id = _create();
        vm.warp(block.timestamp + 30 days);
        vm.prank(people[0]);
        vm.expectRevert(SangjangMarket.Closed.selector);
        mkt.bet(id, true, 1e18);
    }

    // ─────────────────────────────── outcomes ───────────────────────────────

    function test_YesPaysWinnersProRataMinusFee() public {
        uint256 id = _create();
        _bet(id, 0, true, 100e18);
        _bet(id, 1, true, 300e18);
        _bet(id, 2, false, 400e18);
        vm.warp(block.timestamp + 1 days);
        vm.prank(resolver);
        mkt.propose(id, true, uint64(block.timestamp - 60), keccak256("notice 6561"));
        vm.warp(block.timestamp + WINDOW);
        mkt.finalize(id);
        // losing pool 400, fee 1% = 4 → 396 shared 1:3
        assertEq(_claim(id, 0), 100e18 + 99e18);
        assertEq(_claim(id, 1), 300e18 + 297e18);
        assertEq(_claim(id, 2), 0);
        assertEq(mkt.treasuryAccrued(), 4e18);
        mkt.withdrawTreasury();
        assertEq(won.balanceOf(treasury), 4e18);
        assertEq(won.balanceOf(address(mkt)), 0, "fully paid out");
    }

    function test_NoAfterDeadline() public {
        uint256 id = _create();
        _bet(id, 0, true, 100e18);
        _bet(id, 1, false, 100e18);
        vm.prank(resolver);
        vm.expectRevert(SangjangMarket.BadProposal.selector);
        mkt.propose(id, false, 0, 0);
        vm.warp(block.timestamp + 30 days);
        vm.prank(resolver);
        mkt.propose(id, false, 0, keccak256("no listing"));
        vm.warp(block.timestamp + WINDOW);
        mkt.finalize(id);
        assertEq(_claim(id, 1), 100e18 + 99e18);
    }

    function test_BetsAfterAnnouncementAreRefunded() public {
        uint256 id = _create();
        _bet(id, 0, true, 100e18);
        _bet(id, 1, false, 100e18);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint64 announced = uint64(vm.getBlockTimestamp());
        // Sniper reads the notice and piles in on YES in the same second and after.
        _bet(id, 2, true, 900e18);
        vm.warp(vm.getBlockTimestamp() + 30);
        _bet(id, 3, true, 500e18);
        vm.prank(resolver);
        mkt.propose(id, true, announced, keccak256("notice"));
        vm.warp(block.timestamp + WINDOW);
        mkt.finalize(id);
        assertEq(_claim(id, 2), 900e18, "same-second bet refunded, no winnings");
        assertEq(_claim(id, 3), 500e18, "late bet refunded, no winnings");
        assertEq(_claim(id, 0), 100e18 + 99e18, "honest early bettor gets the whole losing pool");
        assertEq(won.balanceOf(address(mkt)), mkt.treasuryAccrued());
    }

    function test_OneSidedAtCutoffVoids() public {
        uint256 id = _create();
        _bet(id, 0, true, 100e18);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint64 announced = uint64(vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + 10);
        _bet(id, 1, false, 100e18);
        vm.prank(resolver);
        mkt.propose(id, true, announced, 0);
        vm.warp(block.timestamp + WINDOW);
        mkt.finalize(id);
        assertEq(uint8(mkt.market(id).status), uint8(SangjangMarket.Status.Voided));
        assertEq(_claim(id, 0), 100e18);
        assertEq(_claim(id, 1), 100e18);
    }

    function test_AnnouncedBeforeCreationVoids() public {
        uint256 id = _create();
        _bet(id, 0, true, 100e18);
        vm.prank(resolver);
        mkt.propose(id, true, uint64(block.timestamp - 1 days), 0);
        assertEq(uint8(mkt.market(id).status), uint8(SangjangMarket.Status.Voided));
        assertEq(_claim(id, 0), 100e18);
    }

    function test_CannotClaimTwice() public {
        uint256 id = _create();
        _bet(id, 0, true, 100e18);
        vm.prank(owner);
        mkt.voidMarket(id, "cancelled listing");
        _claim(id, 0);
        vm.prank(people[0]);
        vm.expectRevert(SangjangMarket.AlreadyClaimed.selector);
        mkt.claim(id);
    }

    // ─────────────────────────────── disputes ───────────────────────────────

    function test_DisputeRightGetsBondBack() public {
        uint256 id = _create();
        _bet(id, 0, true, 100e18);
        _bet(id, 1, false, 100e18);
        vm.warp(block.timestamp + 1 days);
        vm.prank(resolver);
        mkt.propose(id, true, uint64(block.timestamp - 5), keccak256("misread notice"));
        vm.prank(people[5]);
        mkt.dispute(id);
        vm.expectRevert(SangjangMarket.NotProposed.selector);
        mkt.finalize(id);
        uint256 before = won.balanceOf(people[5]);
        vm.warp(block.timestamp + 30 days);
        vm.prank(owner);
        mkt.arbitrate(id, false, 0, false);
        assertEq(won.balanceOf(people[5]), before + BOND);
        assertFalse(mkt.market(id).yes);
        assertEq(_claim(id, 1), 199e18);
    }

    function test_DisputeWrongLosesBond() public {
        uint256 id = _create();
        _bet(id, 0, true, 100e18);
        _bet(id, 1, false, 100e18);
        vm.warp(block.timestamp + 1 days);
        uint64 at = uint64(block.timestamp - 5);
        vm.prank(resolver);
        mkt.propose(id, true, at, 0);
        vm.prank(people[1]);
        mkt.dispute(id);
        vm.prank(owner);
        mkt.arbitrate(id, true, at, false);
        assertEq(mkt.treasuryAccrued(), BOND + 1e18);
    }

    function test_DisputeWindowCloses() public {
        uint256 id = _create();
        _bet(id, 0, true, 100e18);
        _bet(id, 1, false, 100e18);
        vm.warp(block.timestamp + 1 days);
        vm.prank(resolver);
        mkt.propose(id, true, uint64(block.timestamp - 5), 0);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(people[1]);
        vm.expectRevert(SangjangMarket.WindowClosed.selector);
        mkt.dispute(id);
    }

    function test_OnlyResolverProposes() public {
        uint256 id = _create();
        vm.expectRevert(SangjangMarket.NotResolver.selector);
        mkt.propose(id, true, uint64(block.timestamp), 0);
    }

    // ──────────────────────────────── fuzzing ───────────────────────────────

    /// @dev Random bets around a random announcement. Everything paid out plus the fee equals
    ///      everything paid in; nothing is stuck beyond rounding dust.
    function testFuzz_ConservationAroundAnnouncement(uint256 seed, uint8 nBets, uint32 announceOffset) public {
        uint256 id = _create();
        uint256 n = bound(nBets, 2, 40);
        uint64 start = uint64(vm.getBlockTimestamp());
        uint64 announced = start + uint64(bound(announceOffset, 1, 20 days));
        uint256 paidIn;
        // Bets land at increasing times spread across 25 days, straddling the announcement.
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(start + uint64((25 days * (i + 1)) / (n + 1)) + uint64(r % 600));
            uint128 amt = uint128(1e18 + (r >> 64) % 50_000e18);
            uint256 who = (r >> 128) % people.length;
            if (mkt.staked(id, people[who]) + amt > CAP || mkt.betsOf(id, people[who]).length >= 32) continue;
            _bet(id, who, (r >> 200) % 2 == 0, amt);
            paidIn += amt;
        }
        if (vm.getBlockTimestamp() < announced) vm.warp(announced);
        vm.prank(resolver);
        mkt.propose(id, true, announced, 0);
        vm.warp(vm.getBlockTimestamp() + WINDOW);
        mkt.finalize(id);
        uint256 out;
        for (uint256 i; i < people.length; ++i) {
            out += _claim(id, i);
        }
        uint256 left = won.balanceOf(address(mkt));
        assertEq(out + left, paidIn, "conservation");
        assertGe(left, mkt.treasuryAccrued());
        assertLe(left - mkt.treasuryAccrued(), people.length, "only rounding dust remains");
    }
}
