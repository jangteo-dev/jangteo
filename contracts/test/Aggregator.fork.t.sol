// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoAggregator, IV2FactoryAgg} from "../src/swap/JangteoAggregator.sol";

/// Runs against live GIWA Sepolia pools: `forge test --match-contract AggregatorFork --fork-url giwa_sepolia`.
contract AggregatorForkTest is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant HOME = 0x73331f9080972D224a80B91DdD844585C57d4BD1; // 장터 스왑 factory
    // Naruswap V2 WETH pair and a Uniswap V3 WETH pool (0.3%) with real trading history.
    address constant NARU = 0xC3558e02DA63D4E9693AddD10e0c4551B30303a6;
    address constant NARU_TOKEN = 0xaEF40Bb184aA7e367ff535671B2263670a1f5Eac;
    address constant V3 = 0x99D3F92E036e78646610914dc6C2aC7ed57Be464;
    address constant HOME_PAIR = 0x83e3F9d7340AAE23cafd563FDbb194B8f53f97Fe; // WETH/BBMP
    address constant BBMP = 0x468ae171583564E7fC4F594FC54dD2E0aA47491C;

    JangteoAggregator agg;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    function setUp() public {
        if (block.chainid != 91342) return;
        agg = new JangteoAggregator(address(this), WETH, IV2FactoryAgg(HOME), treasury, 10);
        vm.deal(alice, 10 ether);
    }

    function _route(address a, address b, address pool, uint8 kind, uint24 fee)
        internal
        pure
        returns (address[] memory p, JangteoAggregator.Hop[] memory h)
    {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
        h = new JangteoAggregator.Hop[](1);
        h[0] = JangteoAggregator.Hop(pool, kind, fee);
    }

    function test_v2_other_dex_eth_in_and_back_out() public {
        if (block.chainid != 91342) return;
        (address[] memory p, JangteoAggregator.Hop[] memory h) = _route(address(0), NARU_TOKEN, NARU, 1, 3000);
        uint256 q = agg.quote(p, h, 0.01 ether);
        assertGt(q, 0);
        vm.prank(alice);
        uint256 out = agg.swap{value: 0.01 ether}(p, h, 0.01 ether, q, alice, block.timestamp);
        assertEq(out, q, "quote matches the fill");
        assertEq(IERC20(NARU_TOKEN).balanceOf(alice), out);
        assertEq(treasury.balance, 0.00001 ether, "0.1% to treasury");

        (p, h) = _route(NARU_TOKEN, address(0), NARU, 1, 3000);
        q = agg.quote(p, h, out);
        uint256 before = alice.balance;
        vm.startPrank(alice);
        IERC20(NARU_TOKEN).approve(address(agg), out);
        agg.swap(p, h, out, q, alice, block.timestamp);
        vm.stopPrank();
        assertEq(alice.balance - before, q);
        assertEq(IERC20(NARU_TOKEN).balanceOf(address(agg)), 0, "nothing left behind");
        assertEq(IERC20(WETH).balanceOf(address(agg)), 0);
    }

    function test_v3_quote_matches_fill() public {
        if (block.chainid != 91342) return;
        (bool ok, bytes memory r) = V3.staticcall(abi.encodeWithSignature("token0()"));
        require(ok);
        address t0 = abi.decode(r, (address));
        (, r) = V3.staticcall(abi.encodeWithSignature("token1()"));
        address other = t0 == WETH ? abi.decode(r, (address)) : t0;
        (address[] memory p, JangteoAggregator.Hop[] memory h) = _route(address(0), other, V3, 2, 0);
        uint256 q = agg.quote(p, h, 0.001 ether);
        assertGt(q, 0, "v3 quote");
        vm.prank(alice);
        uint256 out = agg.swap{value: 0.001 ether}(p, h, 0.001 ether, q, alice, block.timestamp);
        assertEq(out, q);
        assertEq(IERC20(other).balanceOf(alice), out);
    }

    function test_home_route_is_fee_free() public {
        if (block.chainid != 91342) return;
        (address[] memory p, JangteoAggregator.Hop[] memory h) = _route(address(0), BBMP, HOME_PAIR, 0, 3000);
        assertEq(agg.feeFor(p, h, 1 ether), 0);
        vm.prank(alice);
        agg.swap{value: 0.001 ether}(p, h, 0.001 ether, 1, alice, block.timestamp);
        assertEq(treasury.balance, 0);
        assertGt(IERC20(BBMP).balanceOf(alice), 0);
    }

    function test_two_hops_through_weth() public {
        if (block.chainid != 91342) return;
        address[] memory p = new address[](3);
        p[0] = BBMP;
        p[1] = WETH;
        p[2] = NARU_TOKEN;
        JangteoAggregator.Hop[] memory h = new JangteoAggregator.Hop[](2);
        h[0] = JangteoAggregator.Hop(HOME_PAIR, 0, 3000);
        h[1] = JangteoAggregator.Hop(NARU, 1, 3000);
        (address[] memory p1, JangteoAggregator.Hop[] memory h1) = _route(address(0), BBMP, HOME_PAIR, 0, 3000);
        vm.startPrank(alice);
        uint256 bb = agg.swap{value: 0.001 ether}(p1, h1, 0.001 ether, 1, alice, block.timestamp);
        IERC20(BBMP).approve(address(agg), bb);
        uint256 q = agg.quote(p, h, bb);
        uint256 out = agg.swap(p, h, bb, q, alice, block.timestamp);
        vm.stopPrank();
        assertEq(out, q);
        assertGt(IERC20(BBMP).balanceOf(treasury), 0, "mixed route pays the fee");
    }

    function test_rejects_min_out_and_stray_callbacks() public {
        if (block.chainid != 91342) return;
        (address[] memory p, JangteoAggregator.Hop[] memory h) = _route(address(0), NARU_TOKEN, NARU, 1, 3000);
        uint256 q = agg.quote(p, h, 0.01 ether);
        vm.prank(alice);
        vm.expectRevert();
        agg.swap{value: 0.01 ether}(p, h, 0.01 ether, q + 1, alice, block.timestamp);
        vm.expectRevert(JangteoAggregator.BadCallback.selector);
        agg.uniswapV3SwapCallback(1, -1, abi.encode(WETH, false));
    }
}
