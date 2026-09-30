// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {GyeWon} from "../src/GyeWon.sol";
import {GyeFactory} from "../src/GyeFactory.sol";
import {GyeReputation} from "../src/GyeReputation.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll, IEAS, ISchemaRegistry} from "../src/interfaces/IExternal.sol";

/// forge script script/Deploy.s.sol --rpc-url giwa_sepolia --broadcast --private-key $GIWA_DEPLOYER_KEY
contract Deploy is Script {
    // GIWA predeploys / Dojang (docs.giwa.io/network-information/contracts, dojang README)
    ISchemaRegistry constant SCHEMA_REGISTRY = ISchemaRegistry(0x4200000000000000000000000000000000000020);
    IEAS constant EAS = IEAS(0x4200000000000000000000000000000000000021);
    IDojangScroll constant DOJANG_SCROLL = IDojangScroll(0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9);

    bytes32 constant UPBIT_KOREA = keccak256("dojang.dojangattesterids.upbitkorea");
    bytes32 constant TESTNET_FAUCET = 0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678;

    string constant SCHEMA = "address circle,uint8 outcome,uint256 contributedUsd,uint256 lossUsd,uint16 missedRounds";

    function run() external {
        address deployer = msg.sender;
        uint32 minRound = uint32(vm.envOr("GYE_MIN_ROUND", uint256(60)));

        vm.startBroadcast();

        bytes32 schemaUid = SCHEMA_REGISTRY.register(SCHEMA, address(0), false);

        bytes32[] memory attesters = new bytes32[](2);
        attesters[0] = UPBIT_KOREA;
        attesters[1] = TESTNET_FAUCET;
        DojangGate gate = new DojangGate(deployer, DOJANG_SCROLL, attesters);

        GyeReputation rep = new GyeReputation(deployer, EAS, schemaUid);
        GyeFactory factory = new GyeFactory(deployer, rep, gate, minRound);
        rep.setFactory(address(factory));

        GyeWon won = new GyeWon();
        // 1 KRW ≈ $0.000714 (1400 KRW/USD) → USD(1e18) per raw unit, scaled 1e18.
        factory.listToken(address(won), 714_285_714_285_714);

        vm.stopBroadcast();

        console2.log("schemaUid");
        console2.logBytes32(schemaUid);
        console2.log("DojangGate    ", address(gate));
        console2.log("GyeReputation ", address(rep));
        console2.log("GyeFactory    ", address(factory));
        console2.log("CircleImpl    ", factory.implementation());
        console2.log("tKRW          ", address(won));

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeBytes32(o, "schemaUid", schemaUid);
        vm.serializeAddress(o, "gate", address(gate));
        vm.serializeAddress(o, "reputation", address(rep));
        vm.serializeAddress(o, "factory", address(factory));
        vm.serializeAddress(o, "implementation", factory.implementation());
        vm.serializeAddress(o, "dojangScroll", address(DOJANG_SCROLL));
        vm.serializeAddress(o, "eas", address(EAS));
        string memory json = vm.serializeAddress(o, "tkrw", address(won));
        string memory out = vm.envOr("GYE_DEPLOY_OUT", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        vm.writeJson(json, out);
    }
}
