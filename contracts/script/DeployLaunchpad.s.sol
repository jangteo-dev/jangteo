// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CheongyakV2, IUniswapV2Router02} from "../src/cheongyak/CheongyakV2.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

/// 장터 스왑 (official Uniswap V2 build artifacts, unmodified) + 청약 v2 on top of it.
/// Reuses the Dojang gate and tKRW from deployments/<chainid>.json; tKRW is the first allowed quote.
contract DeployLaunchpad is Script {
    address constant WETH = 0x4200000000000000000000000000000000000006;

    function run() external {
        string memory base = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address gate = vm.parseJsonAddress(base, ".gate");
        address tkrw = vm.parseJsonAddress(base, ".tkrw");
        bytes memory fCode = vm.parseBytes(vm.readFile("external/uniswap/UniswapV2Factory.hex"));
        bytes memory rCode = vm.parseBytes(vm.readFile("external/uniswap/UniswapV2Router02.hex"));

        vm.startBroadcast();
        address factory = _create(abi.encodePacked(fCode, abi.encode(msg.sender)));
        address router = _create(abi.encodePacked(rCode, abi.encode(factory, WETH)));
        CheongyakV2 cy = new CheongyakV2(
            msg.sender, IIdentityGate(gate), IUniswapV2Router02(router), msg.sender, uint16(vm.envOr("CY_FEE_BPS", uint256(200)))
        );
        cy.setQuote(tkrw, true);
        cy.setQuote(WETH, true);
        vm.stopBroadcast();

        console2.log("UniswapV2Factory", factory);
        console2.log("UniswapV2Router ", router);
        console2.log("CheongyakV2     ", address(cy));
        string memory o = "launchpad";
        vm.serializeAddress(o, "swapFactory", factory);
        vm.serializeAddress(o, "swapRouter", router);
        string memory json = vm.serializeAddress(o, "cheongyakV2", address(cy));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".launchpad.json"));
    }

    function _create(bytes memory code) private returns (address a) {
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0), "create failed");
    }
}
