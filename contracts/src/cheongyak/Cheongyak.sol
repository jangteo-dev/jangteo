// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";

/// @title Cheongyak — 청약, token offerings allocated the way Korean IPOs are.
///
/// @notice An issuer escrows `totalTokens` at a fixed `price` (quote per whole token). Verified
///         people subscribe by depositing quote. After the window closes:
///
///   균등 (equal): `equalBps` of the tokens are split evenly between everyone who subscribed:
///                 each gets E = equalTokens / N, or less if their deposit buys less.
///   비례 (proportional): all remaining tokens go out pro rata to each subscriber's remaining
///                 demand, capped at that demand.
///
///  Everyone pays only for what they were allocated; the rest of their deposit comes back. The
///  issuer receives exactly what subscribers paid, minus the platform fee; unsold tokens return.
///
///  One Dojang identity counts once, which is what makes the equal half fair. Settlement runs in
///  batches (two passes over subscribers) so an offering with thousands of subscribers still fits
///  in blocks; anyone may push the batches.
contract Cheongyak is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Scheduled,
        Settling,
        Settled,
        Cancelled
    }

    struct Offering {
        address issuer;
        IERC20 token;
        bytes32 name;
        uint128 totalTokens;
        uint128 price; // quote units per 1e18 token units
        uint64 startAt;
        uint64 endAt;
        uint16 equalBps;
        uint16 feeBps;
        uint128 minDeposit;
        uint128 maxDeposit;
        Status status;
        uint32 subscribers;
        uint128 totalDeposit;
        // settlement
        uint8 pass; // 1 = summing, 2 = allocating
        uint32 cursor;
        uint128 equalEach;
        uint128 sumEqual;
        uint256 sumRemainder;
        uint256 ratioWad;
        uint128 allocated;
        uint128 raised;
        bool issuerPaid;
    }

    struct Allocation {
        uint128 deposit;
        uint128 tokens;
        uint128 cost;
        bool claimed;
    }

    uint16 public constant MAX_FEE_BPS = 500;
    uint64 public constant MAX_WINDOW = 30 days;

    IERC20 public immutable quote;
    IIdentityGate public gate;
    address public treasury;
    uint16 public feeBps;
    uint256 public feesAccrued;

    Offering[] private _offerings;
    mapping(uint256 => address[]) private _subs;
    mapping(uint256 => mapping(address => Allocation)) private _alloc;

    event Created(uint256 indexed id, address indexed issuer, address indexed token, bytes32 name, uint256 totalTokens, uint256 price);
    event Subscribed(uint256 indexed id, address indexed who, uint256 amount, uint256 total);
    event SettlementProgress(uint256 indexed id, uint8 pass, uint32 cursor);
    event Settled(uint256 indexed id, uint256 allocated, uint256 raised, uint256 fee, uint256 equalEach, uint256 ratioWad);
    event Claimed(uint256 indexed id, address indexed who, uint256 tokens, uint256 refund);
    event IssuerPaid(uint256 indexed id, uint256 proceeds, uint256 unsold);
    event Cancelled(uint256 indexed id);
    event FeesSwept(address indexed treasury, uint256 amount);

    error BadParams();
    error NotEligible();
    error NotOpen();
    error NotEnded();
    error WrongStatus();
    error BelowMinimum();
    error OverMaximum();
    error NotIssuer();
    error NothingToClaim();

    constructor(address owner_, IERC20 quote_, IIdentityGate gate_, address treasury_, uint16 feeBps_) Ownable(owner_) {
        quote = quote_;
        gate = gate_;
        _setFee(treasury_, feeBps_);
    }

    // ───────────────────────────────── admin ─────────────────────────────────

    function setFee(address treasury_, uint16 feeBps_) external onlyOwner {
        _setFee(treasury_, feeBps_);
    }

    function setGate(IIdentityGate gate_) external onlyOwner {
        gate = gate_;
    }

    function sweepFees() external nonReentrant {
        uint256 amt = feesAccrued;
        if (amt == 0) revert NothingToClaim();
        feesAccrued = 0;
        quote.safeTransfer(treasury, amt);
        emit FeesSwept(treasury, amt);
    }

    // ──────────────────────────────── issuer ────────────────────────────────

    function create(
        IERC20 token,
        bytes32 name,
        uint128 totalTokens,
        uint128 price,
        uint64 startAt,
        uint64 endAt,
        uint16 equalBps,
        uint128 minDeposit,
        uint128 maxDeposit
    ) external nonReentrant returns (uint256 id) {
        if (
            address(token) == address(0) || totalTokens == 0 || price == 0 || startAt < block.timestamp || endAt <= startAt
                || endAt - startAt > MAX_WINDOW || equalBps > 10_000 || minDeposit == 0 || maxDeposit < minDeposit
        ) revert BadParams();
        id = _offerings.length;
        Offering storage o = _offerings.push();
        o.issuer = msg.sender;
        o.token = token;
        o.name = name;
        o.totalTokens = totalTokens;
        o.price = price;
        o.startAt = startAt;
        o.endAt = endAt;
        o.equalBps = equalBps;
        o.feeBps = feeBps;
        o.minDeposit = minDeposit;
        o.maxDeposit = maxDeposit;
        o.status = Status.Scheduled;
        token.safeTransferFrom(msg.sender, address(this), totalTokens);
        emit Created(id, msg.sender, address(token), name, totalTokens, price);
    }

    /// @notice The issuer may withdraw an offering before it opens.
    function cancel(uint256 id) external nonReentrant {
        Offering storage o = _offerings[id];
        if (msg.sender != o.issuer) revert NotIssuer();
        if (o.status != Status.Scheduled || block.timestamp >= o.startAt) revert WrongStatus();
        o.status = Status.Cancelled;
        o.token.safeTransfer(o.issuer, o.totalTokens);
        emit Cancelled(id);
    }

    // ────────────────────────────── subscribing ─────────────────────────────

    function subscribe(uint256 id, uint128 amount) external nonReentrant {
        Offering storage o = _offerings[id];
        if (o.status != Status.Scheduled || block.timestamp < o.startAt || block.timestamp >= o.endAt) revert NotOpen();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        Allocation storage a = _alloc[id][msg.sender];
        uint128 total = a.deposit + amount;
        if (total < o.minDeposit) revert BelowMinimum();
        if (total > o.maxDeposit) revert OverMaximum();
        if (a.deposit == 0) {
            _subs[id].push(msg.sender);
            o.subscribers += 1;
        }
        a.deposit = total;
        o.totalDeposit += amount;
        quote.safeTransferFrom(msg.sender, address(this), amount);
        emit Subscribed(id, msg.sender, amount, total);
    }

    // ────────────────────────────── settlement ──────────────────────────────

    /// @notice Push settlement forward by up to `batch` subscribers. Anyone may call.
    function settle(uint256 id, uint32 batch) external nonReentrant {
        Offering storage o = _offerings[id];
        if (block.timestamp < o.endAt) revert NotEnded();
        if (o.status == Status.Scheduled) {
            if (o.subscribers == 0) {
                // Nobody came: everything goes back to the issuer.
                o.status = Status.Settled;
                o.issuerPaid = true;
                o.token.safeTransfer(o.issuer, o.totalTokens);
                emit Settled(id, 0, 0, 0, 0, 0);
                return;
            }
            o.status = Status.Settling;
            o.pass = 1;
            o.equalEach = uint128((uint256(o.totalTokens) * o.equalBps / 10_000) / o.subscribers);
        }
        if (o.status != Status.Settling) revert WrongStatus();

        address[] storage subs = _subs[id];
        uint32 n = uint32(subs.length);
        uint32 end = o.cursor + batch > n ? n : o.cursor + batch;
        for (uint32 i = o.cursor; i < end; ++i) {
            Allocation storage a = _alloc[id][subs[i]];
            uint256 want = uint256(a.deposit) * 1e18 / o.price;
            uint256 eq = want < o.equalEach ? want : o.equalEach;
            if (o.pass == 1) {
                o.sumEqual += uint128(eq);
                o.sumRemainder += want - eq;
            } else {
                uint256 prop = (want - eq) * o.ratioWad / 1e18;
                uint256 tokens = eq + prop;
                uint256 cost = tokens * o.price / 1e18;
                a.tokens = uint128(tokens);
                a.cost = uint128(cost);
                o.allocated += uint128(tokens);
                o.raised += uint128(cost);
            }
        }
        o.cursor = end;
        emit SettlementProgress(id, o.pass, end);
        if (end < n) return;

        if (o.pass == 1) {
            uint256 left = uint256(o.totalTokens) - o.sumEqual;
            o.ratioWad = o.sumRemainder <= left ? 1e18 : left * 1e18 / o.sumRemainder;
            o.pass = 2;
            o.cursor = 0;
            return;
        }
        o.status = Status.Settled;
        uint256 fee = uint256(o.raised) * o.feeBps / 10_000;
        feesAccrued += fee;
        emit Settled(id, o.allocated, o.raised, fee, o.equalEach, o.ratioWad);
    }

    function claim(uint256 id) external nonReentrant {
        Offering storage o = _offerings[id];
        if (o.status != Status.Settled) revert WrongStatus();
        Allocation storage a = _alloc[id][msg.sender];
        if (a.deposit == 0 || a.claimed) revert NothingToClaim();
        a.claimed = true;
        uint256 refund = uint256(a.deposit) - a.cost;
        if (a.tokens != 0) o.token.safeTransfer(msg.sender, a.tokens);
        if (refund != 0) quote.safeTransfer(msg.sender, refund);
        emit Claimed(id, msg.sender, a.tokens, refund);
    }

    /// @notice Pays the issuer its proceeds (minus fee) and returns unsold tokens. Anyone may call.
    function payIssuer(uint256 id) external nonReentrant {
        Offering storage o = _offerings[id];
        if (o.status != Status.Settled || o.issuerPaid) revert WrongStatus();
        o.issuerPaid = true;
        uint256 fee = uint256(o.raised) * o.feeBps / 10_000;
        uint256 proceeds = uint256(o.raised) - fee;
        uint256 unsold = uint256(o.totalTokens) - o.allocated;
        if (proceeds != 0) quote.safeTransfer(o.issuer, proceeds);
        if (unsold != 0) o.token.safeTransfer(o.issuer, unsold);
        emit IssuerPaid(id, proceeds, unsold);
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function offeringCount() external view returns (uint256) {
        return _offerings.length;
    }

    function offering(uint256 id) external view returns (Offering memory) {
        return _offerings[id];
    }

    function allocationOf(uint256 id, address who) external view returns (Allocation memory) {
        return _alloc[id][who];
    }

    function subscribersOf(uint256 id, uint256 offset, uint256 limit) external view returns (address[] memory page) {
        address[] storage s = _subs[id];
        if (offset >= s.length) return new address[](0);
        uint256 end = offset + limit > s.length ? s.length : offset + limit;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = s[i];
        }
    }

    // ──────────────────────────────── internal ───────────────────────────────

    function _setFee(address treasury_, uint16 feeBps_) private {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadParams();
        treasury = treasury_;
        feeBps = feeBps_;
    }
}
