// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title StockToken — one 장터 주식 stock (18 decimals: fractional shares). Minted on buy and burned
///         on sell by the exchange only; otherwise a plain, freely transferable ERC-20.
contract StockToken is ERC20 {
    address public immutable exchange;
    bytes32 public immutable sym;

    error OnlyExchange();

    constructor(string memory name_, string memory symbol_, bytes32 sym_) ERC20(name_, symbol_) {
        exchange = msg.sender;
        sym = sym_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != exchange) revert OnlyExchange();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != exchange) revert OnlyExchange();
        _burn(from, amount);
    }
}
