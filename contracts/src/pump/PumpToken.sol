// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title PumpToken — a token born on 장터 펌프.
///
/// @notice A plain ERC20 of fixed supply, freely transferable from the first block, with one rule:
///         until its launch graduates, nobody can send it into its 장터 스왑 pair. That pair is
///         created empty at launch, so without the rule anyone could seed it at a made-up price
///         before graduation. After graduation the token is an ordinary ERC20.
contract PumpToken is ERC20 {
    uint256 public constant SUPPLY = 1_000_000_000 ether;
    /// @dev Uniswap V2 pair init code hash (official build).
    bytes32 public constant PAIR_INIT_HASH = 0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f;

    address public immutable pump;
    address public immutable pair;
    bool public graduated;

    error PairLocked();
    error OnlyPump();

    constructor(string memory name_, string memory symbol_, address factory, address weth) ERC20(name_, symbol_) {
        pump = msg.sender;
        (address t0, address t1) = address(this) < weth ? (address(this), weth) : (weth, address(this));
        pair = address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", factory, keccak256(abi.encodePacked(t0, t1)), PAIR_INIT_HASH)))));
        _mint(msg.sender, SUPPLY);
    }

    /// @notice Called once by 장터 펌프 right before it seeds the pair.
    function markGraduated() external {
        if (msg.sender != pump) revert OnlyPump();
        graduated = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == pair && !graduated) revert PairLocked();
        super._update(from, to, value);
    }
}
