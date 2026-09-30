// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IL2Messenger {
    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external payable;
}

interface IFastVault {
    function settle(uint256 id, address to, uint256 amountOut) external payable;
}

/// @title JangteoFastExit — 장터 빠른 출금, on GIWA.
///
/// @notice Leaves GIWA for Ethereum in minutes instead of seven days. The whole deposit goes into
///         GIWA's official withdrawal path, addressed to Jangteo's vault on Ethereum together with
///         what the user is owed. A filler (Jangteo) pays the user on Ethereum right away and is
///         repaid, fee included, when the official withdrawal lands a week later. If nobody fills,
///         the vault pays the user the whole deposit, fee included, when it lands: the user never
///         depends on the filler to get their ETH.
contract JangteoFastExit is Ownable2Step, ReentrancyGuard {
    uint16 public constant MAX_FEE_BPS = 300;
    uint32 public constant SETTLE_GAS = 250_000;

    IL2Messenger public immutable messenger;
    address public immutable vault;
    uint16 public feeBps;
    uint256 public flatFee;
    uint256 public minExit;
    uint256 public maxExit;
    uint256 public exits;

    event Exit(uint256 indexed id, address indexed from, address indexed to, uint256 amount, uint256 amountOut, uint256 fee);
    event ParamsSet(uint16 feeBps, uint256 flatFee, uint256 minExit, uint256 maxExit);

    error BadParams();
    error OutOfRange();

    constructor(address owner_, IL2Messenger messenger_, address vault_, uint16 feeBps_, uint256 flatFee_, uint256 min_, uint256 max_) Ownable(owner_) {
        if (address(messenger_) == address(0) || vault_ == address(0)) revert BadParams();
        messenger = messenger_;
        vault = vault_;
        _set(feeBps_, flatFee_, min_, max_);
    }

    function setParams(uint16 feeBps_, uint256 flatFee_, uint256 min_, uint256 max_) external onlyOwner {
        _set(feeBps_, flatFee_, min_, max_);
    }

    /// @notice What `to` receives on Ethereum, fast, for an exit of `amount`.
    function quote(uint256 amount) public view returns (uint256 amountOut, uint256 fee) {
        fee = amount * feeBps / 10_000 + flatFee;
        amountOut = amount > fee ? amount - fee : 0;
    }

    /// @notice Exit `msg.value` to `to` on Ethereum.
    function exit(address to) external payable nonReentrant returns (uint256 id) {
        if (to == address(0)) revert BadParams();
        if (msg.value < minExit || msg.value > maxExit) revert OutOfRange();
        (uint256 amountOut, uint256 fee) = quote(msg.value);
        if (amountOut == 0) revert OutOfRange();
        id = ++exits;
        messenger.sendMessage{value: msg.value}(vault, abi.encodeCall(IFastVault.settle, (id, to, amountOut)), SETTLE_GAS);
        emit Exit(id, msg.sender, to, msg.value, amountOut, fee);
    }

    function _set(uint16 feeBps_, uint256 flatFee_, uint256 min_, uint256 max_) private {
        if (feeBps_ > MAX_FEE_BPS || min_ == 0 || max_ < min_ || flatFee_ >= min_) revert BadParams();
        feeBps = feeBps_;
        flatFee = flatFee_;
        minExit = min_;
        maxExit = max_;
        emit ParamsSet(feeBps_, flatFee_, min_, max_);
    }
}
