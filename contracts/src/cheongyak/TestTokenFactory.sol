// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract IssuedToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address to) ERC20(name_, symbol_) {
        _mint(to, supply);
    }
}

/// @title TestTokenFactory — lets a project mint a testnet token to try a 청약 offering with.
contract TestTokenFactory {
    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 supply);

    address[] public tokens;

    function create(string calldata name, string calldata symbol, uint256 supply) external returns (address token) {
        require(bytes(name).length != 0 && bytes(name).length <= 40 && bytes(symbol).length != 0 && bytes(symbol).length <= 12, "bad name");
        require(supply != 0 && supply <= 1e30, "bad supply");
        token = address(new IssuedToken(name, symbol, supply, msg.sender));
        tokens.push(token);
        emit TokenCreated(token, msg.sender, name, symbol, supply);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }
}
