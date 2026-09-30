// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {JangteoPump, IWETH, IV2Factory} from "../src/pump/JangteoPump.sol";
import {JangteoPumpRouter, IV2Router} from "../src/pump/JangteoPumpRouter.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

/// 장터 뻥튀기: graduates at 4.2 ETH into 장터 스왑 (Uniswap V2), plus its V2-compatible router.
contract DeployPump is Script {
    address constant WETH = 0x4200000000000000000000000000000000000006;

    function run() external {
        string memory base = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        string memory lp = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".launchpad.json"));
        address gate = vm.parseJsonAddress(base, ".gate");
        address factory = vm.parseJsonAddress(lp, ".swapFactory");
        address v2 = vm.parseJsonAddress(lp, ".swapRouter");

        // v2 (2026-09-26): virtual 2 ETH so early buys take less of the curve; creators buy at most 0.1 ETH;
        // still graduates at 4.2 ETH.
        uint256 virtualEth = vm.envOr("PUMP_VIRTUAL_ETH", uint256(2 ether));
        uint256 maxCreatorBuy = vm.envOr("PUMP_MAX_CREATOR_BUY", uint256(0.1 ether));
        // 750M on the curve: with 2 ETH virtual, 250M must remain to open the pool at the curve's last price.
        uint256 curveSupply = vm.envOr("PUMP_CURVE_SUPPLY", uint256(750_000_000 ether));
        string memory out = vm.envOr("PUMP_OUT", string("pump2"));
        vm.startBroadcast();
        JangteoPump pump = new JangteoPump(
            msg.sender, IIdentityGate(gate), IWETH(WETH), IV2Factory(factory), msg.sender, 4.2 ether, virtualEth, curveSupply, maxCreatorBuy
        );
        JangteoPumpRouter router = new JangteoPumpRouter(pump, IV2Router(v2), WETH);
        vm.stopBroadcast();

        console2.log("JangteoPump       ", address(pump));
        console2.log("JangteoPumpRouter ", address(router));
        string memory o = "pump";
        vm.serializeAddress(o, "pump", address(pump));
        string memory json = vm.serializeAddress(o, "pumpRouter", address(router));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".", out, ".json"));
    }
}
