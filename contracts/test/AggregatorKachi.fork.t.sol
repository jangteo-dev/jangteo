// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoAggregator, IV2FactoryAgg} from "../src/swap/JangteoAggregator.sol";

/// KachiSwap launch pools on live GIWA Sepolia: `forge test --match-contract AggregatorKachiFork --fork-url https://sepolia-rpc.giwa.io`.
contract AggregatorKachiForkTest is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant HOME = 0x73331f9080972D224a80B91DdD844585C57d4BD1;
    address constant USDC = 0xcE4AfB3768e887a382Fc4eF4073053701274EECc;

    JangteoAggregator agg;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    function setUp() public {
        if (block.chainid != 91342) return;
        agg = new JangteoAggregator(address(this), WETH, IV2FactoryAgg(HOME), treasury, 10);
    }

    function _roundTrip(address pool, uint256 usdcIn) internal {
        (, bytes memory r) = pool.staticcall(abi.encodeWithSignature("token0()"));
        address t0 = abi.decode(r, (address));
        (, r) = pool.staticcall(abi.encodeWithSignature("token1()"));
        address token = t0 == USDC ? abi.decode(r, (address)) : t0;
        deal(USDC, alice, usdcIn);

        address[] memory p = new address[](2);
        JangteoAggregator.Hop[] memory h = new JangteoAggregator.Hop[](1);
        h[0] = JangteoAggregator.Hop(pool, 3, 0);
        (p[0], p[1]) = (USDC, token);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(agg), type(uint256).max);
        uint256 q = agg.quote(p, h, usdcIn);
        assertGt(q, 0, "buy quote");
        uint256 got = agg.swap(p, h, usdcIn, q, alice, block.timestamp);
        assertEq(got, q, "buy fills at the quote");

        (p[0], p[1]) = (token, USDC);
        IERC20(token).approve(address(agg), type(uint256).max);
        uint256 q2 = agg.quote(p, h, got);
        assertGt(q2, 0, "sell quote");
        uint256 back = agg.swap(p, h, got, q2, alice, block.timestamp);
        vm.stopPrank();
        assertEq(back, q2, "sell fills at the quote");
        assertLt(back, usdcIn, "round trip pays fees");
        assertGt(back, usdcIn * 95 / 100, "fees stay within a few percent");
    }

    function test_launch_pool_deepest() public {
        if (block.chainid != 91342) return;
        _roundTrip(0xee1fdbfAF4e11676b78EA5C436a185e3dAf93e03, 5e6);
    }

    function test_launch_pool_second() public {
        if (block.chainid != 91342) return;
        _roundTrip(0x65554b4E7D4c6000bb3fdbEC87c199dEeFCcA3CE, 1e6);
    }

    function test_launch_pool_small() public {
        if (block.chainid != 91342) return;
        _roundTrip(0x28A51254A6F92307009d93675a42A67F21B5C034, 1e5);
    }
}
