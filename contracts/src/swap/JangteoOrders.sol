// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {JangteoAggregator} from "./JangteoAggregator.sol";

/// @title JangteoOrders — 장터 스왑 limit orders and DCA.
///
/// @notice A user escrows what they want to sell; Jangteo's keeper fills it through the aggregator
///         when the price allows (limit) or on schedule (DCA), and the output goes straight to the
///         user. The contract enforces every promise the user was made: the token pair, the size
///         of each fill, the schedule, and the minimum rate (`minRate` = least tokenOut per tokenIn,
///         scaled by 1e18, checked after the execution fee). Only allow-listed keepers execute, so a
///         DCA order without a price floor cannot be sandwiched by whoever runs it. Users cancel at
///         any time; anyone can return an expired limit order to its owner.
///
///         The owner never touches escrow. Adding a keeper or changing the fee/treasury only takes
///         effect DELAY after it is announced, so users can cancel before a new keeper (the one
///         power that could hurt a market-priced DCA order) can act. Removing a keeper is instant.
contract JangteoOrders is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 50;
    uint64 public constant DELAY = 2 days;

    JangteoAggregator public immutable aggregator;
    address public treasury;
    uint16 public feeBps;
    mapping(address => bool) public keeper;
    /// @notice When an announced keeper may be activated (0 = none pending).
    mapping(address => uint64) public keeperEta;
    struct PendingParams {
        address treasury;
        uint16 feeBps;
        uint64 eta;
    }
    PendingParams public pendingParams;

    struct Order {
        address owner;
        address tokenIn; // address(0) = ETH
        address tokenOut; // address(0) = ETH
        uint128 total;
        uint128 remaining;
        uint256 minRate;
        uint64 expiry; // limit orders; 0 for DCA
        uint32 slices; // DCA; 0 for a limit order
        uint32 done;
        uint32 interval;
        uint64 nextAt;
    }

    Order[] internal orders;

    event Created(
        uint256 indexed id, address indexed owner, address tokenIn, address tokenOut, uint256 total, uint256 minRate, uint32 slices, uint32 interval, uint64 expiry
    );
    event Executed(uint256 indexed id, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 remaining);
    event Closed(uint256 indexed id, uint256 refunded, uint8 reason); // 0 filled, 1 cancelled, 2 expired
    event ParamsSet(address treasury, uint16 feeBps);
    event KeeperSet(address keeper, bool on);
    event KeeperProposed(address keeper, uint64 eta);
    event ParamsProposed(address treasury, uint16 feeBps, uint64 eta);

    error BadParams();
    error NotOwner();
    error NotKeeper();
    error NotOpen();
    error NotDue();
    error BadRoute();
    error TransferFailed();
    error TooEarly();

    constructor(address owner_, JangteoAggregator aggregator_, address treasury_, uint16 feeBps_, address keeper_) Ownable(owner_) {
        aggregator = aggregator_;
        _set(treasury_, feeBps_);
        keeper[keeper_] = true;
        emit KeeperSet(keeper_, true);
    }

    receive() external payable {
        // ETH comes back from the aggregator only as output to users, never here.
        revert BadParams();
    }

    /// @notice Announce new fee/treasury; `applyParams` makes them live after DELAY.
    function proposeParams(address treasury_, uint16 feeBps_) external onlyOwner {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadParams();
        uint64 eta = uint64(block.timestamp) + DELAY;
        pendingParams = PendingParams(treasury_, feeBps_, eta);
        emit ParamsProposed(treasury_, feeBps_, eta);
    }

    function applyParams() external {
        PendingParams memory p = pendingParams;
        if (p.eta == 0 || block.timestamp < p.eta) revert TooEarly();
        delete pendingParams;
        _set(p.treasury, p.feeBps);
    }

    /// @notice Announce a keeper; anyone can activate it with `activateKeeper` after DELAY.
    function proposeKeeper(address k) external onlyOwner {
        if (k == address(0)) revert BadParams();
        uint64 eta = uint64(block.timestamp) + DELAY;
        keeperEta[k] = eta;
        emit KeeperProposed(k, eta);
    }

    function activateKeeper(address k) external {
        uint64 eta = keeperEta[k];
        if (eta == 0 || block.timestamp < eta) revert TooEarly();
        keeperEta[k] = 0;
        keeper[k] = true;
        emit KeeperSet(k, true);
    }

    /// @notice Removing a keeper (or a pending one) only takes power away, so it is immediate.
    function removeKeeper(address k) external onlyOwner {
        keeper[k] = false;
        keeperEta[k] = 0;
        emit KeeperSet(k, false);
    }

    function orderCount() external view returns (uint256) {
        return orders.length;
    }

    function order(uint256 id) external view returns (Order memory) {
        return orders[id];
    }

    // ---- users ----------------------------------------------------------------------------------

    /// @notice Sell `amount` of `tokenIn` for at least `minRate` (tokenOut per tokenIn × 1e18), until `expiry`.
    function createLimit(address tokenIn, address tokenOut, uint256 amount, uint256 minRate, uint64 expiry) external payable nonReentrant returns (uint256) {
        if (minRate == 0 || expiry <= block.timestamp) revert BadParams();
        return _create(tokenIn, tokenOut, amount, minRate, 0, 0, expiry);
    }

    /// @notice Sell `amount` of `tokenIn` in `slices` equal parts, one every `interval` seconds, the
    ///         first right away; `minRate` 0 buys at market, otherwise skips slices priced below it.
    function createDca(address tokenIn, address tokenOut, uint256 amount, uint32 slices, uint32 interval, uint256 minRate)
        external
        payable
        nonReentrant
        returns (uint256)
    {
        if (slices < 2 || slices > 365 || interval < 60) revert BadParams();
        return _create(tokenIn, tokenOut, amount, minRate, slices, interval, 0);
    }

    function cancel(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        if (msg.sender != o.owner) revert NotOwner();
        _close(id, o, 1);
    }

    /// @notice Anyone can hand an expired limit order back to its owner.
    function expire(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        if (o.slices != 0 || o.expiry == 0 || block.timestamp <= o.expiry) revert NotDue();
        _close(id, o, 2);
    }

    // ---- keepers --------------------------------------------------------------------------------

    /// @notice What the next fill of order `id` would sell, and the least it must bring back.
    function nextFill(uint256 id) public view returns (uint256 amountIn, uint256 fee, uint256 minOut, bool due) {
        Order storage o = orders[id];
        if (o.remaining == 0) return (0, 0, 0, false);
        amountIn = o.slices == 0 || o.done + 1 >= o.slices ? o.remaining : o.total / o.slices;
        fee = amountIn * feeBps / 10_000;
        minOut = (amountIn - fee) * o.minRate / 1e18;
        due = o.slices == 0 ? block.timestamp <= o.expiry : block.timestamp >= o.nextAt;
    }

    /// @notice Fill order `id` along `path`/`hops` (aggregator format); `minOut` may only tighten the
    ///         order's own minimum (the keeper's slippage guard for market-priced DCA slices).
    function execute(uint256 id, address[] calldata path, JangteoAggregator.Hop[] calldata hops, uint256 minOut) external nonReentrant returns (uint256 out) {
        if (!keeper[msg.sender]) revert NotKeeper();
        Order storage o = orders[id];
        (uint256 amountIn, uint256 fee, uint256 floor, bool due) = nextFill(id);
        if (amountIn == 0) revert NotOpen();
        if (!due) revert NotDue();
        if (path.length < 2 || path[0] != o.tokenIn || path[path.length - 1] != o.tokenOut) revert BadRoute();
        if (minOut < floor) minOut = floor;
        if (minOut == 0) minOut = 1;

        o.remaining -= uint128(amountIn);
        o.done += 1;
        if (o.slices != 0) o.nextAt += o.interval;

        uint256 net = amountIn - fee;
        // A V3 pool that runs out of range hands unspent input back to the caller (this contract):
        // measured here and passed on to the owner, so no order's funds mix with another's.
        IERC20 inTok = IERC20(o.tokenIn == address(0) ? aggregator.weth() : o.tokenIn);
        uint256 before = inTok.balanceOf(address(this));
        if (o.tokenIn == address(0)) {
            if (fee > 0) _sendEth(treasury, fee);
            out = aggregator.swap{value: net}(path, hops, net, minOut, o.owner, block.timestamp);
        } else {
            if (fee > 0) IERC20(o.tokenIn).safeTransfer(treasury, fee);
            before -= fee;
            IERC20(o.tokenIn).forceApprove(address(aggregator), net);
            out = aggregator.swap(path, hops, net, minOut, o.owner, block.timestamp);
            before -= net;
        }
        uint256 back = inTok.balanceOf(address(this)) - before;
        if (back > 0) inTok.safeTransfer(o.owner, back);
        emit Executed(id, amountIn, out, fee, o.remaining);
        if (o.remaining == 0) emit Closed(id, 0, 0);
    }

    // ---- internals ------------------------------------------------------------------------------

    function _create(address tokenIn, address tokenOut, uint256 amount, uint256 minRate, uint32 slices, uint32 interval, uint64 expiry)
        internal
        returns (uint256 id)
    {
        if (tokenIn == tokenOut || amount == 0 || amount > type(uint128).max) revert BadParams();
        if (tokenIn == address(0)) {
            if (msg.value != amount) revert BadParams();
        } else {
            if (msg.value != 0) revert BadParams();
            uint256 before = IERC20(tokenIn).balanceOf(address(this));
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amount);
            amount = IERC20(tokenIn).balanceOf(address(this)) - before; // what actually arrived
        }
        id = orders.length;
        orders.push(
            Order({
                owner: msg.sender,
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                total: uint128(amount),
                remaining: uint128(amount),
                minRate: minRate,
                expiry: expiry,
                slices: slices,
                done: 0,
                interval: interval,
                nextAt: uint64(block.timestamp)
            })
        );
        emit Created(id, msg.sender, tokenIn, tokenOut, amount, minRate, slices, interval, expiry);
    }

    function _close(uint256 id, Order storage o, uint8 reason) internal {
        uint256 amt = o.remaining;
        if (amt == 0) revert NotOpen();
        o.remaining = 0;
        if (o.tokenIn == address(0)) _sendEth(o.owner, amt);
        else IERC20(o.tokenIn).safeTransfer(o.owner, amt);
        emit Closed(id, amt, reason);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _set(address treasury_, uint16 feeBps_) internal {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadParams();
        treasury = treasury_;
        feeBps = feeBps_;
        emit ParamsSet(treasury_, feeBps_);
    }
}
