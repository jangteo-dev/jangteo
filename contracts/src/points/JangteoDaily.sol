// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IIdentityGate} from "../interfaces/IGye.sol";

/// @title JangteoDaily — 장터 오늘의 룰렛, one spin a day for 장터 포인트.
///
/// @notice A verified person spins once per Korean day. The reward is fixed by the hash of the
///         block after the spin, which nobody knows when they spin and which cannot be re-rolled:
///         there is one spin a day and its block is recorded. Points themselves are counted
///         off-chain by the season engine from `Spun` events, so this contract holds no value.
contract JangteoDaily {
    uint256 internal constant KST = 9 hours;

    IIdentityGate public immutable gate;

    mapping(address => mapping(uint256 => uint256)) public spinBlock; // who → KST day → block
    mapping(address => uint256) public lastDay;
    mapping(address => uint256) public streak;

    event Spun(address indexed who, uint256 indexed day, uint256 blockNumber, uint256 streak);

    error NotVerified();
    error AlreadySpun();

    constructor(IIdentityGate gate_) {
        gate = gate_;
    }

    /// @notice Today's number in Korea (days since 1970-01-01 KST).
    function today() public view returns (uint256) {
        return (block.timestamp + KST) / 1 days;
    }

    function spin() external returns (uint256 day) {
        if (!gate.isEligible(msg.sender)) revert NotVerified();
        day = today();
        if (spinBlock[msg.sender][day] != 0) revert AlreadySpun();
        spinBlock[msg.sender][day] = block.number;
        uint256 s = lastDay[msg.sender] + 1 == day ? streak[msg.sender] + 1 : 1;
        streak[msg.sender] = s;
        lastDay[msg.sender] = day;
        emit Spun(msg.sender, day, block.number, s);
    }

    /// @notice The reward for a spin from the hash of the block after it (the season engine uses
    ///         the same formula with any block hash, so it works long after the 256-block window).
    function rewardFor(bytes32 nextBlockHash, address who, uint256 day) public pure returns (uint256) {
        uint256 roll = uint256(keccak256(abi.encode(nextBlockHash, who, day))) % 1000;
        if (roll < 400) return 10;
        if (roll < 650) return 20;
        if (roll < 800) return 30;
        if (roll < 900) return 50;
        if (roll < 960) return 100;
        if (roll < 990) return 200;
        return 500;
    }

    /// @notice The result of `who`'s spin on `day`, once the next block exists (for the web's reveal).
    function result(address who, uint256 day) external view returns (bool ready, uint256 reward) {
        uint256 b = spinBlock[who][day];
        if (b == 0 || block.number <= b + 1) return (false, 0);
        bytes32 h = blockhash(b + 1);
        if (h == bytes32(0)) return (false, 0);
        return (true, rewardFor(h, who, day));
    }
}
