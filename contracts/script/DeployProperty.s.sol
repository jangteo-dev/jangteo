// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoProperty} from "../src/property/JangteoProperty.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

/// 장터 부동산. PROPERTY_PERIOD / PROPERTY_MIN_DURATION / PROPERTY_OUT let the live e2e deploy a
/// throwaway registry with a 10-minute rent period; the real one uses 30 days and 1 hour.
contract DeployProperty is Script {
    function run() external {
        string memory base = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address gate = vm.parseJsonAddress(base, ".gate");
        address tkrw = vm.parseJsonAddress(base, ".tkrw");
        uint256 period = vm.envOr("PROPERTY_PERIOD", uint256(30 days));
        uint256 minDuration = vm.envOr("PROPERTY_MIN_DURATION", uint256(1 hours));
        string memory out = vm.envOr("PROPERTY_OUT", string("property"));

        vm.startBroadcast();
        JangteoProperty reg = new JangteoProperty(msg.sender, IIdentityGate(gate), IERC20(tkrw), msg.sender, period, minDuration);
        vm.stopBroadcast();

        console2.log("JangteoProperty", address(reg));
        string memory o = "property";
        string memory json = vm.serializeAddress(o, "property", address(reg));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".", out, ".json"));
    }
}
