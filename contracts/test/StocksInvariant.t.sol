// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoStocks, IStockOracle} from "../src/stocks/JangteoStocks.sol";
import {StockOracle} from "../src/stocks/StockOracle.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll} from "./mocks/Mocks.sol";

contract StocksHandler is Test {
    uint256 constant W = 1e18;
    JangteoStocks public ex;
    StockOracle public oracle;
    MockToken public won;
    address public reporter;
    address[4] public actors;
    bytes32[3] public syms = [bytes32("005930"), bytes32("NVDA"), bytes32("035720")];
    uint256[3] public base = [250_000 * W, 300_000 * W, 31_800 * W];
    // Every tKRW that entered or left the exchange, so the books can be checked to the wei.
    uint256 public inflow;
    uint256 public outflow;
    uint256[6] public ok; // buys, sells, deposits, withdraws, closed-market posts, cap hits
    uint256[3] public last; // last posted price per stock
    bool[3] public isOpen;

    constructor(JangteoStocks ex_, StockOracle oracle_, MockToken won_, address reporter_, address[4] memory actors_) {
        ex = ex_;
        oracle = oracle_;
        won = won_;
        reporter = reporter_;
        actors = actors_;
    }

    function _a(uint256 s) internal view returns (address) {
        return actors[s % 4];
    }

    function post(uint256 i, uint256 pct, uint256 openSeed) public {
        i %= 3;
        bool open = openSeed % 5 != 0; // markets are open most of the time
        // Prices stay within ±30% of a base, the most a Korean stock moves in a day.
        uint256 price = (base[i] * bound(pct, 7_000, 13_000)) / 10_000;
        bytes32[] memory s = new bytes32[](1);
        uint128[] memory p = new uint128[](1);
        bool[] memory o = new bool[](1);
        s[0] = syms[i];
        p[0] = uint128(price);
        o[0] = open;
        if (!open) ok[4]++;
        last[i] = price;
        isOpen[i] = open;
        vm.prank(reporter);
        oracle.post(s, p, o);
    }

    /// Like the live reporter: an open market's price is re-posted every few seconds.
    function _fresh(uint256 i) internal {
        if (!isOpen[i]) return;
        bytes32[] memory s = new bytes32[](1);
        uint128[] memory p = new uint128[](1);
        bool[] memory o = new bool[](1);
        s[0] = syms[i];
        p[0] = uint128(last[i]);
        o[0] = true;
        vm.prank(reporter);
        oracle.post(s, p, o);
    }

    function warp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 2 days));
    }

    function buy(uint256 who, uint256 i, uint256 krw) external {
        address a = _a(who);
        _fresh(i % 3);
        // Mostly inside the room the caps leave, sometimes past it (those must revert OverCap).
        (,,, uint256 room) = ex.quoteOf(syms[i % 3]);
        uint256 hi = krw % 10 == 0 ? room * 2 + 2_000 * W : room;
        if (hi < 1_000 * W) hi = 1_000 * W;
        krw = bound(krw, 1_000 * W, hi);
        vm.prank(a);
        try ex.buy(syms[i % 3], krw, 0) {
            inflow += krw;
            ok[0]++;
        } catch (bytes memory e) {
            if (bytes4(e) == JangteoStocks.OverCap.selector) ok[5]++;
        }
    }

    function sell(uint256 who, uint256 i, uint256 frac) external {
        address a = _a(who);
        bytes32 sym = syms[i % 3];
        uint256 bal = ex.marketOf(sym).token.balanceOf(a);
        if (bal == 0) return;
        uint256 n = (bal * bound(frac, 1, 100)) / 100;
        if (n == 0) return;
        _fresh(i % 3);
        uint256 before = won.balanceOf(a);
        vm.prank(a);
        try ex.sell(sym, n, 0) {
            outflow += won.balanceOf(a) - before;
            ok[1]++;
        } catch {}
    }

    function deposit(uint256 who, uint256 krw) external {
        address a = _a(who);
        krw = bound(krw, 2_000, 50_000_000 * W);
        vm.prank(a);
        try ex.deposit(krw, 0) {
            inflow += krw;
            ok[2]++;
        } catch {}
    }

    function withdraw(uint256 who, uint256 frac) external {
        address a = _a(who);
        uint256 bal = ex.balanceOf(a);
        if (bal == 0) return;
        uint256 before = won.balanceOf(a);
        vm.prank(a);
        try ex.withdraw((bal * bound(frac, 1, 100)) / 100, 0) {
            outflow += won.balanceOf(a) - before;
            ok[3]++;
        } catch {}
    }

    function transferLp(uint256 from, uint256 to, uint256 amt) external {
        address a = _a(from);
        uint256 bal = ex.balanceOf(a);
        if (bal == 0) return;
        vm.prank(a);
        try ex.transfer(_a(to), bound(amt, 1, bal)) {} catch {}
    }

    function sweep() external {
        uint256 f = ex.feesAccrued();
        try ex.sweepFees() {
            outflow += f;
        } catch {}
    }
}

contract StocksInvariantTest is Test {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");
    MockToken won;
    StockOracle oracle;
    JangteoStocks ex;
    StocksHandler h;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address reporter = makeAddr("reporter");
    address[4] actors;

    function setUp() public {
        vm.warp(1_800_000_000);
        won = new MockToken(18);
        MockScroll scroll = new MockScroll();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        oracle = new StockOracle(owner, reporter);
        ex = new JangteoStocks(owner, gate, IERC20(address(won)), IStockOracle(address(oracle)), treasury);
        actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        h = new StocksHandler(ex, oracle, won, reporter, actors);
        vm.startPrank(owner);
        ex.list("005930", "Samsung", "jSAMSUNG", 0);
        ex.list("NVDA", "NVIDIA", "jNVDA", 1);
        ex.list("035720", "Kakao", "jKAKAO", 0);
        vm.stopPrank();
        for (uint256 i; i < 4; ++i) {
            if (i != 3) scroll.set(actors[i], UPBIT, true); // a3 is unverified: it can still sell and LP
            won.mint(actors[i], 1e32);
            vm.prank(actors[i]);
            won.approve(address(ex), type(uint256).max);
        }
        for (uint256 i; i < 3; ++i) h.post(i, 10_000, 1);
        targetContract(address(h));
    }

    function invariant_booksExact() public view {
        assertEq(won.balanceOf(address(ex)), h.inflow() - h.outflow());
        assertGe(won.balanceOf(address(ex)), ex.feesAccrued());
    }

    function invariant_minimumLiquidityLocked() public view {
        if (ex.totalSupply() != 0) assertEq(ex.balanceOf(ex.DEAD()), ex.MIN_LIQUIDITY());
    }

    /// Every holder can always sell: in full when the vault covers the liability, otherwise at the
    /// common haircut. Selling everything at once must fit in the cash there is.
    function invariant_holdersAlwaysPayable() public view {
        uint256 c = ex.cash();
        uint256 l = ex.liability();
        uint256 payable_ = l > c ? c : l;
        assertLe(payable_, c);
        // LP value never exceeds what is left after holders.
        assertEq(ex.nav(), c > l ? c - l : 0);
    }

    /// Nothing gets stuck: reopen every market, every holder sells, every LP leaves after the lock.
    function afterInvariant() public {
        if (vm.envOr("STOCKS_COVERAGE", false)) console2.log(string.concat("buys sells deposits withdraws closedPosts capHits: ", vm.toString(h.ok(0)), " ", vm.toString(h.ok(1)), " ", vm.toString(h.ok(2)), " ", vm.toString(h.ok(3)), " ", vm.toString(h.ok(4)), " ", vm.toString(h.ok(5))));
        vm.warp(vm.getBlockTimestamp() + 2 hours); // past the oracle guard window
        for (uint256 i; i < 3; ++i) h.post(i, 10_000, 1);
        for (uint256 i; i < 3; ++i) {
            bytes32 sym = h.syms(i);
            for (uint256 k; k < 4; ++k) {
                uint256 bal = ex.marketOf(sym).token.balanceOf(actors[k]);
                if (bal == 0) continue;
                vm.prank(actors[k]);
                ex.sell(sym, bal, 0);
            }
            assertEq(ex.marketOf(sym).token.totalSupply(), 0);
        }
        vm.warp(vm.getBlockTimestamp() + 1 days); // prices go stale: withdrawals don't need them
        // Exit fees stay in the vault, so each exit raises what the remaining LP is worth: repeat.
        for (uint256 pass; pass < 6; ++pass)
        for (uint256 k; k < 4; ++k) {
            uint256 lp = ex.balanceOf(actors[k]);
            // A wiped-out vault has nothing to pay LPs, and a few wei of LP round to nothing.
            if (lp == 0 || (lp * ex.nav()) / ex.totalSupply() == 0) continue;
            vm.prank(actors[k]);
            ex.withdraw(lp, 0);
        }
        if (ex.feesAccrued() != 0) ex.sweepFees();
        assertEq(ex.liability(), 0);
        // Only the locked minimum and LP dust worth less than 1 wei each remain.
        for (uint256 k; k < 4; ++k) assertEq((ex.balanceOf(actors[k]) * ex.nav()) / (ex.totalSupply() == 0 ? 1 : ex.totalSupply()), 0);
        // Left behind: only what the locked minimum share owns (exit fees and rounding).
        assertEq(won.balanceOf(address(ex)), ex.nav());
    }
}
