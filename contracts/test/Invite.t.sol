// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {JangteoInvite} from "../src/points/JangteoInvite.sol";

contract InviteTest is Test {
    JangteoInvite inv;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        inv = new JangteoInvite();
    }

    function test_join_once() public {
        vm.expectEmit(true, true, false, false);
        emit JangteoInvite.Invited(bob, alice);
        vm.prank(bob);
        inv.join(alice);
        assertEq(inv.referrerOf(bob), alice);
        assertEq(inv.invitedCount(alice), 1);
        vm.prank(bob);
        vm.expectRevert(JangteoInvite.AlreadyJoined.selector);
        inv.join(carol);
    }

    function test_no_self_zero_or_loop() public {
        vm.startPrank(bob);
        vm.expectRevert(JangteoInvite.BadReferrer.selector);
        inv.join(bob);
        vm.expectRevert(JangteoInvite.BadReferrer.selector);
        inv.join(address(0));
        inv.join(alice);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(JangteoInvite.BadReferrer.selector);
        inv.join(bob);
        vm.prank(carol);
        inv.join(bob); // chains are fine, loops are not
        assertEq(inv.invitedCount(bob), 1);
    }
}
