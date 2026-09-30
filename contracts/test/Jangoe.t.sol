// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangoeMarket} from "../src/jangoe/JangoeMarket.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll} from "./mocks/Mocks.sol";

contract JangoeTest is Test {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");

    MockToken won;
    MockToken hanji;
    MockScroll scroll;
    JangoeMarket mk;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // seller
    address bob = makeAddr("bob"); // buyer
    address carol = makeAddr("carol");
    address stranger = makeAddr("stranger");
    uint256 mid;

    function setUp() public {
        vm.warp(1_800_000_000);
        won = new MockToken(18);
        hanji = new MockToken(18);
        scroll = new MockScroll();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        mk = new JangoeMarket(owner, gate, treasury, 200);
        address[3] memory ps = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            scroll.set(ps[i], UPBIT, true);
            won.mint(ps[i], 1e30);
            hanji.mint(ps[i], 1e30);
            vm.startPrank(ps[i]);
            won.approve(address(mk), type(uint256).max);
            hanji.approve(address(mk), type(uint256).max);
            vm.stopPrank();
        }
        vm.prank(owner);
        mid = mk.createMarket("HANJI", IERC20(address(won)), 10_000, '{"kind":"cheongyak"}');
    }

    function _post(address who, JangoeMarket.Side side, uint128 units, uint128 price) internal returns (uint256) {
        vm.prank(who);
        return mk.post(mid, side, units, price);
    }

    function _fill(address who, uint256 offerId, uint128 units) internal returns (uint256) {
        vm.prank(who);
        return mk.fill(offerId, units);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory x) {
        x = new uint256[](1);
        x[0] = a;
    }

    function _settle(uint128 rate, uint64 window) internal {
        vm.prank(owner);
        mk.startSettlement(mid, IERC20(address(hanji)), rate, window);
    }

    // ───────────────────────────────── offers ─────────────────────────────────

    function test_OnlyCuratorCreatesMarkets() public {
        vm.prank(alice);
        vm.expectRevert();
        mk.createMarket("X", IERC20(address(won)), 10_000, "");
        vm.prank(owner);
        vm.expectRevert(JangoeMarket.BadParams.selector);
        mk.createMarket("X", IERC20(address(won)), 4_000, "");
    }

    function test_PostLocksPaymentOrCollateral() public {
        uint256 b0 = won.balanceOf(bob);
        _post(bob, JangoeMarket.Side.Buy, 100e18, 1_000e18);
        assertEq(b0 - won.balanceOf(bob), 100_000e18);

        vm.prank(owner);
        uint256 m2 = mk.createMarket("PTS", IERC20(address(won)), 15_000, "");
        uint256 a0 = won.balanceOf(alice);
        vm.prank(alice);
        mk.post(m2, JangoeMarket.Side.Sell, 100e18, 1_000e18);
        assertEq(a0 - won.balanceOf(alice), 150_000e18); // 150% collateral
    }

    function test_UnverifiedCannotTrade() public {
        vm.prank(stranger);
        vm.expectRevert(JangoeMarket.NotEligible.selector);
        mk.post(mid, JangoeMarket.Side.Buy, 1e18, 1e18);
        uint256 o = _post(alice, JangoeMarket.Side.Sell, 10e18, 1_000e18);
        vm.prank(stranger);
        vm.expectRevert(JangoeMarket.NotEligible.selector);
        mk.fill(o, 1e18);
    }

    function test_NoSelfFill() public {
        uint256 o = _post(alice, JangoeMarket.Side.Sell, 10e18, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(JangoeMarket.NotYours.selector);
        mk.fill(o, 1e18);
    }

    function test_PartialFillsAndCancelRefund() public {
        uint256 o = _post(alice, JangoeMarket.Side.Sell, 100e18, 1_000e18);
        _fill(bob, o, 30e18);
        _fill(carol, o, 20e18);
        JangoeMarket.Offer memory off = mk.offer(o);
        assertEq(off.filled, 50e18);
        assertEq(off.locked, 50_000e18);
        uint256 a0 = won.balanceOf(alice);
        vm.prank(alice);
        mk.cancel(o);
        assertEq(won.balanceOf(alice) - a0, 50_000e18);
        vm.expectRevert(JangoeMarket.WrongStatus.selector);
        _fill(bob, o, 1e18);
        assertEq(mk.market(mid).trades, 2);
        assertEq(mk.market(mid).volume, 50_000e18);
        assertEq(mk.tradesOf(alice).length, 2);
    }

    function test_OverfillReverts() public {
        uint256 o = _post(bob, JangoeMarket.Side.Buy, 10e18, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(JangoeMarket.BadParams.selector);
        mk.fill(o, 11e18);
    }

    // ───────────────────────────────── settle ─────────────────────────────────

    function test_DeliveryPaysSellerAndBuyerGetsTokens() public {
        uint256 o = _post(bob, JangoeMarket.Side.Buy, 100e18, 1_000e18);
        uint256 a0 = won.balanceOf(alice);
        uint256 t = _fill(alice, o, 100e18); // alice sells, locks 100k collateral
        assertEq(a0 - won.balanceOf(alice), 100_000e18);
        assertFalse(mk.offer(o).active);

        vm.prank(alice);
        vm.expectRevert(JangoeMarket.WrongStatus.selector);
        mk.deliver(_ids(t)); // not settling yet

        _settle(2e18, 3 days); // one unit = two tokens
        vm.expectRevert(JangoeMarket.WrongStatus.selector);
        _post(bob, JangoeMarket.Side.Buy, 1e18, 1e18); // trading stopped

        uint256 h0 = hanji.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(JangoeMarket.NotYours.selector);
        mk.deliver(_ids(t));
        vm.prank(alice);
        mk.deliver(_ids(t));
        assertEq(hanji.balanceOf(bob) - h0, 200e18);
        // payment 100k + collateral 100k - 2% fee on payment
        assertEq(won.balanceOf(alice) - (a0 - 100_000e18), 198_000e18);
        assertEq(mk.feesAccrued(address(won)), 2_000e18);
        assertEq(mk.delivered(alice), 1);
        assertEq(uint8(mk.trade(t).status), uint8(JangoeMarket.TradeStatus.Delivered));

        vm.prank(alice);
        vm.expectRevert(JangoeMarket.WrongStatus.selector);
        mk.deliver(_ids(t));

        mk.sweepFees(address(won));
        assertEq(won.balanceOf(treasury), 2_000e18);
        assertEq(won.balanceOf(address(mk)), 0);
    }

    function test_DefaultPaysBuyerCollateral() public {
        uint256 o = _post(alice, JangoeMarket.Side.Sell, 50e18, 1_000e18);
        uint256 b0 = won.balanceOf(bob);
        uint256 t = _fill(bob, o, 50e18);
        _settle(1e18, 2 days);
        vm.expectRevert(JangoeMarket.TooEarly.selector);
        mk.claimDefault(_ids(t));
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(alice);
        vm.expectRevert(JangoeMarket.TooLate.selector);
        mk.deliver(_ids(t));
        vm.prank(stranger); // anyone can trigger; money goes to the buyer
        mk.claimDefault(_ids(t));
        assertEq(won.balanceOf(bob) - b0, 50_000e18 - 1_000e18); // + collateral - payment - fee
        assertEq(mk.defaulted(alice), 1);
        assertEq(mk.feesAccrued(address(won)), 1_000e18);
        assertEq(won.balanceOf(address(mk)), 1_000e18);
    }

    function test_VoidRefundsEveryone() public {
        uint256 o = _post(alice, JangoeMarket.Side.Sell, 50e18, 1_000e18);
        uint256 a0 = won.balanceOf(alice);
        uint256 b0 = won.balanceOf(bob);
        uint256 t = _fill(bob, o, 20e18);
        vm.prank(owner);
        mk.voidMarket(mid);
        mk.refund(_ids(t));
        vm.prank(alice);
        mk.cancel(o);
        assertEq(won.balanceOf(bob), b0);
        assertEq(won.balanceOf(alice) - a0, 50_000e18);
        assertEq(won.balanceOf(address(mk)), 0);
        vm.expectRevert(JangoeMarket.WrongStatus.selector);
        mk.refund(_ids(t));
    }

    function test_SettlementParams() public {
        vm.prank(owner);
        vm.expectRevert(JangoeMarket.BadParams.selector);
        mk.startSettlement(mid, IERC20(address(hanji)), 1e18, 1 hours);
        vm.prank(alice);
        vm.expectRevert();
        mk.startSettlement(mid, IERC20(address(hanji)), 1e18, 2 days);
    }

    // ───────────────────────────── conservation ─────────────────────────────

    /// Whatever happens, every won that entered leaves to a participant or the treasury.
    function testFuzz_Conservation(uint256 seed, uint8 nOffers, uint8 outcome) public {
        nOffers = uint8(bound(nOffers, 1, 12));
        address[3] memory ps = [alice, bob, carol];
        uint256[3] memory start;
        for (uint256 i; i < 3; ++i) start[i] = won.balanceOf(ps[i]);

        uint256[] memory offerIds = new uint256[](nOffers);
        uint256 nt;
        uint256[] memory trades = new uint256[](uint256(nOffers) * 2);
        for (uint256 i; i < nOffers; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address maker = ps[r % 3];
            address taker = ps[(r / 3) % 3 == r % 3 ? (r % 3 + 1) % 3 : (r / 3) % 3];
            uint128 units = uint128(bound(r >> 16, 1e15, 1_000e18));
            uint128 price = uint128(bound(r >> 96, 1e12, 10_000e18));
            JangoeMarket.Side side = (r >> 200) % 2 == 0 ? JangoeMarket.Side.Buy : JangoeMarket.Side.Sell;
            offerIds[i] = _post(maker, side, units, price);
            uint128 a = uint128(bound(r >> 120, 1, units));
            if (_value(a, price) == 0) continue;
            trades[nt++] = _fill(taker, offerIds[i], a);
            if (a < units && _value(units - a, price) > 0 && (r >> 180) % 2 == 0) trades[nt++] = _fill(taker, offerIds[i], units - a);
        }
        for (uint256 i; i < nOffers; ++i) {
            if (!mk.offer(offerIds[i]).active) continue;
            vm.prank(mk.offer(offerIds[i]).maker);
            mk.cancel(offerIds[i]);
        }

        outcome = outcome % 3;
        if (outcome == 2) {
            vm.prank(owner);
            mk.voidMarket(mid);
        } else {
            _settle(1e18, 1 days);
        }
        for (uint256 i; i < nt; ++i) {
            JangoeMarket.Trade memory t = mk.trade(trades[i]);
            if (outcome == 2) {
                mk.refund(_ids(trades[i]));
            } else if (outcome == 0 && uint256(keccak256(abi.encode(seed, "d", i))) % 2 == 0) {
                vm.prank(t.seller);
                mk.deliver(_ids(trades[i]));
            }
        }
        if (outcome != 2) {
            vm.warp(block.timestamp + 1 days + 1);
            for (uint256 i; i < nt; ++i) {
                if (mk.trade(trades[i]).status == JangoeMarket.TradeStatus.Open) mk.claimDefault(_ids(trades[i]));
            }
        }
        assertEq(won.balanceOf(address(mk)), mk.feesAccrued(address(won)));
        uint256 endSum;
        uint256 startSum;
        for (uint256 i; i < 3; ++i) {
            endSum += won.balanceOf(ps[i]);
            startSum += start[i];
        }
        assertEq(startSum - endSum, mk.feesAccrued(address(won)));
    }

    function _value(uint256 units, uint256 price) internal pure returns (uint256) {
        return units * price / 1e18;
    }
}
