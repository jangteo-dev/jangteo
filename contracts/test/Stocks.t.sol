// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoStocks, IStockOracle} from "../src/stocks/JangteoStocks.sol";
import {StockOracle} from "../src/stocks/StockOracle.sol";
import {StockToken} from "../src/stocks/StockToken.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll} from "./mocks/Mocks.sol";

contract StocksTest is Test {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");
    bytes32 constant SAMSUNG = "005930";
    bytes32 constant NVDA = "NVDA";
    uint256 constant W = 1e18;

    MockToken won;
    StockOracle oracle;
    JangteoStocks ex;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address reporter = makeAddr("reporter");
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_800_000_000);
        won = new MockToken(18);
        MockScroll scroll = new MockScroll();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        oracle = new StockOracle(owner, reporter);
        ex = new JangteoStocks(owner, gate, IERC20(address(won)), IStockOracle(address(oracle)), treasury);
        vm.startPrank(owner);
        ex.list(SAMSUNG, "Jangteo Samsung Electronics", "jSAMSUNG", 0);
        ex.list(NVDA, "Jangteo NVIDIA", "jNVDA", 1);
        vm.stopPrank();
        address[4] memory ps = [lp, alice, bob, stranger];
        for (uint256 i; i < ps.length; ++i) {
            if (ps[i] != stranger) scroll.set(ps[i], UPBIT, true);
            won.mint(ps[i], 1e30);
            vm.prank(ps[i]);
            won.approve(address(ex), type(uint256).max);
        }
        _post(SAMSUNG, 250_000 * W, true);
        _post(NVDA, 300_000 * W, true);
        vm.prank(lp);
        ex.deposit(100_000_000 * W, 0); // ₩100M vault
    }

    function _post(bytes32 sym, uint256 price, bool open) internal {
        bytes32[] memory s = new bytes32[](1);
        uint128[] memory p = new uint128[](1);
        bool[] memory o = new bool[](1);
        s[0] = sym;
        p[0] = uint128(price);
        o[0] = open;
        vm.prank(reporter);
        oracle.post(s, p, o);
    }

    function _tok(bytes32 sym) internal view returns (StockToken) {
        return ex.marketOf(sym).token;
    }

    function _warp(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    // ───────────────────────────── oracle ─────────────────────────────

    function test_oracle_onlyReporter_andGuard() public {
        vm.expectRevert(StockOracle.NotReporter.selector);
        oracle.post(new bytes32[](0), new uint128[](0), new bool[](0));
        _post(SAMSUNG, 400_000 * W, true); // +60% within the hour: rejected
        (uint256 p,,) = oracle.priceOf(SAMSUNG);
        assertEq(p, 250_000 * W);
        _post(SAMSUNG, 325_000 * W, true); // +30%: allowed
        (p,,) = oracle.priceOf(SAMSUNG);
        assertEq(p, 325_000 * W);
        _warp(2 hours);
        _post(SAMSUNG, 650_000 * W, true); // after a gap any price lands
        (p,,) = oracle.priceOf(SAMSUNG);
        assertEq(p, 650_000 * W);
    }

    function test_oracle_reporterTimelock() public {
        address r2 = makeAddr("r2");
        vm.prank(owner);
        oracle.proposeReporter(r2);
        vm.prank(owner);
        vm.expectRevert(StockOracle.TooEarly.selector);
        oracle.activateReporter();
        _warp(48 hours);
        vm.prank(owner);
        oracle.activateReporter();
        assertEq(oracle.reporter(), r2);
        vm.prank(owner);
        oracle.removeReporter();
        assertEq(oracle.reporter(), address(0));
    }

    // ───────────────────────────── trading ────────────────────────────

    function test_buy_mintsAtOraclePrice_feeSplit() public {
        vm.prank(alice);
        uint256 shares = ex.buy(SAMSUNG, 1_000_000 * W, 0);
        // fee 0.3% = 3,000; 997,000 / 250,000 = 3.988 shares
        assertEq(shares, 3.988e18);
        assertEq(_tok(SAMSUNG).balanceOf(alice), 3.988e18);
        assertEq(ex.feesAccrued(), 600 * W); // 20% of the fee
        assertEq(ex.cash(), 100_000_000 * W + 1_000_000 * W - 600 * W);
        assertEq(ex.liability(), 997_000 * W);
    }

    function test_buy_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(JangteoStocks.NotEligible.selector);
        ex.buy(SAMSUNG, 10_000 * W, 0);
        vm.prank(alice);
        vm.expectRevert(JangteoStocks.BadParams.selector);
        ex.buy(SAMSUNG, 999 * W, 0);
        vm.prank(alice);
        vm.expectRevert(JangteoStocks.Slippage.selector);
        ex.buy(SAMSUNG, 10_000 * W, 1e18);
        vm.prank(alice);
        vm.expectRevert(JangteoStocks.UnknownMarket.selector);
        ex.buy("XXXX", 10_000 * W, 0);
        vm.prank(owner);
        ex.setBuyPaused(SAMSUNG, true);
        vm.prank(alice);
        vm.expectRevert(JangteoStocks.Paused.selector);
        ex.buy(SAMSUNG, 10_000 * W, 0);
    }

    function test_closedOrStale_blocksBothSides() public {
        vm.prank(alice);
        uint256 sh = ex.buy(NVDA, 100_000 * W, 0);
        _post(NVDA, 300_000 * W, false); // market closed
        vm.prank(alice);
        vm.expectRevert(JangteoStocks.MarketClosed.selector);
        ex.sell(NVDA, sh, 0);
        vm.prank(alice);
        vm.expectRevert(JangteoStocks.MarketClosed.selector);
        ex.buy(NVDA, 100_000 * W, 0);
        _post(NVDA, 300_000 * W, true);
        _warp(91); // stale
        vm.prank(alice);
        vm.expectRevert(JangteoStocks.MarketClosed.selector);
        ex.sell(NVDA, sh, 0);
        (,, bool tradable,) = ex.quoteOf(NVDA);
        assertFalse(tradable);
        _post(NVDA, 300_000 * W, true);
        vm.prank(alice);
        ex.sell(NVDA, sh, 0);
    }

    function test_sell_atNewPrice_traderProfitIsLpLoss() public {
        vm.prank(alice);
        uint256 sh = ex.buy(SAMSUNG, 1_000_000 * W, 0);
        uint256 navBefore = ex.nav();
        _post(SAMSUNG, 275_000 * W, true); // +10%
        assertEq(ex.nav(), navBefore - (sh * 25_000 * W) / 1e18);
        uint256 a = won.balanceOf(alice);
        vm.prank(alice);
        uint256 out = ex.sell(SAMSUNG, sh, 0);
        uint256 gross = (sh * 275_000 * W) / 1e18;
        assertEq(out, gross - (gross * 30) / 10_000);
        assertEq(won.balanceOf(alice) - a, out);
        assertEq(_tok(SAMSUNG).totalSupply(), 0);
        assertEq(ex.liability(), 0);
    }

    function test_sell_slippageAndBalance() public {
        vm.prank(alice);
        uint256 sh = ex.buy(SAMSUNG, 1_000_000 * W, 0);
        vm.prank(alice);
        vm.expectRevert(JangteoStocks.Slippage.selector);
        ex.sell(SAMSUNG, sh, 1_000_000 * W);
        vm.prank(bob);
        vm.expectRevert(); // bob holds none
        ex.sell(SAMSUNG, 1, 0);
    }

    function test_caps_perStockAndTotal() public {
        // Per stock 25% of cash: about ₩33.3M of one stock on a ₩100M vault.
        (,,, uint256 room) = ex.quoteOf(SAMSUNG);
        assertApproxEqRel(room, 33_333_333 * W, 1e15);
        vm.prank(alice);
        vm.expectRevert(JangteoStocks.OverCap.selector);
        ex.buy(SAMSUNG, room + 1_000_000 * W, 0);
        vm.prank(alice);
        ex.buy(SAMSUNG, room - 100_000 * W, 0);
        // Holders can always sell, even when the cap is full.
        uint256 held = _tok(SAMSUNG).balanceOf(alice);
        vm.prank(alice);
        ex.sell(SAMSUNG, held, 0);
    }

    function test_tokens_transferable_onlyExchangeMints() public {
        vm.prank(alice);
        uint256 sh = ex.buy(SAMSUNG, 100_000 * W, 0);
        StockToken t = _tok(SAMSUNG);
        vm.prank(alice);
        t.transfer(stranger, sh);
        // an unverified holder can still sell
        vm.prank(stranger);
        ex.sell(SAMSUNG, sh, 0);
        vm.expectRevert(StockToken.OnlyExchange.selector);
        t.mint(alice, 1);
    }

    // ────────────────────────────── vault ─────────────────────────────

    function test_lp_firstDepositLocksMinimum() public view {
        assertEq(ex.balanceOf(ex.DEAD()), 1_000);
        assertEq(ex.balanceOf(lp), 100_000_000 * W - 1_000);
        assertEq(ex.lpPrice(), 1e18);
    }

    function test_lp_feesRaiseShareValue_andWithdrawAfterLock() public {
        vm.prank(alice);
        uint256 sh = ex.buy(SAMSUNG, 10_000_000 * W, 0);
        vm.prank(alice);
        ex.sell(SAMSUNG, sh, 0);
        assertGt(ex.lpPrice(), 1e18); // 80% of both fees stayed
        vm.prank(lp);
        vm.expectRevert(JangteoStocks.Locked.selector);
        ex.withdraw(1e18, 0);
        _warp(24 hours);
        uint256 bal = ex.balanceOf(lp);
        uint256 a = won.balanceOf(lp);
        vm.prank(lp);
        uint256 got = ex.withdraw(bal, 0);
        assertEq(won.balanceOf(lp) - a, got);
        // what's left: the dead minimum's share, protocol fees, and the 0.3% exit fee
        assertEq(ex.totalSupply(), 1_000);
        assertGe(ex.cash(), (got * 30) / 9_970);
    }

    function test_lp_lockedLpCannotMove_noGriefing() public {
        vm.prank(bob);
        ex.deposit(1_000_000 * W, 0);
        vm.prank(bob);
        vm.expectRevert(JangteoStocks.Locked.selector);
        ex.transfer(alice, 1);
        _warp(24 hours);
        vm.prank(bob);
        ex.transfer(alice, 1);
        assertEq(ex.lockedUntil(alice), 0); // receiving LP never locks anyone
    }

    function test_lp_depositPricedAtNav() public {
        vm.prank(alice);
        ex.buy(SAMSUNG, 10_000_000 * W, 0);
        _post(SAMSUNG, 200_000 * W, true); // traders lose 20%: LPs gain
        uint256 n = ex.nav();
        uint256 supply = ex.totalSupply();
        vm.prank(bob);
        uint256 minted = ex.deposit(5_000_000 * W, 0);
        assertEq(minted, (5_000_000 * W * supply) / n);
        vm.prank(bob);
        vm.expectRevert(JangteoStocks.Slippage.selector);
        ex.deposit(1_000_000 * W, 1e30);
    }

    function test_withdraw_neverTakesTradersMoney() public {
        vm.prank(alice);
        uint256 sh = ex.buy(SAMSUNG, 20_000_000 * W, 0);
        _warp(24 hours);
        _post(SAMSUNG, 250_000 * W, true);
        uint256 all = ex.balanceOf(lp);
        vm.prank(lp);
        ex.withdraw(all, 0);
        // alice can still be paid in full at the current price
        vm.prank(alice);
        ex.sell(SAMSUNG, sh, 0);
    }

    function test_admin_caps() public {
        vm.prank(owner);
        vm.expectRevert(JangteoStocks.BadParams.selector);
        ex.setParams(treasury, 101, 2_000, 30, 2_500, 7_500);
        vm.prank(owner);
        vm.expectRevert(JangteoStocks.BadParams.selector);
        ex.setParams(treasury, 30, 2_000, 30, 8_000, 7_500);
        vm.prank(alice);
        vm.expectRevert();
        ex.setParams(treasury, 0, 0, 0, 1, 1);
        vm.prank(owner);
        vm.expectRevert(JangteoStocks.BadParams.selector);
        ex.list(SAMSUNG, "dup", "dup", 0);
        vm.expectRevert(JangteoStocks.NothingToClaim.selector);
        ex.sweepFees();
        vm.prank(alice);
        ex.buy(SAMSUNG, 1_000_000 * W, 0);
        ex.sweepFees();
        assertEq(won.balanceOf(treasury), 600 * W);
    }

    function test_priceRunUp_everySellerTakesSameHaircut() public {
        // Two holders fill the cap, then the price triples over a few days: the vault can't cover both.
        vm.prank(alice);
        uint256 a = ex.buy(SAMSUNG, 15_000_000 * W, 0);
        vm.prank(bob);
        uint256 b = ex.buy(SAMSUNG, 15_000_000 * W, 0);
        for (uint256 d; d < 8; ++d) {
            _warp(2 hours);
            (uint256 p,,) = oracle.priceOf(SAMSUNG);
            _post(SAMSUNG, (p * 13) / 10, true);
        }
        assertGt(ex.liability(), ex.cash());
        assertEq(ex.nav(), 0);
        uint256 ratio = (ex.cash() * 1e18) / ex.liability();
        uint256 a0 = won.balanceOf(alice);
        vm.prank(alice);
        ex.sell(SAMSUNG, a, 0);
        // the ratio left for bob is never worse than alice's (her fee stayed in the vault)
        uint256 after_ = (ex.cash() * 1e18) / ex.liability();
        assertGe(after_, ratio);
        assertApproxEqRel(after_, ratio, 3e15);
        vm.prank(bob);
        ex.sell(SAMSUNG, b, 0);
        assertGt(won.balanceOf(alice) - a0, 0);
        assertEq(ex.liability(), 0);
        // LPs took the loss first: all that is left for them is the fees from those last sells.
        _warp(1 days);
        uint256 all = ex.balanceOf(lp);
        vm.prank(lp);
        uint256 got = ex.withdraw(all, 0);
        assertLt(got, 1_000_000 * W);
    }

    // ─────────────────────────────── fuzz ─────────────────────────────

    /// Any buy then sell at any later price: the vault's books stay exact.
    function testFuzz_roundTripAccounting(uint256 krw, uint256 newPrice) public {
        krw = bound(krw, 1_000 * W, 20_000_000 * W);
        newPrice = bound(newPrice, 175_000 * W, 325_000 * W);
        uint256 bal0 = won.balanceOf(address(ex));
        vm.prank(alice);
        uint256 sh = ex.buy(SAMSUNG, krw, 0);
        _post(SAMSUNG, newPrice, true);
        vm.prank(alice);
        uint256 out = ex.sell(SAMSUNG, sh, 0);
        assertEq(won.balanceOf(address(ex)), bal0 + krw - out);
        assertEq(ex.liability(), 0);
        assertEq(ex.cash() + ex.feesAccrued(), won.balanceOf(address(ex)));
        // fee: buyer pays 0.3% in and 0.3% out, so a round trip at the same price always loses
        if (newPrice == 250_000 * W) assertLt(out, krw);
    }
}
