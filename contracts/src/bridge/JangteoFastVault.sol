// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IL1Messenger {
    function xDomainMessageSender() external view returns (address);
}

/// @title JangteoFastVault — 장터 빠른 출금, on Ethereum.
///
/// @notice Pays out JangteoFastExit exits. `fill` lets anyone front an exit: the ETH goes straight
///         to the user and the filler is recorded against that exact (id, recipient, amount). When
///         GIWA's official withdrawal for the exit lands here (`settle`, only from GIWA's messenger
///         on behalf of the exit contract), the filler is repaid the full deposit, fee included;
///         if nobody filled, the user gets the full deposit. Payments that bounce are kept for
///         `withdraw`, so a settlement can never get stuck.
contract JangteoFastVault is Ownable2Step, ReentrancyGuard {
    IL1Messenger public immutable messenger;
    address public l2Exit;

    /// @dev keccak(id, to, amountOut) → who fronted it.
    mapping(bytes32 => address) public filler;
    mapping(uint256 => bool) public settled;
    mapping(address => uint256) public owed;

    event Filled(uint256 indexed id, address indexed to, uint256 amountOut, address indexed filler);
    event Settled(uint256 indexed id, address indexed paid, uint256 amount, bool filled);
    event L2ExitSet(address l2Exit);

    error BadParams();
    error AlreadyFilled();
    error AlreadySettled();
    error NotMessenger();
    error TransferFailed();

    constructor(address owner_, IL1Messenger messenger_) Ownable(owner_) {
        if (address(messenger_) == address(0)) revert BadParams();
        messenger = messenger_;
    }

    /// @notice Set once: the exit contract on GIWA whose messages this vault honours.
    function setL2Exit(address l2Exit_) external onlyOwner {
        if (l2Exit != address(0) || l2Exit_ == address(0)) revert BadParams();
        l2Exit = l2Exit_;
        emit L2ExitSet(l2Exit_);
    }

    function key(uint256 id, address to, uint256 amountOut) public pure returns (bytes32) {
        return keccak256(abi.encode(id, to, amountOut));
    }

    /// @notice Pay exit `id` now: `amountOut` goes to `to`, repaid to the caller on settlement.
    function fill(uint256 id, address to, uint256 amountOut) external payable nonReentrant {
        if (msg.value != amountOut || amountOut == 0 || to == address(0)) revert BadParams();
        if (settled[id]) revert AlreadySettled();
        bytes32 k = key(id, to, amountOut);
        if (filler[k] != address(0)) revert AlreadyFilled();
        filler[k] = msg.sender;
        (bool ok,) = to.call{value: amountOut}("");
        if (!ok) revert TransferFailed();
        emit Filled(id, to, amountOut, msg.sender);
    }

    /// @notice GIWA's official withdrawal for exit `id` arriving with the whole deposit.
    function settle(uint256 id, address to, uint256 amountOut) external payable nonReentrant {
        if (msg.sender != address(messenger) || messenger.xDomainMessageSender() != l2Exit || l2Exit == address(0)) revert NotMessenger();
        if (settled[id]) revert AlreadySettled();
        settled[id] = true;
        address f = filler[key(id, to, amountOut)];
        address payee = f == address(0) ? to : f;
        // Never revert here: a bounced payment is kept for the payee to withdraw.
        (bool ok,) = payee.call{value: msg.value, gas: 50_000}("");
        if (!ok) owed[payee] += msg.value;
        emit Settled(id, payee, msg.value, f != address(0));
    }

    function withdraw() external nonReentrant {
        uint256 amt = owed[msg.sender];
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }
}
