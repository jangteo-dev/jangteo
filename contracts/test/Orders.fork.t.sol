// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoAggregator} from "../src/swap/JangteoAggregator.sol";
import {JangteoOrders} from "../src/swap/JangteoOrders.sol";

/// Limit orders and DCA against live GIWA pools: `forge test --match-contract OrdersFork --fork-url https://sepolia-rpc.giwa.io`.
contract OrdersForkTest is Test {
    JangteoAggregator constant AGG = JangteoAggregator(payable(0x2FA909C6b98497Ff3b5B10AbA7A0Db98Ab5CD1BC));
    address constant NARU = 0xC3558e02DA63D4E9693AddD10e0c4551B30303a6; // Naruswap WETH pair (no-data V2)
    address constant TOKEN = 0xaEF40Bb184aA7e367ff535671B2263670a1f5Eac;

    JangteoOrders orders;
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");

    function setUp() public {
        if (block.chainid != 91342) return;
        orders = new JangteoOrders(address(this), AGG, treasury, 10, keeper);
        vm.deal(alice, 10 ether);
    }

    function _route(address a, address b) internal pure returns (address[] memory p, JangteoAggregator.Hop[] memory h) {
        p = new address[](2);
        (p[0], p[1]) = (a, b);
        h = new JangteoAggregator.Hop[](1);
        h[0] = JangteoAggregator.Hop(NARU, 1, 3000);
    }

    function test_limit_fills_only_at_its_price() public {
        if (block.chainid != 91342) return;
        (address[] memory p, JangteoAggregator.Hop[] memory h) = _route(address(0), TOKEN);
        uint256 q = AGG.quote(p, h, 0.00999 ether); // what 0.01 ETH less the 0.1% order fee buys now
        uint256 rate = q * 1e18 / 0.00999 ether;
        // A limit 5% above the market: the keeper cannot fill it.
        vm.prank(alice);
        uint256 id = orders.createLimit{value: 0.01 ether}(address(0), TOKEN, 0.01 ether, rate * 105 / 100, uint64(block.timestamp + 1 days));
        vm.prank(keeper);
        vm.expectRevert();
        orders.execute(id, p, h, 0);
        // Only keepers execute.
        vm.expectRevert(JangteoOrders.NotKeeper.selector);
        orders.execute(id, p, h, 0);
        // A limit at 95% of the market fills, straight to Alice, fee to the treasury.
        vm.prank(alice);
        uint256 id2 = orders.createLimit{value: 0.01 ether}(address(0), TOKEN, 0.01 ether, rate * 95 / 100, uint64(block.timestamp + 1 days));
        vm.prank(keeper);
        uint256 out = orders.execute(id2, p, h, 0);
        assertEq(IERC20(TOKEN).balanceOf(alice), out);
        assertGe(out, (0.00999 ether * (rate * 95 / 100)) / 1e18);
        assertEq(treasury.balance, 0.00001 ether, "0.1% order fee (the aggregator pays its own treasury)");
        // The unfilled one goes back to Alice when she cancels, or to anyone after expiry.
        vm.warp(block.timestamp + 2 days);
        uint256 b = alice.balance;
        orders.expire(id);
        assertEq(alice.balance - b, 0.01 ether);
        assertEq(address(orders).balance, 0, "nothing left in escrow");
    }

    function test_dca_runs_on_schedule_and_cancels() public {
        if (block.chainid != 91342) return;
        (address[] memory p, JangteoAggregator.Hop[] memory h) = _route(address(0), TOKEN);
        vm.prank(alice);
        uint256 id = orders.createDca{value: 0.03 ether}(address(0), TOKEN, 0.03 ether, 3, 3600, 0);
        vm.prank(keeper);
        orders.execute(id, p, h, 1);
        vm.prank(keeper);
        vm.expectRevert(JangteoOrders.NotDue.selector);
        orders.execute(id, p, h, 1);
        vm.warp(block.timestamp + 3600);
        vm.prank(keeper);
        orders.execute(id, p, h, 1);
        assertEq(orders.order(id).remaining, 0.01 ether);
        uint256 b = alice.balance;
        vm.prank(alice);
        orders.cancel(id);
        assertEq(alice.balance - b, 0.01 ether);
        assertGt(IERC20(TOKEN).balanceOf(alice), 0);
    }

    function test_token_in_dca_and_wrong_route_rejected() public {
        if (block.chainid != 91342) return;
        deal(TOKEN, alice, 1_000_000 ether);
        vm.startPrank(alice);
        IERC20(TOKEN).approve(address(orders), type(uint256).max);
        uint256 id = orders.createDca(TOKEN, address(0), 1_000_000 ether, 2, 600, 0);
        vm.stopPrank();
        (address[] memory bad, JangteoAggregator.Hop[] memory h) = _route(address(0), TOKEN);
        vm.prank(keeper);
        vm.expectRevert(JangteoOrders.BadRoute.selector);
        orders.execute(id, bad, h, 1);
        (address[] memory p,) = _route(TOKEN, address(0));
        uint256 b = alice.balance;
        vm.prank(keeper);
        orders.execute(id, p, h, 1);
        assertGt(alice.balance, b, "ETH out to Alice");
        assertEq(IERC20(TOKEN).balanceOf(address(orders)), 500_000 ether, "only the unsold half stays in escrow");
    }
}
