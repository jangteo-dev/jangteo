// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {GyeCircle} from "./GyeCircle.sol";
import {IGyeReputation, IIdentityGate} from "./interfaces/IGye.sol";

/// @title GyeFactory
/// @notice Deploys circles as minimal clones. The owner controls only the listing parameters
///         (tokens, minimum round length, pause) and never has access to circle funds.
contract GyeFactory is Ownable2Step {
    using SafeERC20 for IERC20;

    uint64 public constant MAX_FILL_WINDOW = 30 days;
    uint16 public constant MAX_FEE_BPS = 300;
    uint16 public constant MAX_DISCOUNT_BPS = 5_000;

    address public immutable implementation;
    IGyeReputation public immutable reputation;
    IIdentityGate public gate;

    uint32 public minRoundDuration;
    bool public paused;
    /// @notice Platform fee taken from every pot of circles created from now on (bps).
    uint16 public feeBps;
    address public treasury;

    /// @notice USD value (1e18 = $1) of one raw token unit, times 1e18. Zero = not listed.
    mapping(address => uint256) public usdPerUnitWad;
    address[] private _tokens;
    address[] private _circles;

    event CircleCreated(address indexed circle, address indexed creator, address indexed token, bytes32 name);
    event TokenListed(address indexed token, uint256 usdPerUnitWad);
    event GateSet(address gate);
    event MinRoundDurationSet(uint32 seconds_);
    event PausedSet(bool paused);
    event FeeSet(address treasury, uint16 feeBps);

    error Paused();
    error TokenNotListed();
    error BadConfig();

    constructor(address owner_, IGyeReputation reputation_, IIdentityGate gate_, uint32 minRoundDuration_)
        Ownable(owner_)
    {
        implementation = address(new GyeCircle());
        reputation = reputation_;
        gate = gate_;
        minRoundDuration = minRoundDuration_;
    }

    // ───────────────────────────────── admin ─────────────────────────────────

    function listToken(address token, uint256 usdPerUnitWad_) external onlyOwner {
        if (usdPerUnitWad[token] == 0 && usdPerUnitWad_ != 0) _tokens.push(token);
        usdPerUnitWad[token] = usdPerUnitWad_;
        emit TokenListed(token, usdPerUnitWad_);
    }

    /// @notice Applies to circles created afterwards; existing circles keep their gate.
    function setGate(IIdentityGate gate_) external onlyOwner {
        gate = gate_;
        emit GateSet(address(gate_));
    }

    function setMinRoundDuration(uint32 s) external onlyOwner {
        minRoundDuration = s;
        emit MinRoundDurationSet(s);
    }

    /// @notice Applies to circles created afterwards; a running circle keeps the fee it started with.
    function setFee(address treasury_, uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS || (feeBps_ != 0 && treasury_ == address(0))) revert BadConfig();
        treasury = treasury_;
        feeBps = feeBps_;
        emit FeeSet(treasury_, feeBps_);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    // ──────────────────────────────── create ─────────────────────────────────

    function createCircle(GyeCircle.Config calldata cfg, bool creatorJoins) external returns (GyeCircle circle) {
        if (paused) revert Paused();
        uint256 usd = usdPerUnitWad[address(cfg.token)];
        if (usd == 0) revert TokenNotListed();
        if (
            cfg.size < 2 || cfg.size > 50 || cfg.contribution == 0 || cfg.roundDuration < minRoundDuration
                || cfg.fillDeadline <= block.timestamp || cfg.fillDeadline > block.timestamp + MAX_FILL_WINDOW
                || cfg.maxDiscountBps > MAX_DISCOUNT_BPS
                || (cfg.mode != GyeCircle.Mode.Auction && cfg.maxDiscountBps != 0)
                || (cfg.mode == GyeCircle.Mode.Auction && cfg.maxDiscountBps == 0)
        ) revert BadConfig();

        circle = GyeCircle(Clones.clone(implementation));
        circle.initialize(cfg, msg.sender, reputation, gate, usd, feeBps, treasury);
        reputation.registerCircle(address(circle));
        _circles.push(address(circle));
        emit CircleCreated(address(circle), msg.sender, address(cfg.token), cfg.name);

        if (creatorJoins) {
            cfg.token.safeTransferFrom(msg.sender, address(circle), cfg.contribution);
            circle.joinFor(msg.sender);
        }
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function circleCount() external view returns (uint256) {
        return _circles.length;
    }

    function circles(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = _circles.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _circles[i];
        }
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }
}
