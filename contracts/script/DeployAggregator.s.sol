// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {JangteoAggregator, IV2FactoryAgg} from "../src/swap/JangteoAggregator.sol";

/// 장터 스왑 aggregator: routes through every DEX on GIWA, 0.1% on routes outside 장터 스왑's own pairs.
contract DeployAggregator is Script {
    address constant WETH = 0x4200000000000000000000000000000000000006;

    function run() external {
        string memory lp = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".launchpad.json"));
        address factory = vm.parseJsonAddress(lp, ".swapFactory");
        vm.startBroadcast();
        JangteoAggregator agg = new JangteoAggregator(msg.sender, WETH, IV2FactoryAgg(factory), msg.sender, 10);
        vm.stopBroadcast();
        console2.log("JangteoAggregator ", address(agg));
        string memory o = "agg";
        string memory json = vm.serializeAddress(o, "aggregator", address(agg));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".aggregator.json"));
    }
}
