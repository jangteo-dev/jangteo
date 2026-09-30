// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {InsaDrop} from "../src/insa/InsaDrop.sol";
import {InsaMarket} from "../src/insa/InsaMarket.sol";

/// Random listings, buys, offers, accepts and cancels by four traders.
contract MarketHandler is Test {
    InsaMarket public m;
    InsaDrop public d;
    address[4] public users;
    uint256 public sales;
    uint256 public accepts;

    constructor(InsaMarket m_, InsaDrop d_, address[4] memory u) {
        m = m_;
        d = d_;
        users = u;
    }

    function _u(uint256 s) internal view returns (address) {
        return users[s % 4];
    }

    function list(uint256 id, uint128 price) external {
        id = bound(id, 1, 8);
        address o = d.ownerOf(id);
        price = uint128(bound(price, 1e12, 5 ether));
        vm.prank(o);
        m.list(address(d), id, price, uint64(block.timestamp + 1 days));
    }

    function buy(uint256 id, uint256 who) external {
        id = bound(id, 1, 8);
        (address s, uint128 p,) = m.listings(address(d), id);
        address b = _u(who);
        if (s == address(0) || s == b || !m.isLive(address(d), id)) return;
        vm.prank(b);
        m.buy{value: p}(address(d), id);
        sales++;
    }

    function offer(uint256 who, uint256 id, uint96 amt) external {
        amt = uint96(bound(amt, 1e12, 3 ether));
        id = bound(id, 0, 9);
        vm.prank(_u(who));
        m.makeOffer{value: amt}(address(d), id == 9 ? type(uint256).max : id, uint64(block.timestamp + 1 days));
    }

    function accept(uint256 i, uint256 id) external {
        uint256 n = m.offerCount();
        if (n == 0) return;
        i = bound(i, 0, n - 1);
        (address buyer,, uint256 tid,,, bool open) = m.offers(i);
        if (!open) return;
        id = tid == type(uint256).max ? bound(id, 1, 8) : tid;
        if (id == 0 || id > 8) return;
        address o = d.ownerOf(id);
        if (o == buyer) return;
        vm.prank(o);
        m.acceptOffer(i, id);
        accepts++;
    }

    function cancel(uint256 i) external {
        uint256 n = m.offerCount();
        if (n == 0) return;
        i = bound(i, 0, n - 1);
        (address buyer,,,,, bool open) = m.offers(i);
        if (!open) return;
        vm.prank(buyer);
        m.cancelOffer(i);
    }

    function openOffers() external view returns (uint256 sum) {
        for (uint256 i; i < m.offerCount(); ++i) {
            (,,, uint128 p,, bool open) = m.offers(i);
            if (open) sum += p;
        }
    }
}

contract InsaInvariantTest is Test {
    MarketHandler h;
    InsaMarket m;

    function setUp() public {
        vm.warp(1_800_000_000);
        m = new InsaMarket(address(this), makeAddr("treasury"), 200);
        InsaDrop.Phase[] memory ph = new InsaDrop.Phase[](1);
        ph[0] = InsaDrop.Phase(uint64(block.timestamp), 0, 0, 0, bytes32(0));
        InsaDrop d = new InsaDrop(InsaDrop.Config("T", "T", address(this), makeAddr("creator"), 8, 700, "", "", address(0)), ph, makeAddr("treasury"), 250);
        address[4] memory u = [makeAddr("u0"), makeAddr("u1"), makeAddr("u2"), makeAddr("u3")];
        for (uint256 i; i < 4; ++i) {
            vm.deal(u[i], 1_000 ether);
            vm.startPrank(u[i]);
            d.mint(0, 2, new bytes32[](0));
            d.setApprovalForAll(address(m), true);
            vm.stopPrank();
        }
        h = new MarketHandler(m, d, u);
        targetContract(address(h));
    }

    /// The market holds exactly the ETH of open offers (every payee here accepts ETH).
    function invariant_EscrowMatchesOpenOffers() public view {
        assertEq(address(m).balance, h.openOffers());
    }

    function afterInvariant() public view {
        assertGt(h.sales() + h.accepts(), 0, "handler never traded");
    }
}
