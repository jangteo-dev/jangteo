// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";

interface IUniswapV2Router02 {
    function factory() external view returns (address);

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

/// @title CheongyakV2 — 청약 token offerings, the Korean IPO way, with the rest of a launchpad.
///
/// @notice Allocation is unchanged from v1: `equalBps` of the tokens is split evenly between
///         subscribers (capped by each one's demand), the rest pro rata to remaining demand, and
///         everyone pays only for what they get. v2 adds:
///
///   Soft cap   if deposits end below `softCap`, the offering fails: every deposit comes back in
///              full and the issuer gets all tokens back.
///   Vesting    `tgeBps` unlocks at settlement, the rest unlocks linearly over `vesting` seconds
///              after a `cliff`. Refunds are paid at once.
///   Liquidity  `liqBps` of the proceeds is paired with tokens at the offer price and added to
///              a Uniswap V2 pool. If the pool was pushed off that price, the add is skipped (2%
///              slippage bound) and the quote goes to the issuer instead, so settlement never
///              stalls. LP tokens stay locked here for `lpLock` seconds, then go to the issuer.
///   Profile    a JSON profile (description, links, logo) stored on-chain and editable by the
///              issuer until the window closes; a `verified` badge set by the curator.
///   Quote      each offering chooses its payment token from the curator's allowlist.
contract CheongyakV2 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Scheduled,
        Settling,
        Settled,
        Failed,
        Cancelled
    }

    struct Terms {
        IERC20 token;
        IERC20 quote;
        bytes32 name;
        uint128 totalTokens;
        uint128 price; // quote units per 1e18 token units
        uint64 startAt;
        uint64 endAt;
        uint16 equalBps;
        uint128 minDeposit;
        uint128 maxDeposit;
        uint128 softCap; // quote units; 0 = none
        uint16 tgeBps;
        uint32 cliff;
        uint32 vesting;
        uint16 liqBps; // share of proceeds paired into the pool
        uint32 lpLock;
    }

    struct Offering {
        Terms t;
        address issuer;
        uint16 feeBps;
        Status status;
        bool verified;
        uint32 subscribers;
        uint128 totalDeposit;
        uint128 liqEscrow; // extra tokens the issuer put up for liquidity
        // settlement
        uint8 pass;
        uint32 cursor;
        uint128 equalEach;
        uint128 sumEqual;
        uint256 sumRemainder;
        uint256 ratioWad;
        uint128 allocated;
        uint128 raised;
        uint64 settledAt;
        bool issuerPaid;
        // liquidity
        address pair;
        uint256 lpAmount;
        uint128 liqQuote;
        uint128 liqTokens;
        bool lpWithdrawn;
    }

    struct Allocation {
        uint128 deposit;
        uint128 tokens;
        uint128 cost;
        uint128 released;
        bool refunded;
    }

    uint16 public constant MAX_FEE_BPS = 500;
    uint16 public constant MAX_LIQ_BPS = 5_000;
    uint64 public constant MAX_WINDOW = 30 days;
    uint32 public constant MIN_LP_LOCK = 30 days;
    uint32 public constant MAX_VESTING = 730 days;
    uint32 public constant MAX_CLIFF = 365 days;
    uint16 public constant SLIPPAGE_BPS = 200;
    uint256 public constant MAX_METADATA = 4096;

    IIdentityGate public gate;
    IUniswapV2Router02 public router;
    address public treasury;
    uint16 public feeBps;

    mapping(address => bool) public quoteAllowed;
    mapping(address => uint256) public feesAccrued; // by quote token

    Offering[] private _offerings;
    mapping(uint256 => string) public metadata;
    mapping(uint256 => address[]) private _subs;
    mapping(uint256 => mapping(address => Allocation)) private _alloc;

    event Created(uint256 indexed id, address indexed issuer, address indexed token, address quote, bytes32 name);
    event MetadataSet(uint256 indexed id, string metadata);
    event VerifiedSet(uint256 indexed id, bool verified);
    event Subscribed(uint256 indexed id, address indexed who, uint256 amount, uint256 total);
    event SettlementProgress(uint256 indexed id, uint8 pass, uint32 cursor);
    event Settled(uint256 indexed id, uint256 allocated, uint256 raised, uint256 fee);
    event Failed(uint256 indexed id, uint256 totalDeposit, uint256 softCap);
    event LiquidityAdded(uint256 indexed id, address pair, uint256 tokens, uint256 quote, uint256 lp);
    event LiquiditySkipped(uint256 indexed id);
    event Claimed(uint256 indexed id, address indexed who, uint256 tokens, uint256 refund);
    event IssuerPaid(uint256 indexed id, uint256 proceeds, uint256 unsoldTokens);
    event LpWithdrawn(uint256 indexed id, uint256 lp);
    event Cancelled(uint256 indexed id);
    event FeesSwept(address indexed quote, address indexed treasury, uint256 amount);

    error BadParams();
    error NotEligible();
    error NotOpen();
    error NotEnded();
    error WrongStatus();
    error BelowMinimum();
    error OverMaximum();
    error NotIssuer();
    error NothingToClaim();
    error Locked();

    constructor(address owner_, IIdentityGate gate_, IUniswapV2Router02 router_, address treasury_, uint16 feeBps_) Ownable(owner_) {
        gate = gate_;
        router = router_;
        _setFee(treasury_, feeBps_);
    }

    // ───────────────────────────────── admin ─────────────────────────────────

    function setFee(address treasury_, uint16 feeBps_) external onlyOwner {
        _setFee(treasury_, feeBps_);
    }

    function setGate(IIdentityGate gate_) external onlyOwner {
        gate = gate_;
    }

    function setRouter(IUniswapV2Router02 router_) external onlyOwner {
        router = router_;
    }

    function setQuote(address quote, bool allowed) external onlyOwner {
        quoteAllowed[quote] = allowed;
    }

    /// @notice Curator badge. It carries no power over funds; it only marks vetted issuers.
    function setVerified(uint256 id, bool v) external onlyOwner {
        _offerings[id].verified = v;
        emit VerifiedSet(id, v);
    }

    function sweepFees(address quote) external nonReentrant {
        uint256 amt = feesAccrued[quote];
        if (amt == 0) revert NothingToClaim();
        feesAccrued[quote] = 0;
        IERC20(quote).safeTransfer(treasury, amt);
        emit FeesSwept(quote, treasury, amt);
    }

    // ──────────────────────────────── issuer ────────────────────────────────

    function create(Terms calldata t, string calldata meta) external nonReentrant returns (uint256 id) {
        uint256 hardCap = uint256(t.totalTokens) * t.price / 1e18;
        if (
            address(t.token) == address(0) || address(t.token) == address(t.quote) || !quoteAllowed[address(t.quote)]
                || t.totalTokens == 0 || t.price == 0 || t.startAt < block.timestamp || t.endAt <= t.startAt
                || t.endAt - t.startAt > MAX_WINDOW || t.equalBps > 10_000 || t.minDeposit == 0 || t.maxDeposit < t.minDeposit
                || t.softCap > hardCap || t.tgeBps > 10_000 || t.cliff > MAX_CLIFF || t.vesting > MAX_VESTING
                || t.liqBps > MAX_LIQ_BPS || (t.liqBps != 0 && (t.lpLock < MIN_LP_LOCK || address(router) == address(0)))
                || bytes(meta).length > MAX_METADATA
        ) revert BadParams();

        id = _offerings.length;
        Offering storage o = _offerings.push();
        o.t = t;
        o.issuer = msg.sender;
        o.feeBps = feeBps;
        o.status = Status.Scheduled;
        // Enough tokens to pair with the liquidity share of a sell-out at the offer price.
        o.liqEscrow = uint128(uint256(t.totalTokens) * t.liqBps / 10_000);
        metadata[id] = meta;
        t.token.safeTransferFrom(msg.sender, address(this), uint256(t.totalTokens) + o.liqEscrow);
        emit Created(id, msg.sender, address(t.token), address(t.quote), t.name);
        if (bytes(meta).length != 0) emit MetadataSet(id, meta);
    }

    function setMetadata(uint256 id, string calldata meta) external {
        Offering storage o = _offerings[id];
        if (msg.sender != o.issuer) revert NotIssuer();
        if (o.status != Status.Scheduled || block.timestamp >= o.t.endAt) revert WrongStatus();
        if (bytes(meta).length > MAX_METADATA) revert BadParams();
        metadata[id] = meta;
        emit MetadataSet(id, meta);
    }

    function cancel(uint256 id) external nonReentrant {
        Offering storage o = _offerings[id];
        if (msg.sender != o.issuer) revert NotIssuer();
        if (o.status != Status.Scheduled || block.timestamp >= o.t.startAt) revert WrongStatus();
        o.status = Status.Cancelled;
        o.t.token.safeTransfer(o.issuer, uint256(o.t.totalTokens) + o.liqEscrow);
        emit Cancelled(id);
    }

    // ────────────────────────────── subscribing ─────────────────────────────

    function subscribe(uint256 id, uint128 amount) external nonReentrant {
        Offering storage o = _offerings[id];
        if (o.status != Status.Scheduled || block.timestamp < o.t.startAt || block.timestamp >= o.t.endAt) revert NotOpen();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        Allocation storage a = _alloc[id][msg.sender];
        uint128 total = a.deposit + amount;
        if (total < o.t.minDeposit) revert BelowMinimum();
        if (total > o.t.maxDeposit) revert OverMaximum();
        if (a.deposit == 0) {
            _subs[id].push(msg.sender);
            o.subscribers += 1;
        }
        a.deposit = total;
        o.totalDeposit += amount;
        o.t.quote.safeTransferFrom(msg.sender, address(this), amount);
        emit Subscribed(id, msg.sender, amount, total);
    }

    // ────────────────────────────── settlement ──────────────────────────────

    /// @notice Push settlement forward by up to `batch` subscribers. Anyone may call.
    function settle(uint256 id, uint32 batch) external nonReentrant {
        Offering storage o = _offerings[id];
        if (block.timestamp < o.t.endAt) revert NotEnded();
        if (o.status == Status.Scheduled) {
            if (o.subscribers == 0 || o.totalDeposit < o.t.softCap) {
                o.status = Status.Failed;
                o.issuerPaid = true;
                o.t.token.safeTransfer(o.issuer, uint256(o.t.totalTokens) + o.liqEscrow);
                emit Failed(id, o.totalDeposit, o.t.softCap);
                return;
            }
            o.status = Status.Settling;
            o.pass = 1;
            o.equalEach = uint128((uint256(o.t.totalTokens) * o.t.equalBps / 10_000) / o.subscribers);
        }
        if (o.status != Status.Settling) revert WrongStatus();

        address[] storage subs = _subs[id];
        uint32 n = uint32(subs.length);
        uint32 end = o.cursor + batch > n ? n : o.cursor + batch;
        uint256 price = o.t.price;
        for (uint32 i = o.cursor; i < end; ++i) {
            Allocation storage a = _alloc[id][subs[i]];
            uint256 want = uint256(a.deposit) * 1e18 / price;
            uint256 eq = want < o.equalEach ? want : o.equalEach;
            if (o.pass == 1) {
                o.sumEqual += uint128(eq);
                o.sumRemainder += want - eq;
            } else {
                uint256 tokens = eq + (want - eq) * o.ratioWad / 1e18;
                uint256 cost = tokens * price / 1e18;
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
            uint256 left = uint256(o.t.totalTokens) - o.sumEqual;
            o.ratioWad = o.sumRemainder <= left ? 1e18 : left * 1e18 / o.sumRemainder;
            o.pass = 2;
            o.cursor = 0;
            return;
        }

        o.status = Status.Settled;
        o.settledAt = uint64(block.timestamp);
        uint256 fee = uint256(o.raised) * o.feeBps / 10_000;
        feesAccrued[address(o.t.quote)] += fee;
        emit Settled(id, o.allocated, o.raised, fee);
        if (o.t.liqBps != 0 && o.raised != 0) _addLiquidity(id, o);
    }

    function claim(uint256 id) external nonReentrant {
        Offering storage o = _offerings[id];
        Allocation storage a = _alloc[id][msg.sender];
        (uint256 tokens, uint256 refund) = _claimable(o, a);
        if (tokens == 0 && refund == 0) revert NothingToClaim();
        if (refund != 0) a.refunded = true;
        if (tokens != 0) a.released += uint128(tokens);
        if (tokens != 0) o.t.token.safeTransfer(msg.sender, tokens);
        if (refund != 0) o.t.quote.safeTransfer(msg.sender, refund);
        emit Claimed(id, msg.sender, tokens, refund);
    }

    /// @notice Pays the issuer its proceeds (less fee and the liquidity share) and returns unsold
    ///         and unused liquidity tokens. Anyone may call.
    function payIssuer(uint256 id) external nonReentrant {
        Offering storage o = _offerings[id];
        if (o.status != Status.Settled || o.issuerPaid) revert WrongStatus();
        o.issuerPaid = true;
        uint256 fee = uint256(o.raised) * o.feeBps / 10_000;
        uint256 proceeds = uint256(o.raised) - fee - o.liqQuote;
        uint256 unsold = uint256(o.t.totalTokens) - o.allocated + o.liqEscrow - o.liqTokens;
        if (proceeds != 0) o.t.quote.safeTransfer(o.issuer, proceeds);
        if (unsold != 0) o.t.token.safeTransfer(o.issuer, unsold);
        emit IssuerPaid(id, proceeds, unsold);
    }

    function withdrawLp(uint256 id) external nonReentrant {
        Offering storage o = _offerings[id];
        if (msg.sender != o.issuer) revert NotIssuer();
        if (o.lpAmount == 0 || o.lpWithdrawn) revert NothingToClaim();
        if (block.timestamp < uint256(o.settledAt) + o.t.lpLock) revert Locked();
        o.lpWithdrawn = true;
        IERC20(o.pair).safeTransfer(o.issuer, o.lpAmount);
        emit LpWithdrawn(id, o.lpAmount);
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

    /// @return tokens unlocked and not yet released, refund still owed
    function claimable(uint256 id, address who) external view returns (uint256 tokens, uint256 refund) {
        return _claimable(_offerings[id], _alloc[id][who]);
    }

    /// @notice Tokens of an allocation of `total` unlocked at time `t`.
    function vestedAt(uint256 id, uint256 total, uint256 t) public view returns (uint256) {
        Offering storage o = _offerings[id];
        return _vested(o, total, t);
    }

    // ──────────────────────────────── internal ───────────────────────────────

    function _claimable(Offering storage o, Allocation storage a) private view returns (uint256 tokens, uint256 refund) {
        if (a.deposit == 0) return (0, 0);
        if (o.status == Status.Failed) return (0, a.refunded ? 0 : a.deposit);
        if (o.status != Status.Settled) return (0, 0);
        refund = a.refunded ? 0 : uint256(a.deposit) - a.cost;
        tokens = _vested(o, a.tokens, block.timestamp) - a.released;
    }

    function _vested(Offering storage o, uint256 total, uint256 t) private view returns (uint256) {
        if (o.status != Status.Settled || t < o.settledAt) return 0;
        uint256 tge = total * o.t.tgeBps / 10_000;
        uint256 cliffEnd = uint256(o.settledAt) + o.t.cliff;
        if (t < cliffEnd) return tge;
        if (o.t.vesting == 0) return total;
        uint256 elapsed = t - cliffEnd;
        if (elapsed >= o.t.vesting) return total;
        return tge + (total - tge) * elapsed / o.t.vesting;
    }

    function _addLiquidity(uint256 id, Offering storage o) private {
        uint256 quoteAmt = uint256(o.raised) * o.t.liqBps / 10_000;
        uint256 tokenAmt = quoteAmt * 1e18 / o.t.price;
        if (tokenAmt > o.liqEscrow) tokenAmt = o.liqEscrow;
        if (quoteAmt == 0 || tokenAmt == 0) return;
        IERC20 token = o.t.token;
        IERC20 quote = o.t.quote;
        token.forceApprove(address(router), tokenAmt);
        quote.forceApprove(address(router), quoteAmt);
        try router.addLiquidity(
            address(token),
            address(quote),
            tokenAmt,
            quoteAmt,
            tokenAmt * (10_000 - SLIPPAGE_BPS) / 10_000,
            quoteAmt * (10_000 - SLIPPAGE_BPS) / 10_000,
            address(this),
            block.timestamp
        ) returns (uint256 usedToken, uint256 usedQuote, uint256 lp) {
            o.liqTokens = uint128(usedToken);
            o.liqQuote = uint128(usedQuote);
            o.lpAmount = lp;
            o.pair = IUniswapV2Factory(router.factory()).getPair(address(token), address(quote));
            emit LiquidityAdded(id, o.pair, usedToken, usedQuote, lp);
        } catch {
            // Pool pushed off the offer price (or router down): skip; quote and tokens go to the issuer.
            emit LiquiditySkipped(id);
        }
        token.forceApprove(address(router), 0);
        quote.forceApprove(address(router), 0);
    }

    function _setFee(address treasury_, uint16 feeBps_) private {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadParams();
        treasury = treasury_;
        feeBps = feeBps_;
    }
}
