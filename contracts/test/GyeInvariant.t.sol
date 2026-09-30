// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GyeBase} from "./GyeBase.t.sol";
import {GyeCircle} from "../src/GyeCircle.sol";
import {MockToken} from "./mocks/Mocks.sol";

contract CircleHandler is Test {
    GyeCircle public c;
    MockToken public usd;
    address[] public ms;
    uint256 public claimedOut;
    uint256 public paidIn;

    constructor(GyeCircle c_, MockToken usd_) {
        c = c_;
        usd = usd_;
        ms = c_.members();
    }

    function pay(uint256 i) external {
        address m = ms[i % ms.length];
        if (c.phase() != GyeCircle.Phase.Active || c.hasPaid(m)) return;
        vm.prank(m);
        c.contribute();
        paidIn += c.config().contribution;
    }

    function bid(uint256 i, uint128 amt) external {
        address m = ms[i % ms.length];
        vm.prank(m);
        try c.bid(uint128(bound(amt, 1, 200e6))) {} catch {}
    }

    function settle(uint256 dt) external {
        if (c.phase() != GyeCircle.Phase.Active) return;
        vm.warp(block.timestamp + bound(dt, 0, 8 days));
        if (block.timestamp < c.deadline()) return;
        c.settle();
    }

    function repay(uint256 i, uint128 amt) external {
        address m = ms[i % ms.length];
        uint128 debt = c.memberOf(m).debt;
        if (debt == 0) return;
        uint128 a = uint128(bound(amt, 1, debt));
        vm.prank(m);
        c.repayDebt(a);
        paidIn += a;
    }

    function claim(uint256 i) external {
        address m = ms[i % ms.length];
        uint256 amt = c.memberOf(m).claimable;
        if (amt == 0) return;
        vm.prank(m);
        c.claim();
        claimedOut += amt;
    }
}

contract GyeInvariantTest is GyeBase {
    CircleHandler internal h;
    GyeCircle internal circle;
    uint256 internal initialBalance;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        factory.setFee(makeAddr("treasury"), 100); // exercise the books with the fee switched on
        circle = _circle(6, GyeCircle.Mode.Auction, 0);
        initialBalance = usd.balanceOf(address(circle));
        h = new CircleHandler(circle, usd);
        targetContract(address(h));
    }

    function invariant_BooksBalance() public view {
        _assertBooks(circle);
    }

    function invariant_NoTokensCreatedOrLost() public view {
        assertEq(usd.balanceOf(address(circle)), initialBalance + h.paidIn() - h.claimedOut());
    }

    function invariant_AtMostOneRecipientPerSettledRound() public view {
        address[] memory m = circle.members();
        uint256 received;
        for (uint256 i; i < m.length; ++i) {
            if (circle.memberOf(m[i]).received) ++received;
        }
        uint256 settled = circle.phase() == GyeCircle.Phase.Completed ? 6 : circle.round() - 1;
        assertEq(received, settled);
    }
}
