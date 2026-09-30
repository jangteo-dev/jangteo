// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {GyeFactory} from "../src/GyeFactory.sol";
import {GyeReputation} from "../src/GyeReputation.sol";
import {IEAS} from "../src/interfaces/IExternal.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

/// Redeploys the circle stack (reputation + factory + template) with the platform fee, reusing the
/// Dojang gate, tKRW and EAS schema from deployments/<chainid>.json, then rewrites that file.
contract DeployGyeV2 is Script {
    function run() external {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory base = vm.readFile(path);
        address gate = vm.parseJsonAddress(base, ".gate");
        address tkrw = vm.parseJsonAddress(base, ".tkrw");
        address eas = vm.parseJsonAddress(base, ".eas");
        address scroll = vm.parseJsonAddress(base, ".dojangScroll");
        bytes32 schemaUid = vm.parseJsonBytes32(base, ".schemaUid");
        uint32 minRound = uint32(vm.envOr("GYE_MIN_ROUND", uint256(600)));
        uint16 fee = uint16(vm.envOr("GYE_FEE_BPS", uint256(100)));

        vm.startBroadcast();
        GyeReputation rep = new GyeReputation(msg.sender, IEAS(eas), schemaUid);
        GyeFactory factory = new GyeFactory(msg.sender, rep, IIdentityGate(gate), minRound);
        rep.setFactory(address(factory));
        factory.listToken(tkrw, 714_285_714_285_714);
        factory.setFee(msg.sender, fee);
        vm.stopBroadcast();

        console2.log("GyeReputation", address(rep));
        console2.log("GyeFactory   ", address(factory));
        console2.log("CircleImpl   ", factory.implementation());

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeBytes32(o, "schemaUid", schemaUid);
        vm.serializeAddress(o, "gate", gate);
        vm.serializeAddress(o, "reputation", address(rep));
        vm.serializeAddress(o, "factory", address(factory));
        vm.serializeAddress(o, "implementation", factory.implementation());
        vm.serializeAddress(o, "dojangScroll", scroll);
        vm.serializeAddress(o, "eas", eas);
        vm.serializeUint(o, "feeBps", fee);
        string memory json = vm.serializeAddress(o, "tkrw", tkrw);
        vm.writeJson(json, path);
    }
}
