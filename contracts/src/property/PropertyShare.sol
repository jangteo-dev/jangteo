// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IPropertyRegistry {
    function onShareTransfer(uint256 id, address from, address to) external;
}

/// @title PropertyShare — the shares of one 장터 부동산 property.
/// @notice Whole shares (0 decimals). Minted and burned only by the registry; every balance change
///         asks the registry first, which settles rent for both sides and enforces who may hold.
contract PropertyShare is ERC20 {
    address public immutable registry;
    uint256 public immutable propertyId;

    error OnlyRegistry();

    constructor(string memory name_, string memory symbol_, uint256 id) ERC20(name_, symbol_) {
        registry = msg.sender;
        propertyId = id;
    }

    modifier onlyRegistry() {
        if (msg.sender != registry) revert OnlyRegistry();
        _;
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external onlyRegistry {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyRegistry {
        _burn(from, amount);
    }

    /// @notice Registry-only move for market escrow (no allowance needed).
    function move(address from, address to, uint256 amount) external onlyRegistry {
        _transfer(from, to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        IPropertyRegistry(registry).onShareTransfer(propertyId, from, to);
        super._update(from, to, value);
    }
}
