// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title GyeWon — testnet KRW stablecoin for GIWA Sepolia circles.
/// @notice Anyone may draw 1,000,000 tKRW once every 24 hours. It has no value.
contract GyeWon is ERC20 {
    uint256 public constant DRIP = 1_000_000e18;
    uint256 public constant INTERVAL = 1 days;

    mapping(address => uint256) public lastDrip;

    error TooSoon(uint256 nextAt);

    constructor() ERC20("Gye Test Won", "tKRW") {}

    function drip() external {
        uint256 next = lastDrip[msg.sender] + INTERVAL;
        if (lastDrip[msg.sender] != 0 && block.timestamp < next) revert TooSoon(next);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, DRIP);
    }
}
