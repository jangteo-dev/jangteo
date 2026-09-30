// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Cheongyak} from "../src/cheongyak/Cheongyak.sol";
import {TestTokenFactory} from "../src/cheongyak/TestTokenFactory.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll} from "./mocks/Mocks.sol";

contract CheongyakTest is Test {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");

    MockToken won;
    MockToken hanok;
    MockScroll scroll;
    Cheongyak cy;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address issuer = makeAddr("issuer");
    address[] people;

    function setUp() public {
        vm.warp(1_800_000_000);
        won = new MockToken(18);
        hanok = new MockToken(18);
        scroll = new MockScroll();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        cy = new Cheongyak(owner, IERC20(address(won)), gate, treasury, 200); // 2%
        hanok.mint(issuer, 1e30);
        vm.prank(issuer);
        hanok.approve(address(cy), type(uint256).max);
        for (uint256 i; i < 40; ++i) {
            address p = makeAddr(string.concat("p", vm.toString(i)));
            people.push(p);
            scroll.set(p, UPBIT, true);
            won.mint(p, 1e30);
            vm.prank(p);
            won.approve(address(cy), type(uint256).max);
        }
    }

    /// 1,000 tokens at ₩1,000 each; half split evenly; deposits between ₩10,000 and ₩500,000.
    function _offer() internal returns (uint256 id) {
        vm.prank(issuer);
        id = cy.create(IERC20(address(hanok)), "HANOK", 1_000e18, 1_000e18, uint64(block.timestamp + 1 hours), uint64(block.timestamp + 1 days), 5_000, 10_000e18, 500_000e18);
    }

    function _sub(uint256 id, uint256 who, uint128 amount) internal {
        vm.prank(people[who]);
        cy.subscribe(id, amount);
    }

    function _settleAll(uint256 id, uint32 batch) internal {
        vm.warp(cy.offering(id).endAt);
        for (uint256 i; i < 1000 && cy.offering(id).status != Cheongyak.Status.Settled; ++i) {
            cy.settle(id, batch);
        }
    }

    function _claim(uint256 id, uint256 who) internal returns (uint256 tokens, uint256 refund) {
        uint256 t0 = hanok.balanceOf(people[who]);
        uint256 w0 = won.balanceOf(people[who]);
        vm.prank(people[who]);
        cy.claim(id);
        tokens = hanok.balanceOf(people[who]) - t0;
        refund = won.balanceOf(people[who]) - w0;
    }

    // ─────────────────────────────── subscribing ────────────────────────────

    function test_WindowMinMaxAndIdentity() public {
        uint256 id = _offer();
        vm.prank(people[0]);
        vm.expectRevert(Cheongyak.NotOpen.selector);
        cy.subscribe(id, 10_000e18);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(people[0]);
        vm.expectRevert(Cheongyak.BelowMinimum.selector);
        cy.subscribe(id, 9_999e18);
        _sub(id, 0, 400_000e18);
        vm.prank(people[0]);
        vm.expectRevert(Cheongyak.OverMaximum.selector);
        cy.subscribe(id, 100_001e18);
        address stranger = makeAddr("stranger");
        won.mint(stranger, 1e24);
        vm.startPrank(stranger);
        won.approve(address(cy), type(uint256).max);
        vm.expectRevert(Cheongyak.NotEligible.selector);
        cy.subscribe(id, 10_000e18);
        vm.stopPrank();
        assertEq(cy.offering(id).subscribers, 1, "top-ups don't count twice");
    }

    // ─────────────────────────────── allocation ─────────────────────────────

    /// Oversubscribed: 4 people want 10, 100, 500 and 500 tokens (1,110) for 1,000 on offer.
    /// 균등: 500 / 4 = 125 each, capped by demand → 10, 100, 125, 125 = 360.
    /// 비례: 640 left for remaining demand 0 + 0 + 375 + 375 = 750 → ratio 640/750.
    function test_EqualThenProportional() public {
        uint256 id = _offer();
        vm.warp(block.timestamp + 1 hours);
        _sub(id, 0, 10_000e18);
        _sub(id, 1, 100_000e18);
        _sub(id, 2, 500_000e18);
        _sub(id, 3, 500_000e18);
        _settleAll(id, 1);
        Cheongyak.Offering memory o = cy.offering(id);
        assertEq(o.equalEach, 125e18);
        assertEq(o.sumEqual, 360e18);

        (uint256 t0, uint256 r0) = _claim(id, 0);
        assertEq(t0, 10e18, "small subscriber is filled in full");
        assertEq(r0, 0);
        (uint256 t2, uint256 r2) = _claim(id, 2);
        uint256 prop = uint256(375e18) * (uint256(640e18) * 1e18 / 750e18) / 1e18;
        assertEq(t2, 125e18 + prop);
        assertEq(r2, 500_000e18 - (125e18 + prop) * 1_000e18 / 1e18, "pays only for what it got");
        assertLe(o.allocated, 1_000e18);
        assertApproxEqAbs(o.allocated, 1_000e18, 1e6, "sold out, up to rounding dust");
    }

    function test_UndersubscribedEveryoneFilledUnsoldReturned() public {
        uint256 id = _offer();
        vm.warp(block.timestamp + 1 hours);
        _sub(id, 0, 100_000e18);
        _sub(id, 1, 50_000e18);
        _settleAll(id, 10);
        (uint256 t0, uint256 r0) = _claim(id, 0);
        (uint256 t1,) = _claim(id, 1);
        assertEq(t0, 100e18);
        assertEq(r0, 0);
        assertEq(t1, 50e18);
        uint256 before = hanok.balanceOf(issuer);
        uint256 wonBefore = won.balanceOf(issuer);
        cy.payIssuer(id);
        assertEq(hanok.balanceOf(issuer) - before, 850e18, "unsold tokens back");
        assertEq(won.balanceOf(issuer) - wonBefore, 150_000e18 * 98 / 100, "proceeds minus 2%");
        cy.sweepFees();
        assertEq(won.balanceOf(treasury), 3_000e18);
        assertEq(won.balanceOf(address(cy)), 0);
        assertEq(hanok.balanceOf(address(cy)), 0);
    }

    function test_NobodySubscribedReturnsEverything() public {
        uint256 id = _offer();
        uint256 before = hanok.balanceOf(issuer);
        _settleAll(id, 10);
        assertEq(hanok.balanceOf(issuer) - before, 1_000e18);
        vm.expectRevert(Cheongyak.WrongStatus.selector);
        cy.payIssuer(id);
    }

    function test_CancelOnlyBeforeOpening() public {
        uint256 id = _offer();
        vm.prank(people[0]);
        vm.expectRevert(Cheongyak.NotIssuer.selector);
        cy.cancel(id);
        vm.prank(issuer);
        cy.cancel(id);
        assertEq(uint8(cy.offering(id).status), uint8(Cheongyak.Status.Cancelled));
        uint256 id2 = _offer();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(issuer);
        vm.expectRevert(Cheongyak.WrongStatus.selector);
        cy.cancel(id2);
    }

    function test_CannotSettleEarlyOrClaimTwice() public {
        uint256 id = _offer();
        vm.warp(block.timestamp + 1 hours);
        _sub(id, 0, 10_000e18);
        vm.expectRevert(Cheongyak.NotEnded.selector);
        cy.settle(id, 10);
        _settleAll(id, 10);
        _claim(id, 0);
        vm.prank(people[0]);
        vm.expectRevert(Cheongyak.NothingToClaim.selector);
        cy.claim(id);
    }

    // ──────────────────────────────── fuzzing ───────────────────────────────

    /// @dev Any crowd, any batch size: nobody pays more than they deposited, nobody gets more than
    ///      they asked for, and after everyone claims the contract holds exactly the fee.
    function testFuzz_ExactBooksForAnyCrowd(uint256 seed, uint8 nRaw, uint8 batchRaw, uint16 equalBps) public {
        uint256 n = bound(nRaw, 1, 40);
        uint32 batch = uint32(bound(batchRaw, 1, 50));
        equalBps = uint16(bound(equalBps, 0, 10_000));
        vm.prank(issuer);
        uint256 id = cy.create(IERC20(address(hanok)), "X", 1_000e18, 777e18, uint64(block.timestamp + 1), uint64(block.timestamp + 1 days), equalBps, 1e18, 900_000e18);
        vm.warp(block.timestamp + 1);
        uint256[] memory dep = new uint256[](n);
        uint256 totalDep;
        for (uint256 i; i < n; ++i) {
            dep[i] = 1e18 + uint256(keccak256(abi.encode(seed, i))) % 800_000e18;
            _sub(id, i, uint128(dep[i]));
            totalDep += dep[i];
        }
        _settleAll(id, batch);
        uint256 tokensOut;
        uint256 refunds;
        for (uint256 i; i < n; ++i) {
            (uint256 t, uint256 r) = _claim(id, i);
            assertLe(t, dep[i] * 1e18 / 777e18, "never more than asked for");
            assertLe(dep[i] - r, dep[i], "never pays more than deposited");
            tokensOut += t;
            refunds += r;
        }
        cy.payIssuer(id);
        cy.sweepFees();
        assertEq(won.balanceOf(address(cy)), 0, "quote books exact");
        assertEq(hanok.balanceOf(address(cy)), 0, "token books exact");
        Cheongyak.Offering memory o = cy.offering(id);
        assertEq(tokensOut, o.allocated);
        assertEq(totalDep - refunds, o.raised);
    }

    function test_TestTokenFactoryMintsToCreator() public {
        TestTokenFactory f = new TestTokenFactory();
        vm.prank(issuer);
        address t = f.create("Hanok", "HANOK", 1_000_000e18);
        assertEq(IERC20(t).balanceOf(issuer), 1_000_000e18);
        assertEq(f.tokenCount(), 1);
    }
}
