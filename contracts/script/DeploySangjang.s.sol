// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SangjangMarket} from "../src/sangjang/SangjangMarket.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

/// Reuses the Dojang gate and tKRW from the Gye deployment (deployments/<chainid>.json).
/// forge script script/DeploySangjang.s.sol --rpc-url giwa_sepolia --broadcast --private-key $GIWA_DEPLOYER_KEY
contract DeploySangjang is Script {
    function run() external {
        string memory base = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address gate = vm.parseJsonAddress(base, ".gate");
        address tkrw = vm.parseJsonAddress(base, ".tkrw");
        uint64 window = uint64(vm.envOr("SANGJANG_WINDOW", uint256(1 hours)));
        uint128 bond = uint128(vm.envOr("SANGJANG_BOND", uint256(50_000e18)));

        vm.startBroadcast();
        SangjangMarket mkt = new SangjangMarket(msg.sender, IERC20(tkrw), IIdentityGate(gate), msg.sender, window, bond);
        // The ops keeper curates and resolves; the owner (same key on testnet) arbitrates disputes.
        mkt.setRoles(msg.sender, true, true);
        vm.stopBroadcast();

        console2.log("SangjangMarket", address(mkt));
        string memory o = "sangjang";
        vm.serializeAddress(o, "market", address(mkt));
        vm.serializeUint(o, "challengeWindow", window);
        string memory json = vm.serializeUint(o, "disputeBond", bond);
        vm.writeJson(json, vm.envOr("SANGJANG_OUT", string.concat("deployments/", vm.toString(block.chainid), ".sangjang.json")));
    }
}
