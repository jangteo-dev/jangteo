// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoAggregator, IV2FactoryAgg} from "../src/swap/JangteoAggregator.sol";
import {JangteoOrders} from "../src/swap/JangteoOrders.sol";
import {MockToken} from "./mocks/Mocks.sol";
import {WETH9} from "./Pump.t.sol";

interface IRouterT {
    function addLiquidityETH(address token, uint256 a, uint256 aMin, uint256 eMin, address to, uint256 d) external payable returns (uint256, uint256, uint256);
}

interface IFactoryT2 {
    function getPair(address, address) external view returns (address);
}

/// A factory with no pairs: every route is "outside Jangteo Swap", so the aggregator fee applies too.
contract EmptyFactory {
    function getPair(address, address) external pure returns (address) {
        return address(0);
    }
}

/// Drives random sequences of creates, fills, cancels, expiries and clock moves against a real
/// Uniswap V2 pool through the real aggregator.
contract OrdersHandler is Test {
    JangteoOrders public orders;
    MockToken public tok;
    address public pair;
    address keeper;
    address[] users;
    uint256[] public ids;
    uint256 public fills;
    uint256 public closes;

    constructor(JangteoOrders o, MockToken t, address p, address k) {
        orders = o;
        tok = t;
        pair = p;
        keeper = k;
        for (uint256 i; i < 3; ++i) {
            address u = makeAddr(string(abi.encode("u", i)));
            users.push(u);
            vm.deal(u, 1_000 ether);
            t.mint(u, 1e30);
            vm.prank(u);
            t.approve(address(o), type(uint256).max);
        }
    }

    function _route(bool ethIn) internal view returns (address[] memory p, JangteoAggregator.Hop[] memory h) {
        p = new address[](2);
        (p[0], p[1]) = ethIn ? (address(0), address(tok)) : (address(tok), address(0));
        h = new JangteoAggregator.Hop[](1);
        h[0] = JangteoAggregator.Hop(pair, 0, 3000);
    }

    function limitBuy(uint256 u, uint256 amt, uint256 rate) external {
        address who = users[u % users.length];
        amt = bound(amt, 1e12, 5 ether);
        rate = bound(rate, 1, 2e21); // up to 2000 tokens per ETH, so some fill and some wait
        vm.prank(who);
        ids.push(orders.createLimit{value: amt}(address(0), address(tok), amt, rate, uint64(block.timestamp + 3 days)));
    }

    function limitSell(uint256 u, uint256 amt, uint256 rate) external {
        address who = users[u % users.length];
        amt = bound(amt, 1e15, 5_000 ether);
        rate = bound(rate, 1, 2e15);
        vm.prank(who);
        ids.push(orders.createLimit(address(tok), address(0), amt, rate, uint64(block.timestamp + 3 days)));
    }

    function dca(uint256 u, uint256 amt, uint256 n, bool ethIn) external {
        address who = users[u % users.length];
        n = bound(n, 2, 6);
        vm.prank(who);
        if (ethIn) ids.push(orders.createDca{value: bound(amt, 1e12, 3 ether)}(address(0), address(tok), bound(amt, 1e12, 3 ether), uint32(n), 3600, 0));
        else ids.push(orders.createDca(address(tok), address(0), bound(amt, 1e15, 3_000 ether), uint32(n), 3600, 0));
    }

    function execute(uint256 i) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        JangteoOrders.Order memory o = orders.order(id);
        (address[] memory p, JangteoAggregator.Hop[] memory h) = _route(o.tokenIn == address(0));
        vm.prank(keeper);
        try orders.execute(id, p, h, 0) {
            fills++;
        } catch {}
    }

    function cancel(uint256 i) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        vm.prank(orders.order(id).owner);
        try orders.cancel(id) {
            closes++;
        } catch {}
    }

    function expire(uint256 i) external {
        if (ids.length == 0) return;
        try orders.expire(ids[i % ids.length]) {} catch {}
    }

    function warp(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 2 days));
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }
}

contract OrdersInvariantTest is Test {
    WETH9 weth;
    MockToken tok;
    JangteoAggregator agg;
    JangteoOrders orders;
    OrdersHandler h;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");

    function setUp() public {
        vm.warp(1_800_000_000);
        weth = new WETH9();
        bytes memory f = abi.encodePacked(vm.parseBytes(vm.readFile("external/uniswap/UniswapV2Factory.hex")), abi.encode(owner));
        address fa;
        assembly {
            fa := create(0, add(f, 0x20), mload(f))
        }
        bytes memory r = abi.encodePacked(vm.parseBytes(vm.readFile("external/uniswap/UniswapV2Router02.hex")), abi.encode(fa, address(weth)));
        address ra;
        assembly {
            ra := create(0, add(r, 0x20), mload(r))
        }
        tok = new MockToken(18);
        tok.mint(address(this), 1e30);
        tok.approve(ra, type(uint256).max);
        vm.deal(address(this), 1_000 ether);
        IRouterT(ra).addLiquidityETH{value: 500 ether}(address(tok), 500_000 ether, 0, 0, address(this), block.timestamp);
        address pair = IFactoryT2(fa).getPair(address(tok), address(weth));
        // A different "home" factory, so the aggregator charges its fee too: the harder case.
        agg = new JangteoAggregator(owner, address(weth), IV2FactoryAgg(address(new EmptyFactory())), treasury, 10);
        orders = new JangteoOrders(owner, agg, treasury, 10, keeper);
        h = new OrdersHandler(orders, tok, pair, keeper);
        targetContract(address(h));
    }

    /// Escrow is exact: what the contract holds is precisely what open orders still owe.
    function invariant_escrow_is_exact() public view {
        uint256 eth;
        uint256 tk;
        uint256 n = orders.orderCount();
        for (uint256 i; i < n; ++i) {
            JangteoOrders.Order memory o = orders.order(i);
            if (o.tokenIn == address(0)) eth += o.remaining;
            else tk += o.remaining;
        }
        assertEq(address(orders).balance, eth, "ETH escrow");
        assertEq(tok.balanceOf(address(orders)), tk, "token escrow");
        assertEq(weth.balanceOf(address(orders)), 0, "no stray WETH");
        assertEq(tok.balanceOf(address(agg)) + weth.balanceOf(address(agg)) + address(agg).balance, 0, "aggregator holds nothing");
    }

    /// No order ever sells more than it escrowed or fills more slices than it has.
    function invariant_orders_consistent() public view {
        uint256 n = orders.orderCount();
        for (uint256 i; i < n; ++i) {
            JangteoOrders.Order memory o = orders.order(i);
            assertLe(o.remaining, o.total);
            if (o.slices > 0) assertLe(o.done, o.slices);
        }
    }

    /// The fuzzer really fills and cancels orders (not just reverting quietly inside try/catch).
    function afterInvariant() external view {
        if (h.idCount() > 20) assertGt(h.fills() + h.closes(), 0, "handler did real work");
    }

    function test_handler_fills_through_the_pool() public {
        h.limitBuy(0, 1 ether, 1); // any price: fills at once
        h.execute(0);
        assertEq(h.fills(), 1);
        h.dca(1, 3000 ether, 3, false);
        h.execute(1);
        assertEq(h.fills(), 2);
        invariant_escrow_is_exact();
    }

    function test_keeper_and_params_are_timelocked() public {
        address evil = makeAddr("evil");
        vm.prank(owner);
        orders.proposeKeeper(evil);
        vm.expectRevert(JangteoOrders.TooEarly.selector);
        orders.activateKeeper(evil);
        assertFalse(orders.keeper(evil));
        vm.warp(block.timestamp + 2 days);
        orders.activateKeeper(evil);
        assertTrue(orders.keeper(evil));
        vm.prank(owner);
        orders.removeKeeper(evil);
        assertFalse(orders.keeper(evil), "removal is immediate");

        vm.prank(owner);
        orders.proposeParams(evil, 50);
        vm.expectRevert(JangteoOrders.TooEarly.selector);
        orders.applyParams();
        vm.warp(block.timestamp + 2 days);
        orders.applyParams();
        assertEq(orders.feeBps(), 50);
        vm.prank(owner);
        vm.expectRevert(JangteoOrders.BadParams.selector);
        orders.proposeParams(evil, 51);
        vm.prank(evil);
        vm.expectRevert();
        orders.proposeKeeper(evil);
    }
}
