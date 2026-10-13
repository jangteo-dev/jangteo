// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoProperty} from "../src/property/JangteoProperty.sol";
import {PropertyShare} from "../src/property/PropertyShare.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll} from "./mocks/Mocks.sol";

contract PropertyTest is Test {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");
    uint256 constant PERIOD = 30 days;
    uint256 constant W = 1e18; // one tKRW

    MockToken won;
    MockScroll scroll;
    JangteoProperty reg;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address issuer = makeAddr("issuer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address stranger = makeAddr("stranger"); // not Dojang verified

    function setUp() public {
        vm.warp(1_800_000_000);
        won = new MockToken(18);
        scroll = new MockScroll();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        reg = new JangteoProperty(owner, gate, IERC20(address(won)), treasury, PERIOD, 1 hours);
        address[6] memory ps = [issuer, alice, bob, carol, stranger, owner];
        for (uint256 i; i < ps.length; ++i) {
            if (ps[i] != stranger && ps[i] != owner) scroll.set(ps[i], UPBIT, true);
            won.mint(ps[i], 1e30);
            vm.prank(ps[i]);
            won.approve(address(reg), type(uint256).max);
        }
    }

    // 1,000 shares at ₩10,000, soft cap 500, rent ₩100,000 / period, 3 periods reserve.
    function _terms() internal pure returns (JangteoProperty.Terms memory t) {
        t = JangteoProperty.Terms({
            totalShares: 1_000,
            minShares: 500,
            price: 10_000 * W,
            duration: 7 days,
            rentPerPeriod: 100_000 * W,
            reserveMonths: 3
        });
    }

    function _create() internal returns (uint256 id) {
        vm.prank(issuer);
        id = reg.create(_terms(), '{"name":"Hanok"}');
    }

    function _buy(address who, uint256 id, uint256 n) internal {
        vm.prank(who);
        reg.buy(id, n);
    }

    function _share(uint256 id) internal view returns (PropertyShare) {
        return reg.property(id).share;
    }

    /// Active property: alice 600, bob 400.
    function _active() internal returns (uint256 id) {
        id = _create();
        _buy(alice, id, 600);
        _buy(bob, id, 400);
        reg.finalize(id);
    }

    // ───────────────────────────── creation ─────────────────────────────

    function test_create_storesTerms() public {
        uint256 id = _create();
        JangteoProperty.Property memory p = reg.property(id);
        assertEq(uint8(p.status), uint8(JangteoProperty.Status.Funding));
        assertEq(p.issuer, issuer);
        assertEq(p.totalShares, 1_000);
        assertEq(p.endAt, vm.getBlockTimestamp() + 7 days);
        assertEq(p.saleBps, 200);
        assertEq(p.share.decimals(), 0);
        assertEq(p.share.name(), "Jangteo Property #0");
        assertEq(reg.metadata(id), '{"name":"Hanok"}');
    }

    function test_create_gated_butCuratorMayList() public {
        vm.prank(stranger);
        vm.expectRevert(JangteoProperty.NotEligible.selector);
        reg.create(_terms(), "");
        vm.prank(owner);
        reg.create(_terms(), "");
    }

    function test_create_rejectsBadTerms() public {
        JangteoProperty.Terms memory t;
        t = _terms(); t.minShares = 1_001; _expectBad(t);
        t = _terms(); t.minShares = 0; _expectBad(t);
        t = _terms(); t.price = 0; _expectBad(t);
        t = _terms(); t.duration = 59 minutes; _expectBad(t);
        t = _terms(); t.duration = 31 days; _expectBad(t);
        t = _terms(); t.reserveMonths = 2; _expectBad(t);
        t = _terms(); t.reserveMonths = 25; _expectBad(t);
        t = _terms(); t.rentPerPeriod = 0; _expectBad(t); // reserve without rent
        // Reserve larger than the smallest successful raise after fee: 500 × 10k × 0.98 = 4.9M.
        t = _terms(); t.rentPerPeriod = 1_633_334 * W; _expectBad(t);
        t = _terms(); t.rentPerPeriod = 0; t.reserveMonths = 0;
        vm.prank(issuer);
        reg.create(t, ""); // land without rent is fine
    }

    function _expectBad(JangteoProperty.Terms memory t) internal {
        vm.prank(issuer);
        vm.expectRevert(JangteoProperty.BadParams.selector);
        reg.create(t, "");
    }

    // ───────────────────────────── funding ──────────────────────────────

    function test_buy_mintsSharesAndTakesPayment() public {
        uint256 id = _create();
        uint256 before = won.balanceOf(alice);
        _buy(alice, id, 10);
        assertEq(_share(id).balanceOf(alice), 10);
        assertEq(before - won.balanceOf(alice), 100_000 * W);
        assertEq(reg.property(id).sold, 10);
    }

    function test_buy_reverts() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(JangteoProperty.NotEligible.selector);
        reg.buy(id, 1);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.BadParams.selector);
        reg.buy(id, 0);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.SoldOut.selector);
        reg.buy(id, 1_001);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.NotOpen.selector);
        reg.buy(id, 1);
    }

    function test_sharesLockedWhileFunding() public {
        uint256 id = _create();
        _buy(alice, id, 10);
        PropertyShare s = _share(id);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.Locked.selector);
        s.transfer(bob, 1);
    }

    function test_finalize_tooEarly() public {
        uint256 id = _create();
        _buy(alice, id, 600);
        vm.expectRevert(JangteoProperty.NotYet.selector);
        reg.finalize(id);
    }

    function test_finalize_success_paysIssuerKeepsReserveAndFee() public {
        uint256 id = _create();
        _buy(alice, id, 600);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        uint256 before = won.balanceOf(issuer);
        reg.finalize(id);
        // raised 6M, fee 2% = 120k, reserve 300k, issuer 5.58M
        assertEq(won.balanceOf(issuer) - before, 5_580_000 * W);
        assertEq(reg.feesAccrued(), 120_000 * W);
        JangteoProperty.Property memory p = reg.property(id);
        assertEq(p.reserve, 300_000 * W);
        assertEq(uint8(p.status), uint8(JangteoProperty.Status.Active));
        assertEq(won.balanceOf(address(reg)), 420_000 * W);
    }

    function test_finalize_soldOutEarly() public {
        uint256 id = _create();
        _buy(alice, id, 1_000);
        reg.finalize(id);
        assertEq(uint8(reg.property(id).status), uint8(JangteoProperty.Status.Active));
    }

    function test_failedSale_refundsInFull() public {
        uint256 id = _create();
        _buy(alice, id, 300);
        _buy(bob, id, 199);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        reg.finalize(id);
        assertEq(uint8(reg.property(id).status), uint8(JangteoProperty.Status.Failed));
        uint256 a = won.balanceOf(alice);
        vm.prank(alice);
        reg.refund(id);
        assertEq(won.balanceOf(alice) - a, 3_000_000 * W);
        assertEq(_share(id).balanceOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.NothingToClaim.selector);
        reg.refund(id);
        vm.prank(bob);
        reg.refund(id);
        assertEq(won.balanceOf(address(reg)), 0);
        assertEq(reg.property(id).refundable, 0);
    }

    function test_cancel_byIssuerOrCurator_only() public {
        uint256 id = _create();
        _buy(alice, id, 999);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.NotIssuer.selector);
        reg.cancel(id);
        vm.prank(owner);
        reg.cancel(id);
        vm.prank(alice);
        reg.refund(id);
        assertEq(won.balanceOf(address(reg)), 0);

        uint256 id2 = _create();
        vm.prank(issuer);
        reg.cancel(id2);
        assertEq(uint8(reg.property(id2).status), uint8(JangteoProperty.Status.Failed));
    }

    function test_cancel_notAfterActive() public {
        uint256 id = _active();
        vm.prank(owner);
        vm.expectRevert(JangteoProperty.WrongStatus.selector);
        reg.cancel(id);
    }

    // ─────────────────────────────── rent ───────────────────────────────

    function test_rent_paidProRataEachPeriod() public {
        uint256 id = _active();
        assertEq(reg.claimable(id, alice), 0);
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        assertEq(reg.claimable(id, alice), 60_000 * W); // view includes the unbooked period
        reg.accrue(id);
        assertEq(reg.claimable(id, alice), 60_000 * W);
        assertEq(reg.claimable(id, bob), 40_000 * W);
        uint256 a = won.balanceOf(alice);
        vm.prank(alice);
        reg.claimRent(id);
        assertEq(won.balanceOf(alice) - a, 60_000 * W);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.NothingToClaim.selector);
        reg.claimRent(id);
    }

    function test_rent_severalPeriodsAtOnce_thenArrears() public {
        uint256 id = _active();
        vm.warp(vm.getBlockTimestamp() + 5 * PERIOD + 1);
        reg.accrue(id);
        JangteoProperty.Property memory p = reg.property(id);
        assertEq(p.reserve, 0);
        assertEq(p.due, 200_000 * W); // 5 owed, 3 covered
        assertEq(reg.claimable(id, alice), 180_000 * W);
        (uint256 due,) = reg.arrears(id);
        assertEq(due, 200_000 * W);
        // Topping up pays arrears first.
        vm.prank(issuer);
        reg.fundReserve(id, 250_000 * W);
        p = reg.property(id);
        assertEq(p.due, 0);
        assertEq(p.reserve, 50_000 * W);
        assertEq(reg.claimable(id, alice), 300_000 * W);
        assertEq(reg.claimable(id, bob), 200_000 * W);
    }

    function test_rent_followsTransfers() public {
        uint256 id = _active();
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        PropertyShare s = _share(id);
        vm.prank(alice);
        s.transfer(carol, 600); // first period earned by alice before the move
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        reg.accrue(id);
        assertEq(reg.claimable(id, alice), 60_000 * W);
        assertEq(reg.claimable(id, carol), 60_000 * W);
        assertEq(reg.claimable(id, bob), 80_000 * W);
    }

    function test_transfer_toUnverifiedOrContractBlocked() public {
        uint256 id = _active();
        PropertyShare s = _share(id);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.NotEligible.selector);
        s.transfer(stranger, 1);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.NotEligible.selector);
        s.transfer(address(won), 1); // e.g. a pool contract
    }

    function test_hook_onlyShare() public {
        uint256 id = _active();
        vm.expectRevert(JangteoProperty.OnlyShare.selector);
        reg.onShareTransfer(id, alice, bob);
    }

    function test_rent_noRentProperty() public {
        JangteoProperty.Terms memory t = _terms();
        t.rentPerPeriod = 0;
        t.reserveMonths = 0;
        vm.prank(issuer);
        uint256 id = reg.create(t, "");
        _buy(alice, id, 1_000);
        reg.finalize(id);
        vm.warp(vm.getBlockTimestamp() + 3 * PERIOD);
        reg.accrue(id);
        assertEq(reg.claimable(id, alice), 0);
        (uint256 due,) = reg.arrears(id);
        assertEq(due, 0);
    }

    // ────────────────────────────── market ──────────────────────────────

    function test_market_listBuyCancel() public {
        uint256 id = _active();
        vm.prank(alice);
        uint256 lid = reg.list(id, 100, 12_000 * W);
        assertEq(_share(id).balanceOf(address(reg)), 100);
        assertEq(reg.eligibleShares(id), 900);

        uint256 a = won.balanceOf(alice);
        vm.prank(carol);
        reg.buyListing(lid, 40);
        assertEq(_share(id).balanceOf(carol), 40);
        // 480k paid, 1% fee
        assertEq(won.balanceOf(alice) - a, 475_200 * W);
        assertEq(reg.feesAccrued(), 200_000 * W + 4_800 * W);
        assertEq(reg.listing(lid).shares, 60);

        vm.prank(bob);
        vm.expectRevert(JangteoProperty.NotYours.selector);
        reg.cancelListing(lid);
        vm.prank(alice);
        reg.cancelListing(lid);
        assertEq(_share(id).balanceOf(alice), 560);
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.NothingToClaim.selector);
        reg.cancelListing(lid);
    }

    function test_market_reverts() public {
        uint256 id = _active();
        vm.prank(alice);
        uint256 lid = reg.list(id, 100, 12_000 * W);
        vm.prank(stranger);
        vm.expectRevert(JangteoProperty.NotEligible.selector);
        reg.buyListing(lid, 1);
        vm.prank(carol);
        vm.expectRevert(JangteoProperty.BadParams.selector);
        reg.buyListing(lid, 101);
        vm.prank(alice);
        vm.expectRevert(); // ERC20InsufficientBalance
        reg.list(id, 501, 1);
        uint256 fid = _create();
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.WrongStatus.selector);
        reg.list(fid, 1, 1);
    }

    function test_market_escrowEarnsNoRent_andWaitsWhenAllListed() public {
        uint256 id = _active();
        vm.prank(alice);
        reg.list(id, 600, 1 * W);
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        reg.accrue(id);
        assertEq(reg.claimable(id, bob), 100_000 * W); // bob's 400 are the only eligible shares
        assertEq(reg.claimable(id, alice), 0);

        vm.prank(bob);
        reg.list(id, 400, 1 * W);
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        reg.accrue(id); // nobody eligible: booked as due, paid later
        assertEq(reg.property(id).due, 100_000 * W);
        vm.prank(bob);
        reg.cancelListing(1);
        assertEq(reg.claimable(id, bob), 200_000 * W); // the view already counts the waiting rent
        reg.accrue(id); // next booking pays it
        assertEq(reg.property(id).due, 0);
        assertEq(reg.claimable(id, bob), 200_000 * W);
        vm.prank(bob);
        assertEq(reg.claimRent(id), 200_000 * W);
    }

    // ─────────────────────────────── exit ───────────────────────────────

    function test_sell_redeemProRata_reserveBack() public {
        uint256 id = _active();
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        uint256 i0 = won.balanceOf(issuer);
        vm.prank(issuer);
        reg.sell(id, 12_000_000 * W);
        JangteoProperty.Property memory p = reg.property(id);
        assertEq(uint8(p.status), uint8(JangteoProperty.Status.Sold));
        // 1 period paid from reserve → 200k back to issuer; 1% exit fee on 12M → pool 11.88M
        assertEq(i0 - won.balanceOf(issuer), 12_000_000 * W - 200_000 * W);
        assertEq(p.pool, 11_880_000 * W);
        uint256 a = won.balanceOf(alice);
        vm.prank(alice);
        reg.redeem(id, 600);
        assertEq(won.balanceOf(alice) - a, 7_128_000 * W);
        vm.prank(bob);
        reg.redeem(id, 400);
        // Earned rent still claimable after redeeming.
        vm.prank(alice);
        reg.claimRent(id);
        vm.prank(bob);
        reg.claimRent(id);
        reg.sweepFees();
        assertEq(won.balanceOf(address(reg)), 0);
    }

    function test_sell_arrearsPaidFromProceeds() public {
        uint256 id = _active();
        vm.warp(vm.getBlockTimestamp() + 5 * PERIOD);
        vm.prank(issuer);
        reg.sell(id, 1_000_000 * W);
        JangteoProperty.Property memory p = reg.property(id);
        // 3 periods from reserve, 2 (200k) from the sale; pool = 800k − 1%
        assertEq(p.pool, 792_000 * W);
        assertEq(reg.claimable(id, alice), 300_000 * W);
    }

    function test_sell_arrearsLargerThanSale() public {
        uint256 id = _active();
        vm.warp(vm.getBlockTimestamp() + 10 * PERIOD);
        vm.prank(issuer);
        reg.sell(id, 100_000 * W);
        JangteoProperty.Property memory p = reg.property(id);
        assertEq(p.pool, 0);
        assertEq(p.due, 0);
        assertEq(reg.claimable(id, alice) + reg.claimable(id, bob), 400_000 * W);
        vm.prank(alice);
        reg.redeem(id, 600); // pays 0, still burns
        assertEq(_share(id).balanceOf(alice), 0);
    }

    function test_sell_onlyIssuer_onlyActive() public {
        uint256 id = _active();
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.NotIssuer.selector);
        reg.sell(id, 1);
        vm.prank(issuer);
        vm.expectRevert(JangteoProperty.BadParams.selector);
        reg.sell(id, 0);
        uint256 fid = _create();
        vm.prank(issuer);
        vm.expectRevert(JangteoProperty.WrongStatus.selector);
        reg.sell(fid, 1);
    }

    function test_afterSold_listedSharesComeBackAndRedeem_noTrading() public {
        uint256 id = _active();
        vm.prank(alice);
        uint256 lid = reg.list(id, 100, 1 * W);
        vm.prank(issuer);
        reg.sell(id, 1_000_000 * W);
        vm.prank(carol);
        vm.expectRevert(JangteoProperty.WrongStatus.selector);
        reg.buyListing(lid, 1);
        PropertyShare s = _share(id);
        vm.prank(bob);
        vm.expectRevert(JangteoProperty.Locked.selector);
        s.transfer(carol, 1);
        vm.prank(alice);
        reg.cancelListing(lid);
        vm.prank(alice);
        reg.redeem(id, 600);
        vm.prank(bob);
        reg.redeem(id, 400);
        assertEq(reg.property(id).redeemed, 1_000);
        reg.sweepFees();
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.NothingToClaim.selector);
        reg.claimRent(id);
        assertEq(won.balanceOf(address(reg)), 0);
    }

    function test_redeem_reverts() public {
        uint256 id = _active();
        vm.prank(alice);
        vm.expectRevert(JangteoProperty.WrongStatus.selector);
        reg.redeem(id, 1);
        vm.prank(issuer);
        reg.sell(id, 1_000 * W);
        vm.prank(alice);
        vm.expectRevert();
        reg.redeem(id, 601);
    }

    // ─────────────────────────────── admin ──────────────────────────────

    function test_fees_snapshotPerProperty_andCaps() public {
        uint256 id = _create();
        vm.prank(owner);
        reg.setFees(treasury, 500, 300, 300);
        assertEq(reg.property(id).saleBps, 200);
        vm.prank(owner);
        vm.expectRevert(JangteoProperty.BadParams.selector);
        reg.setFees(treasury, 501, 0, 0);
        vm.prank(alice);
        vm.expectRevert();
        reg.setFees(treasury, 0, 0, 0);
        vm.expectRevert(JangteoProperty.NothingToClaim.selector);
        reg.sweepFees();
    }

    function test_badIds() public {
        vm.expectRevert(JangteoProperty.BadParams.selector);
        reg.buy(7, 1);
        vm.expectRevert(JangteoProperty.BadParams.selector);
        reg.buyListing(7, 1);
    }

    // ─────────────────────────────── fuzz ───────────────────────────────

    /// Whatever the split of holders and timing, all rent paid is claimable and never more.
    function testFuzz_rentConservation(uint256 a, uint256 b, uint256 periods, uint256 topUp) public {
        a = bound(a, 1, 300);
        b = bound(b, 0, 200);
        periods = bound(periods, 0, 40);
        topUp = bound(topUp, 0, 10_000_000 * W);
        uint256 id = _create();
        _buy(alice, id, a);
        if (b != 0) _buy(bob, id, b);
        _buy(carol, id, 500); // reach the soft cap
        vm.warp(vm.getBlockTimestamp() + 7 days);
        reg.finalize(id);
        vm.warp(vm.getBlockTimestamp() + periods * PERIOD);
        if (topUp != 0) {
            vm.prank(issuer);
            reg.fundReserve(id, topUp);
        } else {
            reg.accrue(id);
        }
        JangteoProperty.Property memory p = reg.property(id);
        uint256 sum = reg.claimable(id, alice) + reg.claimable(id, bob) + reg.claimable(id, carol);
        assertLe(sum, p.rentPaid);
        assertGe(sum + 3, p.rentPaid); // rounding dust only
        assertEq(p.rentPaid + p.reserve, 300_000 * W + topUp);
        assertEq(p.rentPaid + p.due, periods * 100_000 * W > p.rentPaid ? periods * 100_000 * W : p.rentPaid);
    }

    function testFuzz_redeemPaysPoolExactly(uint256 a, uint256 amount) public {
        a = bound(a, 500, 999);
        amount = bound(amount, 1, 1e30);
        uint256 id = _create();
        _buy(alice, id, a);
        _buy(bob, id, 1_000 - a);
        reg.finalize(id);
        vm.prank(issuer);
        reg.sell(id, amount);
        uint256 pool = reg.property(id).pool;
        uint256 a0 = won.balanceOf(alice);
        uint256 b0 = won.balanceOf(bob);
        vm.prank(bob);
        reg.redeem(id, 1_000 - a);
        vm.prank(alice);
        reg.redeem(id, a);
        assertEq(won.balanceOf(alice) - a0 + won.balanceOf(bob) - b0, pool);
    }
}
