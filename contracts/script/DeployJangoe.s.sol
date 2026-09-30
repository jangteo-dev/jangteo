// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangoeMarket} from "../src/jangoe/JangoeMarket.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

/// 장외 premarket. Opens the standing points market; 청약 markets are opened by the ops curator.
contract DeployJangoe is Script {
    function run() external {
        string memory base = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address gate = vm.parseJsonAddress(base, ".gate");
        address tkrw = vm.parseJsonAddress(base, ".tkrw");

        vm.startBroadcast();
        JangoeMarket mk = new JangoeMarket(msg.sender, IIdentityGate(gate), msg.sender, uint16(vm.envOr("JANGOE_FEE_BPS", uint256(200))));
        mk.createMarket(
            "GIWA Points",
            IERC20(tkrw),
            15_000,
            '{"kind":"points","about":"GIWA ecosystem points, before any token exists. One unit is one point; the rate is fixed when a token launches."}'
        );
        vm.stopBroadcast();

        console2.log("JangoeMarket", address(mk));
        string memory o = "jangoe";
        string memory json = vm.serializeAddress(o, "jangoe", address(mk));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".jangoe.json"));
    }
}
