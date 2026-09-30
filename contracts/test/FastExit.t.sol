// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {JangteoFastExit, IL2Messenger} from "../src/bridge/JangteoFastExit.sol";
import {JangteoFastVault, IL1Messenger} from "../src/bridge/JangteoFastVault.sol";

/// Plays both messengers: records the L2 message, then relays it on "L1" as GIWA's would.
contract MockMessengers is IL2Messenger, IL1Messenger {
    address public target;
    bytes public message;
    uint256 public value;
    address public l2Sender;
    address internal relaying;

    function sendMessage(address t, bytes calldata m, uint32) external payable {
        (target, message, value, l2Sender) = (t, m, msg.value, msg.sender);
    }

    function relay() external {
        relaying = l2Sender;
        (bool ok,) = target.call{value: value}(message);
        require(ok, "relay failed");
        relaying = address(0);
    }

    function relayAs(address fakeSender) external {
        relaying = fakeSender;
        (bool ok,) = target.call{value: value}(message);
        relaying = address(0);
        require(ok, "relay failed");
    }

    function xDomainMessageSender() external view returns (address) {
        return relaying;
    }

    receive() external payable {}
}

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

contract FastExitTest is Test {
    MockMessengers m;
    JangteoFastVault vault;
    JangteoFastExit exitc;
    address owner = makeAddr("owner");
    address user = makeAddr("user");
    address to = makeAddr("to");
    address filler = makeAddr("filler");

    function setUp() public {
        m = new MockMessengers();
        vault = new JangteoFastVault(owner, IL1Messenger(address(m)));
        exitc = new JangteoFastExit(owner, IL2Messenger(address(m)), address(vault), 100, 0.0005 ether, 0.002 ether, 1 ether);
        vm.prank(owner);
        vault.setL2Exit(address(exitc));
        vm.deal(user, 10 ether);
        vm.deal(filler, 10 ether);
        vm.deal(address(m), 0);
    }

    function _exit(uint256 amt) internal returns (uint256 id, uint256 out) {
        (out,) = exitc.quote(amt);
        vm.prank(user);
        id = exitc.exit{value: amt}(to);
    }

    function test_filled_exit_repays_filler_with_fee() public {
        (uint256 id, uint256 out) = _exit(0.1 ether);
        assertEq(out, 0.1 ether - 0.001 ether - 0.0005 ether);
        assertEq(m.value(), 0.1 ether, "whole deposit goes into the withdrawal");
        vm.prank(filler);
        vault.fill{value: out}(id, to, out);
        assertEq(to.balance, out, "user paid at once");
        m.relay();
        assertEq(filler.balance, 10 ether - out + 0.1 ether, "filler repaid deposit incl. fee");
        assertTrue(vault.settled(id));
    }

    function test_unfilled_exit_pays_user_everything() public {
        (uint256 id,) = _exit(0.1 ether);
        m.relay();
        assertEq(to.balance, 0.1 ether, "no filler: user gets the whole deposit, no fee");
        vm.prank(filler);
        vm.expectRevert(JangteoFastVault.AlreadySettled.selector);
        vault.fill{value: 0.0985 ether}(id, to, 0.0985 ether);
    }

    function test_wrong_fill_does_not_steal_settlement() public {
        (uint256 id, uint256 out) = _exit(0.1 ether);
        vm.prank(filler);
        vault.fill{value: out - 1}(id, to, out - 1); // wrong amount: its own key
        m.relay();
        assertEq(to.balance, (out - 1) + 0.1 ether, "user still gets the full settlement");
    }

    function test_double_fill_rejected() public {
        (uint256 id, uint256 out) = _exit(0.1 ether);
        vm.prank(filler);
        vault.fill{value: out}(id, to, out);
        vm.prank(filler);
        vm.expectRevert(JangteoFastVault.AlreadyFilled.selector);
        vault.fill{value: out}(id, to, out);
    }

    function test_only_messenger_from_exit_contract_settles() public {
        _exit(0.1 ether);
        vm.expectRevert("relay failed");
        m.relayAs(makeAddr("impostor"));
        vm.deal(address(this), 1 ether);
        vm.expectRevert(JangteoFastVault.NotMessenger.selector);
        vault.settle{value: 0.1 ether}(1, to, 1);
    }

    function test_bounced_payment_is_kept_for_withdraw() public {
        Rejecter r = new Rejecter();
        (uint256 out,) = exitc.quote(0.1 ether);
        vm.prank(user);
        exitc.exit{value: 0.1 ether}(address(r));
        m.relay();
        assertEq(vault.owed(address(r)), 0.1 ether);
        out;
    }

    function test_limits_and_params() public {
        vm.prank(user);
        vm.expectRevert(JangteoFastExit.OutOfRange.selector);
        exitc.exit{value: 0.001 ether}(to);
        vm.prank(user);
        vm.expectRevert(JangteoFastExit.OutOfRange.selector);
        exitc.exit{value: 2 ether}(to);
        vm.prank(owner);
        vm.expectRevert(JangteoFastExit.BadParams.selector);
        exitc.setParams(301, 0, 1, 2);
        vm.prank(owner);
        vm.expectRevert(JangteoFastVault.BadParams.selector);
        vault.setL2Exit(address(1));
    }
}
