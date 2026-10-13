// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoStocks, IStockOracle} from "../src/stocks/JangteoStocks.sol";
import {StockOracle} from "../src/stocks/StockOracle.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

/// 장터 주식: oracle (reporter = STOCKS_REPORTER), exchange + LP vault, and the 16 listed stocks.
contract DeployStocks is Script {
    function run() external {
        string memory base = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address gate = vm.parseJsonAddress(base, ".gate");
        address tkrw = vm.parseJsonAddress(base, ".tkrw");
        address reporter = vm.envAddress("STOCKS_REPORTER");

        vm.startBroadcast();
        StockOracle oracle = new StockOracle(msg.sender, reporter);
        JangteoStocks ex = new JangteoStocks(msg.sender, IIdentityGate(gate), IERC20(tkrw), IStockOracle(address(oracle)), msg.sender);
        ex.list("005930", "Jangteo Samsung Electronics", "jSAMSUNG", 0);
        ex.list("000660", "Jangteo SK hynix", "jSKHYNIX", 0);
        ex.list("373220", "Jangteo LG Energy Solution", "jLGES", 0);
        ex.list("005380", "Jangteo Hyundai Motor", "jHYUNDAI", 0);
        ex.list("035420", "Jangteo NAVER", "jNAVER", 0);
        ex.list("035720", "Jangteo Kakao", "jKAKAO", 0);
        ex.list("207940", "Jangteo Samsung Biologics", "jSAMBIO", 0);
        ex.list("105560", "Jangteo KB Financial", "jKB", 0);
        ex.list("NVDA", "Jangteo NVIDIA", "jNVDA", 1);
        ex.list("AAPL", "Jangteo Apple", "jAAPL", 1);
        ex.list("TSLA", "Jangteo Tesla", "jTSLA", 1);
        ex.list("MSFT", "Jangteo Microsoft", "jMSFT", 1);
        ex.list("GOOGL", "Jangteo Alphabet", "jGOOGL", 1);
        ex.list("AMZN", "Jangteo Amazon", "jAMZN", 1);
        ex.list("META", "Jangteo Meta", "jMETA", 1);
        ex.list("COIN", "Jangteo Coinbase", "jCOIN", 1);
        vm.stopBroadcast();

        console2.log("StockOracle", address(oracle));
        console2.log("JangteoStocks", address(ex));
        string memory o = "stocks";
        vm.serializeAddress(o, "stockOracle", address(oracle));
        string memory json = vm.serializeAddress(o, "stocks", address(ex));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".stocks.json"));
    }
}
