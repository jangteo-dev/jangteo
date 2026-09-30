// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IL1StandardBridge {
    function bridgeETHTo(address to, uint32 minGasLimit, bytes calldata extraData) external payable;
}

/// @title JangteoBridge — 장터 브릿지, ETH from Ethereum to GIWA in one step.
///
/// @notice A thin front door to GIWA's own L1StandardBridge. It keeps `feeBps` of each deposit
///         for Jangteo and hands the rest straight to the official bridge, in the same call, for
///         the recipient on GIWA. It never holds anyone's deposit: only the accrued fees, which
///         anyone can push to the treasury. The fee is capped at 1% by the contract.
contract JangteoBridge is Ownable2Step, ReentrancyGuard {
    uint16 public constant MAX_FEE_BPS = 100;
    uint32 public constant MIN_GAS_LIMIT = 200_000;

    IL1StandardBridge public immutable l1Bridge;
    address public treasury;
    uint16 public feeBps;
    uint256 public minDeposit;
    uint256 public feesAccrued;

    event Deposited(address indexed from, address indexed to, uint256 amount, uint256 fee);
    event FeesSwept(address indexed treasury, uint256 amount);
    event ParamsSet(address treasury, uint16 feeBps, uint256 minDeposit);

    error BadParams();
    error TooSmall();
    error NothingToSweep();
    error TransferFailed();

    constructor(address owner_, IL1StandardBridge l1Bridge_, address treasury_, uint16 feeBps_, uint256 minDeposit_) Ownable(owner_) {
        if (address(l1Bridge_) == address(0)) revert BadParams();
        l1Bridge = l1Bridge_;
        _set(treasury_, feeBps_, minDeposit_);
    }

    function setParams(address treasury_, uint16 feeBps_, uint256 minDeposit_) external onlyOwner {
        _set(treasury_, feeBps_, minDeposit_);
    }

    /// @notice Bridge `msg.value` less the fee to `to` on GIWA.
    function deposit(address to) public payable nonReentrant {
        if (to == address(0)) revert BadParams();
        if (msg.value < minDeposit || msg.value == 0) revert TooSmall();
        uint256 fee = msg.value * feeBps / 10_000;
        feesAccrued += fee;
        l1Bridge.bridgeETHTo{value: msg.value - fee}(to, MIN_GAS_LIMIT, "jangteo");
        emit Deposited(msg.sender, to, msg.value - fee, fee);
    }

    /// @notice Plain ETH sent here is bridged to the sender's own address on GIWA.
    receive() external payable {
        deposit(msg.sender);
    }

    /// @notice What `to` receives on GIWA for a deposit of `amount`.
    function quote(uint256 amount) external view returns (uint256 received, uint256 fee) {
        fee = amount * feeBps / 10_000;
        received = amount - fee;
    }

    function sweepFees() external nonReentrant {
        uint256 amt = feesAccrued;
        if (amt == 0) revert NothingToSweep();
        feesAccrued = 0;
        (bool ok,) = treasury.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit FeesSwept(treasury, amt);
    }

    function _set(address treasury_, uint16 feeBps_, uint256 minDeposit_) private {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadParams();
        treasury = treasury_;
        feeBps = feeBps_;
        minDeposit = minDeposit_;
        emit ParamsSet(treasury_, feeBps_, minDeposit_);
    }
}
