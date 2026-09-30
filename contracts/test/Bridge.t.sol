// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {JangteoBridge, IL1StandardBridge} from "../src/bridge/JangteoBridge.sol";

contract MockL1Bridge is IL1StandardBridge {
    address public lastTo;
    uint256 public lastValue;
    uint32 public lastGas;

    function bridgeETHTo(address to, uint32 minGasLimit, bytes calldata) external payable {
        lastTo = to;
        lastValue = msg.value;
        lastGas = minGasLimit;
    }
}

contract BridgeTest is Test {
    MockL1Bridge l1;
    JangteoBridge bridge;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");

    function setUp() public {
        l1 = new MockL1Bridge();
        bridge = new JangteoBridge(owner, l1, treasury, 50, 0.001 ether);
        vm.deal(user, 10 ether);
    }

    function test_DepositTakesHalfPercent() public {
        vm.prank(user);
        bridge.deposit{value: 2 ether}(user);
        assertEq(l1.lastValue(), 1.99 ether);
        assertEq(l1.lastTo(), user);
        assertEq(l1.lastGas(), 200_000);
        assertEq(bridge.feesAccrued(), 0.01 ether);
        assertEq(address(bridge).balance, 0.01 ether); // only the fee stays
        (uint256 got, uint256 fee) = bridge.quote(2 ether);
        assertEq(got, 1.99 ether);
        assertEq(fee, 0.01 ether);
    }

    function test_PlainTransferBridgesToSender() public {
        vm.prank(user);
        (bool ok,) = address(bridge).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(l1.lastTo(), user);
        assertEq(l1.lastValue(), 0.995 ether);
    }

    function test_SweepAndLimits() public {
        vm.prank(user);
        bridge.deposit{value: 1 ether}(user);
        bridge.sweepFees();
        assertEq(treasury.balance, 0.005 ether);
        vm.expectRevert(JangteoBridge.NothingToSweep.selector);
        bridge.sweepFees();

        vm.prank(user);
        vm.expectRevert(JangteoBridge.TooSmall.selector);
        bridge.deposit{value: 0.0005 ether}(user);

        vm.prank(owner);
        vm.expectRevert(JangteoBridge.BadParams.selector);
        bridge.setParams(treasury, 101, 0); // over the 1% cap
        vm.prank(user);
        vm.expectRevert();
        bridge.setParams(treasury, 10, 0);
    }

    function testFuzz_FeeNeverOverHalfPercent(uint96 amount) public {
        amount = uint96(bound(amount, 0.001 ether, 5 ether));
        vm.prank(user);
        bridge.deposit{value: amount}(user);
        assertEq(l1.lastValue() + bridge.feesAccrued(), amount);
        assertLe(bridge.feesAccrued(), uint256(amount) * 50 / 10_000);
    }
}
