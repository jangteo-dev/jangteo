// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Cheongyak} from "../src/cheongyak/Cheongyak.sol";
import {TestTokenFactory} from "../src/cheongyak/TestTokenFactory.sol";
import {YutGame} from "../src/yut/YutGame.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

/// 청약 + 윷놀이, reusing the Dojang gate and tKRW from deployments/<chainid>.json.
contract DeployStalls is Script {
    function run() external {
        string memory base = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address gate = vm.parseJsonAddress(base, ".gate");
        address tkrw = vm.parseJsonAddress(base, ".tkrw");

        vm.startBroadcast();
        Cheongyak cy = new Cheongyak(msg.sender, IERC20(tkrw), IIdentityGate(gate), msg.sender, uint16(vm.envOr("CY_FEE_BPS", uint256(200))));
        TestTokenFactory tf = new TestTokenFactory();
        YutGame yut = new YutGame(
            msg.sender, IERC20(tkrw), IIdentityGate(gate), msg.sender, uint16(vm.envOr("YUT_FEE_BPS", uint256(300))), 120, 1_000e18
        );
        vm.stopBroadcast();

        console2.log("Cheongyak       ", address(cy));
        console2.log("TestTokenFactory", address(tf));
        console2.log("YutGame         ", address(yut));
        string memory o = "stalls";
        vm.serializeAddress(o, "cheongyak", address(cy));
        vm.serializeAddress(o, "tokenFactory", address(tf));
        string memory json = vm.serializeAddress(o, "yut", address(yut));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".stalls.json"));
    }
}
