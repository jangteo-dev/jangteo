// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";
import {PumpToken} from "./PumpToken.sol";

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
}

interface IV2Factory {
    function createPair(address a, address b) external returns (address);
    function getPair(address a, address b) external view returns (address);
}

interface IV2Pair {
    function mint(address to) external returns (uint256);
}

/// @title JangteoPump — 장터 펌프, a bonding-curve launchpad that graduates into 장터 스왑.
///
/// @notice Anyone Dojang-verified can launch a token. Every token trades on its own constant-
///         product curve against ETH until the curve holds `threshold` ETH, then graduates:
///
///   Curve       x · y = k with x = virtualEth + real ETH and y = virtualTokens − tokens sold.
///               The virtual reserves are chosen so exactly `curveSupply` tokens are sold by the
///               time the curve holds `threshold` ETH.
///   Last buy    the buy that crosses the threshold is filled only up to it; the rest of its ETH
///               comes straight back. Nobody overpays for the graduation, nobody gets more than
///               the curve can give.
///   Graduation  1% of the ETH goes to Jangteo; the rest is paired with just enough tokens to
///               open the 장터 스왑 pool at exactly the curve's last price, so there is no jump to
///               arbitrage. Tokens left over are burned, and the LP tokens go to the dead
///               address: the liquidity can never be pulled.
///   Open        tokens are ordinary ERC20s from the first block and the curve takes calls from
///               anyone (`buyFor` for integrators); JangteoPumpRouter speaks Uniswap V2 so any
///               wallet or bot that trades V2 can buy before and after graduation.
///
///  Fees: 1% of every curve trade (half to the token's creator, half to Jangteo) and 1% of the
///  ETH at graduation (Jangteo). After graduation the pool pays the normal 장터 스왑 fee.
contract JangteoPump is Ownable2Step, ReentrancyGuard {
    struct Launch {
        address creator;
        address pair;
        uint64 createdAt;
        uint64 graduatedAt;
        bool graduated;
        uint128 realEth;
        uint128 sold;
        uint128 creatorFees;
        uint128 volume;
        uint32 trades;
    }

    uint256 public constant FEE_BPS = 100; // per curve trade
    uint256 public constant CREATOR_BPS = 50; // of which to the creator
    uint256 public constant GRADUATION_FEE_BPS = 100;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_META = 2048;
    uint256 private constant SUPPLY = 1_000_000_000 ether; // PumpToken.SUPPLY

    IWETH public immutable weth;
    IV2Factory public immutable factory;
    uint256 public immutable threshold;
    uint256 public immutable virtualEth;
    uint256 public immutable curveSupply;
    uint256 public immutable virtualTokens;
    uint256 public immutable maxCreatorBuy;

    IIdentityGate public gate;
    address public treasury;
    bool public creationPaused;
    uint256 public protocolFees;

    address[] public tokens;
    mapping(address => Launch) private _launch;
    mapping(address => string) public metadata;

    event Launched(address indexed token, address indexed creator, address pair, string name, string symbol, string metadata);
    event Trade(
        address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 realEth, uint256 sold
    );
    event Graduated(address indexed token, address pair, uint256 ethLiquidity, uint256 tokenLiquidity, uint256 burned, uint256 fee, uint256 lp);
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event ProtocolFeesWithdrawn(address indexed treasury, uint256 amount);

    error BadParams();
    error NotEligible();
    error Paused();
    error UnknownToken();
    error AlreadyGraduated();
    error Expired();
    error Slippage();
    error NothingToClaim();
    error TransferFailed();

    constructor(
        address owner_,
        IIdentityGate gate_,
        IWETH weth_,
        IV2Factory factory_,
        address treasury_,
        uint256 threshold_,
        uint256 virtualEth_,
        uint256 curveSupply_,
        uint256 maxCreatorBuy_
    ) Ownable(owner_) {
        if (
            treasury_ == address(0) || threshold_ == 0 || virtualEth_ == 0 || curveSupply_ == 0 || curveSupply_ >= SUPPLY
                || maxCreatorBuy_ >= threshold_
        ) revert BadParams();
        gate = gate_;
        weth = weth_;
        factory = factory_;
        treasury = treasury_;
        threshold = threshold_;
        virtualEth = virtualEth_;
        curveSupply = curveSupply_;
        // Selling exactly curveSupply takes the curve from virtualEth to virtualEth + threshold.
        virtualTokens = Math.mulDiv(curveSupply_, virtualEth_ + threshold_, threshold_);
        maxCreatorBuy = maxCreatorBuy_;
        // The pool must be seedable from what is left: tokens needed at graduation ≤ tokens left.
        uint256 left = virtualTokens - curveSupply_;
        uint256 needed = Math.mulDiv(threshold_ - threshold_ * GRADUATION_FEE_BPS / 10_000, left, virtualEth_ + threshold_);
        if (needed > SUPPLY - curveSupply_) revert BadParams();
    }

    // ───────────────────────────────── admin ─────────────────────────────────

    function setGate(IIdentityGate gate_) external onlyOwner {
        gate = gate_;
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert BadParams();
        treasury = treasury_;
    }

    /// @notice Stops new launches only; trading, graduation and claims never stop.
    function setCreationPaused(bool p) external onlyOwner {
        creationPaused = p;
    }

    function withdrawProtocolFees() external nonReentrant {
        uint256 amt = protocolFees;
        if (amt == 0) revert NothingToClaim();
        protocolFees = 0;
        _send(treasury, amt);
        emit ProtocolFeesWithdrawn(treasury, amt);
    }

    // ──────────────────────────────── launching ──────────────────────────────

    /// @notice Launch a token. ETH sent with the call is the creator's own first buy, at the
    ///         curve's opening price and capped at `maxCreatorBuy`, in the same transaction so
    ///         nobody can buy ahead of the creator.
    function create(string calldata name, string calldata symbol, string calldata meta) external payable nonReentrant returns (address token) {
        if (creationPaused) revert Paused();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        uint256 nl = bytes(name).length;
        uint256 sl = bytes(symbol).length;
        if (nl == 0 || nl > 32 || sl < 2 || sl > 10 || bytes(meta).length > MAX_META || msg.value > maxCreatorBuy) revert BadParams();

        PumpToken t = new PumpToken(name, symbol, address(factory), address(weth));
        token = address(t);
        // The token's address is predictable, so someone may have created its pair already; that
        // is harmless (nothing can put tokens in it before graduation), so just use it.
        address pair = factory.getPair(token, address(weth));
        if (pair == address(0)) pair = factory.createPair(token, address(weth));
        if (pair != t.pair()) revert BadParams();
        tokens.push(token);
        Launch storage l = _launch[token];
        l.creator = msg.sender;
        l.pair = pair;
        l.createdAt = uint64(block.timestamp);
        metadata[token] = meta;
        emit Launched(token, msg.sender, pair, name, symbol, meta);
        if (msg.value > 0) _buy(token, l, msg.sender, msg.sender, msg.value, 0);
    }

    // ───────────────────────────────── trading ───────────────────────────────

    function buy(address token, uint256 minOut, uint256 deadline) external payable nonReentrant returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        out = _buy(token, _live(token), msg.sender, msg.sender, msg.value, minOut);
    }

    /// @notice Buy for someone else. Tokens go to `to`; ETH over the graduation line comes back
    ///         to the caller (routers forward it).
    function buyFor(address token, address to, uint256 minOut, uint256 deadline) external payable nonReentrant returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        if (to == address(0)) revert BadParams();
        out = _buy(token, _live(token), msg.sender, to, msg.value, minOut);
    }

    function sell(address token, uint256 amountIn, uint256 minOut, uint256 deadline) external nonReentrant returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        Launch storage l = _live(token);
        uint256 gross;
        uint256 fee;
        (out, gross, fee) = _quoteSell(l, amountIn);
        if (out < minOut || out == 0) revert Slippage();
        PumpToken(token).transferFrom(msg.sender, address(this), amountIn);
        l.sold -= uint128(amountIn);
        l.realEth -= uint128(gross);
        l.volume += uint128(gross);
        l.trades += 1;
        _takeFee(l, fee);
        _send(msg.sender, out);
        emit Trade(token, msg.sender, false, gross, amountIn, fee, l.realEth, l.sold);
    }

    function claimCreatorFees(address token) external nonReentrant {
        Launch storage l = _launch[token];
        uint256 amt = l.creatorFees;
        if (amt == 0) revert NothingToClaim();
        l.creatorFees = 0;
        _send(l.creator, amt);
        emit CreatorFeesClaimed(token, l.creator, amt);
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function launch(address token) external view returns (Launch memory) {
        return _launch[token];
    }

    function isLaunch(address token) public view returns (bool) {
        return _launch[token].creator != address(0);
    }

    /// @return out tokens received, used ETH actually taken (≤ ethIn), refund returned
    function quoteBuy(address token, uint256 ethIn) external view returns (uint256 out, uint256 used, uint256 refund) {
        Launch storage l = _launch[token];
        if (l.creator == address(0) || l.graduated) return (0, 0, ethIn);
        (out, used,) = _quoteBuy(l, ethIn);
        refund = ethIn - used;
    }

    function quoteSell(address token, uint256 amountIn) external view returns (uint256 out) {
        Launch storage l = _launch[token];
        if (l.creator == address(0) || l.graduated || amountIn > l.sold) return 0;
        (out,,) = _quoteSell(l, amountIn);
    }

    /// @notice Spot price in ETH per token, 1e18 fixed point.
    function price(address token) public view returns (uint256) {
        Launch storage l = _launch[token];
        return Math.mulDiv(virtualEth + l.realEth, 1e18, virtualTokens - l.sold);
    }

    /// @notice How far the curve is to graduation, in basis points.
    function progressBps(address token) external view returns (uint256) {
        Launch storage l = _launch[token];
        return l.graduated ? 10_000 : l.realEth * 10_000 / threshold;
    }

    // ──────────────────────────────── internal ───────────────────────────────

    function _live(address token) private view returns (Launch storage l) {
        l = _launch[token];
        if (l.creator == address(0)) revert UnknownToken();
        if (l.graduated) revert AlreadyGraduated();
    }

    /// @return out tokens, gross ETH used (incl. fee), fee
    function _quoteBuy(Launch storage l, uint256 ethIn) private view returns (uint256 out, uint256 gross, uint256 fee) {
        uint256 net = ethIn - ethIn * FEE_BPS / 10_000;
        uint256 room = threshold - l.realEth;
        if (net >= room) {
            // Fill exactly to the line: gross such that gross − fee(gross) ≥ room, smallest such.
            net = room;
            gross = Math.mulDiv(room, 10_000, 10_000 - FEE_BPS, Math.Rounding.Ceil);
            if (gross > ethIn) gross = ethIn;
        } else {
            gross = ethIn;
        }
        fee = gross - net;
        uint256 x = virtualEth + l.realEth;
        uint256 y = virtualTokens - l.sold;
        // Round against the buyer so k never shrinks.
        out = y - Math.mulDiv(x, y, x + net, Math.Rounding.Ceil);
        uint256 left = curveSupply - l.sold;
        if (out > left) out = left;
    }

    /// @return out ETH to the seller, gross ETH leaving the curve, fee
    function _quoteSell(Launch storage l, uint256 amountIn) private view returns (uint256 out, uint256 gross, uint256 fee) {
        if (amountIn == 0 || amountIn > l.sold) revert BadParams();
        uint256 x = virtualEth + l.realEth;
        uint256 y = virtualTokens - l.sold;
        gross = x - Math.mulDiv(x, y, y + amountIn, Math.Rounding.Ceil);
        if (gross > l.realEth) gross = l.realEth;
        fee = gross * FEE_BPS / 10_000;
        out = gross - fee;
    }

    function _buy(address token, Launch storage l, address payer, address to, uint256 ethIn, uint256 minOut) private returns (uint256 out) {
        if (ethIn == 0) revert BadParams();
        uint256 gross;
        uint256 fee;
        (out, gross, fee) = _quoteBuy(l, ethIn);
        if (out < minOut || out == 0) revert Slippage();
        l.sold += uint128(out);
        l.realEth += uint128(gross - fee);
        l.volume += uint128(gross);
        l.trades += 1;
        _takeFee(l, fee);
        PumpToken(token).transfer(to, out);
        emit Trade(token, to, true, gross, out, fee, l.realEth, l.sold);
        if (l.realEth >= threshold) _graduate(token, l);
        if (ethIn > gross) _send(payer, ethIn - gross);
    }

    function _takeFee(Launch storage l, uint256 fee) private {
        uint256 creatorCut = fee * CREATOR_BPS / FEE_BPS;
        l.creatorFees += uint128(creatorCut);
        protocolFees += fee - creatorCut;
    }

    function _graduate(address token, Launch storage l) private {
        l.graduated = true;
        l.graduatedAt = uint64(block.timestamp);
        PumpToken t = PumpToken(token);
        t.markGraduated();

        uint256 eth = l.realEth;
        uint256 gFee = eth * GRADUATION_FEE_BPS / 10_000;
        protocolFees += gFee;
        uint256 liq = eth - gFee;
        // Open the pool at the curve's last price: tokens = liq / price = liq · y / x.
        uint256 x = virtualEth + eth;
        uint256 y = virtualTokens - l.sold;
        uint256 held = SUPPLY - l.sold;
        uint256 poolTokens = Math.mulDiv(liq, y, x);
        if (poolTokens > held) poolTokens = held;
        uint256 burned = held - poolTokens;
        l.realEth = 0;

        weth.deposit{value: liq}();
        if (!weth.transfer(l.pair, liq)) revert TransferFailed();
        t.transfer(l.pair, poolTokens);
        uint256 lp = IV2Pair(l.pair).mint(DEAD);
        if (burned > 0) t.transfer(DEAD, burned);
        emit Graduated(token, l.pair, liq, poolTokens, burned, gFee, lp);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
