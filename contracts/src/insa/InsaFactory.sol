// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";
import {InsaDrop} from "./InsaDrop.sol";

/// @title InsaFactory — launches NFT collections on 인사동 Insadong.
///
/// @notice Anyone Dojang-verified can launch a collection: a real person stands behind every
///         drop, which is the one thing that keeps copy-paste scams off a mint page. Jangteo's
///         share of mint income is fixed per drop at launch (`platformBps`, at most 10%); a
///         change here only applies to drops launched afterwards.
contract InsaFactory is Ownable2Step {
    uint16 public constant MAX_PLATFORM_BPS = 1000;

    IIdentityGate public gate;
    address public treasury;
    uint16 public platformBps;
    bool public paused;
    address[] public drops;
    mapping(address => bool) public isDrop;

    event Created(address indexed drop, address indexed creator, string name, string symbol, uint32 maxSupply, uint16 platformBps);
    event ParamsSet(address gate, address treasury, uint16 platformBps, bool paused);

    error NotEligible();
    error BadParams();
    error Paused();

    constructor(address owner_, IIdentityGate gate_, address treasury_, uint16 platformBps_) Ownable(owner_) {
        _set(gate_, treasury_, platformBps_, false);
    }

    function create(InsaDrop.Config memory c, InsaDrop.Phase[] calldata phases) external returns (address drop) {
        if (paused) revert Paused();
        if (msg.sender != owner() && !gate.isEligible(msg.sender)) revert NotEligible();
        if (c.creator != msg.sender) revert BadParams();
        if (bytes(c.name).length == 0 || bytes(c.name).length > 64 || bytes(c.symbol).length == 0 || bytes(c.symbol).length > 16) revert BadParams();
        if (c.maxSupply > 100_000) revert BadParams();
        drop = address(new InsaDrop(c, phases, treasury, platformBps));
        drops.push(drop);
        isDrop[drop] = true;
        emit Created(drop, msg.sender, c.name, c.symbol, c.maxSupply, platformBps);
    }

    function dropCount() external view returns (uint256) {
        return drops.length;
    }

    function setParams(IIdentityGate gate_, address treasury_, uint16 platformBps_, bool paused_) external onlyOwner {
        _set(gate_, treasury_, platformBps_, paused_);
    }

    function _set(IIdentityGate gate_, address treasury_, uint16 platformBps_, bool paused_) internal {
        if (address(gate_) == address(0) || treasury_ == address(0) || platformBps_ > MAX_PLATFORM_BPS) revert BadParams();
        gate = gate_;
        treasury = treasury_;
        platformBps = platformBps_;
        paused = paused_;
        emit ParamsSet(address(gate_), treasury_, platformBps_, paused_);
    }
}
