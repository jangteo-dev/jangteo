// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {JangteoDaily} from "../src/points/JangteoDaily.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

contract Gate is IIdentityGate {
    mapping(address => bool) public ok;

    function set(address a, bool v) external {
        ok[a] = v;
    }

    function isEligible(address a) external view returns (bool) {
        return ok[a];
    }
}

contract DailyTest is Test {
    Gate gate;
    JangteoDaily d;
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_790_000_000);
        vm.roll(100);
        gate = new Gate();
        d = new JangteoDaily(gate);
        gate.set(alice, true);
    }

    function test_one_spin_per_kst_day_and_streak() public {
        vm.prank(alice);
        uint256 day = d.spin();
        vm.prank(alice);
        vm.expectRevert(JangteoDaily.AlreadySpun.selector);
        d.spin();
        (bool ready,) = d.result(alice, day);
        assertFalse(ready, "next block not yet mined");
        vm.roll(block.number + 2);
        (bool r2, uint256 reward) = d.result(alice, day);
        assertTrue(r2);
        assertEq(reward, d.rewardFor(blockhash(101), alice, day));
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        d.spin();
        assertEq(d.streak(alice), 2);
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice);
        d.spin();
        assertEq(d.streak(alice), 1, "a missed day resets the streak");
    }

    function test_day_turns_at_midnight_kst() public {
        // 2026-09-24 14:59:59 UTC = 23:59:59 KST; one second later it is the next Korean day.
        vm.warp(1_790_261_999);
        uint256 a = d.today();
        vm.warp(1_790_262_000);
        assertEq(d.today(), a + 1);
    }

    function test_unverified_cannot_spin() public {
        vm.prank(makeAddr("bob"));
        vm.expectRevert(JangteoDaily.NotVerified.selector);
        d.spin();
    }

    function test_reward_distribution() public view {
        uint256 total;
        uint256[7] memory seen;
        for (uint256 i; i < 4000; ++i) {
            uint256 r = d.rewardFor(keccak256(abi.encode(i)), alice, 1);
            total += r;
            seen[r == 10 ? 0 : r == 20 ? 1 : r == 30 ? 2 : r == 50 ? 3 : r == 100 ? 4 : r == 200 ? 5 : 6]++;
        }
        assertApproxEqRel(total / 4000, 35, 0.15e18); // expected 35.5 P a spin
        for (uint256 k; k < 7; ++k) assertGt(seen[k], 0);
    }
}
