// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {InsaFactory} from "../src/insa/InsaFactory.sol";
import {InsaMarket} from "../src/insa/InsaMarket.sol";
import {TalArt} from "../src/insa/TalArt.sol";
import {TalRenderer} from "../src/insa/TalRenderer.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

/// 인사동 Insadong: the drop factory (2.5% of mint income), the market (2% per sale) and the
/// renderer of Jangteo's own collection, 탈 Tal. The Tal drop itself is created by ops (`nft:tal`),
/// which builds its allowlists.
contract DeployInsa is Script {
    function run() external {
        string memory base = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address gate = vm.parseJsonAddress(base, ".gate");

        vm.startBroadcast();
        InsaFactory factory = new InsaFactory(msg.sender, IIdentityGate(gate), msg.sender, 250);
        InsaMarket market = new InsaMarket(msg.sender, msg.sender, 200);
        TalArt art = new TalArt();
        TalRenderer renderer = new TalRenderer(art);
        vm.stopBroadcast();

        console2.log("InsaFactory ", address(factory));
        console2.log("InsaMarket  ", address(market));
        console2.log("TalArt      ", address(art));
        console2.log("TalRenderer ", address(renderer));
        string memory o = "insa";
        vm.serializeAddress(o, "insaFactory", address(factory));
        vm.serializeAddress(o, "insaMarket", address(market));
        vm.serializeAddress(o, "talArt", address(art));
        string memory json = vm.serializeAddress(o, "talRenderer", address(renderer));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".insa.json"));
    }
}
