// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";

/// @title JangoeMarket — 장외, trading what doesn't exist yet.
///
/// @notice A premarket for assets with no token yet: 청약 allocations before they unlock, and
///         points programs before their token launches. Nothing is delivered until the token
///         exists, so every trade is a promise backed by collateral:
///
///   Offers    a maker posts a BUY (locks the payment) or SELL (locks collateral) for a number
///             of units at a price in the quote token. Takers fill any part of it.
///   Trades    each fill is a trade: the buyer's payment and the seller's collateral sit here.
///   Settle    once the token exists, the curator fixes the token and how many tokens one unit
///             is worth, and opens a delivery window. A seller who delivers gets the payment
///             and their collateral back. A seller who doesn't forfeits the collateral to the
///             buyer, who also gets the payment back.
///   Void      if the asset never materialises the curator voids the market and every trade
///             unwinds at no cost.
///
///  Fees are taken only when a trade completes: `feeBps` of the payment, from the seller on
///  delivery or from the forfeited collateral on default.
contract JangoeMarket is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Settling,
        Voided
    }
    enum Side {
        Buy,
        Sell
    }
    enum TradeStatus {
        None,
        Open,
        Delivered,
        Defaulted,
        Refunded
    }

    struct Market {
        bytes32 name;
        IERC20 quote;
        uint16 collateralBps; // seller collateral as a share of the trade's value
        uint16 feeBps;
        Status status;
        IERC20 token; // set at settlement
        uint128 tokensPerUnit; // 1e18 = one token per unit
        uint64 deliverBy;
        uint128 volume; // quote traded
        uint32 trades;
    }

    struct Offer {
        uint64 market;
        Side side;
        bool active;
        address maker;
        uint128 units;
        uint128 filled;
        uint128 price; // quote per 1e18 units
        uint128 locked; // quote still held for the unfilled part
    }

    struct Trade {
        uint64 market;
        TradeStatus status;
        address buyer;
        address seller;
        uint128 units;
        uint128 paid;
        uint128 collateral;
    }

    uint16 public constant MAX_FEE_BPS = 500;
    uint16 public constant MIN_COLLATERAL_BPS = 5_000;
    uint16 public constant MAX_COLLATERAL_BPS = 30_000;
    uint64 public constant MIN_WINDOW = 1 days;
    uint64 public constant MAX_WINDOW = 800 days;
    uint256 public constant MAX_META = 2048;

    IIdentityGate public gate;
    address public treasury;
    uint16 public feeBps;
    mapping(address => uint256) public feesAccrued;
    /// @notice Sellers' record across every market.
    mapping(address => uint32) public delivered;
    mapping(address => uint32) public defaulted;

    Market[] private _markets;
    Offer[] private _offers;
    Trade[] private _trades;
    mapping(uint256 => string) public marketMeta;
    mapping(uint256 => uint256[]) private _marketOffers;
    mapping(address => uint256[]) private _userTrades;

    event MarketCreated(uint256 indexed id, bytes32 name, address quote, uint16 collateralBps, string meta);
    event SettlementStarted(uint256 indexed id, address token, uint256 tokensPerUnit, uint64 deliverBy);
    event MarketVoided(uint256 indexed id);
    event OfferPosted(uint256 indexed offer, uint256 indexed market, address indexed maker, Side side, uint256 units, uint256 price);
    event OfferCancelled(uint256 indexed offer, uint256 refund);
    event Filled(uint256 indexed trade, uint256 indexed offer, address buyer, address seller, uint256 units, uint256 paid, uint256 collateral);
    event Delivered(uint256 indexed trade, address indexed seller, uint256 tokens, uint256 fee);
    event Defaulted(uint256 indexed trade, address indexed seller, uint256 toBuyer, uint256 fee);
    event Refunded(uint256 indexed trade);
    event FeesSwept(address indexed quote, address indexed treasury, uint256 amount);

    error BadParams();
    error NotEligible();
    error WrongStatus();
    error NotYours();
    error TooLate();
    error TooEarly();
    error NothingToClaim();

    constructor(address owner_, IIdentityGate gate_, address treasury_, uint16 feeBps_) Ownable(owner_) {
        gate = gate_;
        _setFee(treasury_, feeBps_);
    }

    // ───────────────────────────────── curator ──────────────────────────────

    function setFee(address treasury_, uint16 feeBps_) external onlyOwner {
        _setFee(treasury_, feeBps_);
    }

    function setGate(IIdentityGate gate_) external onlyOwner {
        gate = gate_;
    }

    function createMarket(bytes32 name, IERC20 quote, uint16 collateralBps, string calldata meta) external onlyOwner returns (uint256 id) {
        if (address(quote) == address(0) || collateralBps < MIN_COLLATERAL_BPS || collateralBps > MAX_COLLATERAL_BPS || bytes(meta).length > MAX_META)
        {
            revert BadParams();
        }
        id = _markets.length;
        _markets.push(
            Market({
                name: name,
                quote: quote,
                collateralBps: collateralBps,
                feeBps: feeBps,
                status: Status.Open,
                token: IERC20(address(0)),
                tokensPerUnit: 0,
                deliverBy: 0,
                volume: 0,
                trades: 0
            })
        );
        marketMeta[id] = meta;
        emit MarketCreated(id, name, address(quote), collateralBps, meta);
    }

    /// @notice The token exists: fix what one unit is worth and open the delivery window.
    ///         Trading stops; open offers can only be cancelled.
    function startSettlement(uint256 id, IERC20 token, uint128 tokensPerUnit, uint64 window) external onlyOwner {
        Market storage m = _markets[id];
        if (m.status != Status.Open) revert WrongStatus();
        if (address(token) == address(0) || tokensPerUnit == 0 || window < MIN_WINDOW || window > MAX_WINDOW) revert BadParams();
        m.status = Status.Settling;
        m.token = token;
        m.tokensPerUnit = tokensPerUnit;
        m.deliverBy = uint64(block.timestamp) + window;
        emit SettlementStarted(id, address(token), tokensPerUnit, m.deliverBy);
    }

    /// @notice The asset will never exist (or the market was a mistake): every trade unwinds.
    function voidMarket(uint256 id) external onlyOwner {
        Market storage m = _markets[id];
        if (m.status != Status.Open && m.status != Status.Settling) revert WrongStatus();
        m.status = Status.Voided;
        emit MarketVoided(id);
    }

    function sweepFees(address quote) external nonReentrant {
        uint256 amt = feesAccrued[quote];
        if (amt == 0) revert NothingToClaim();
        feesAccrued[quote] = 0;
        IERC20(quote).safeTransfer(treasury, amt);
        emit FeesSwept(quote, treasury, amt);
    }

    // ───────────────────────────────── trading ──────────────────────────────

    function post(uint256 marketId, Side side, uint128 units, uint128 price) external nonReentrant returns (uint256 id) {
        Market storage m = _markets[marketId];
        if (m.status != Status.Open) revert WrongStatus();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        if (units == 0 || price == 0) revert BadParams();
        uint256 value = _value(units, price);
        uint256 lock = side == Side.Buy ? value : _collateral(m, value);
        if (value == 0) revert BadParams();
        id = _offers.length;
        _offers.push(
            Offer({
                market: uint64(marketId),
                side: side,
                active: true,
                maker: msg.sender,
                units: units,
                filled: 0,
                price: price,
                locked: uint128(lock)
            })
        );
        _marketOffers[marketId].push(id);
        m.quote.safeTransferFrom(msg.sender, address(this), lock);
        emit OfferPosted(id, marketId, msg.sender, side, units, price);
    }

    /// @notice Take `units` of an offer. Selling into a BUY locks your collateral; buying from a
    ///         SELL pays the price now.
    function fill(uint256 offerId, uint128 units) external nonReentrant returns (uint256 tradeId) {
        Offer storage o = _offers[offerId];
        Market storage m = _markets[o.market];
        if (!o.active || m.status != Status.Open) revert WrongStatus();
        if (msg.sender == o.maker) revert NotYours();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        if (units == 0 || units > o.units - o.filled) revert BadParams();

        o.filled += units;
        bool last = o.filled == o.units;
        uint256 paid = _value(units, o.price);
        uint256 collateral = _collateral(m, paid);
        if (paid == 0) revert BadParams();

        // The maker's share of what they locked; the last fill takes the rounding dust.
        uint256 fromMaker = o.side == Side.Buy ? paid : collateral;
        uint256 dust;
        if (last) {
            dust = o.locked - fromMaker;
            o.locked = 0;
            o.active = false;
        } else {
            o.locked -= uint128(fromMaker);
        }

        (address buyer, address seller) = o.side == Side.Buy ? (o.maker, msg.sender) : (msg.sender, o.maker);
        tradeId = _trades.length;
        _trades.push(
            Trade({
                market: o.market,
                status: TradeStatus.Open,
                buyer: buyer,
                seller: seller,
                units: units,
                paid: uint128(paid),
                collateral: uint128(collateral)
            })
        );
        _userTrades[buyer].push(tradeId);
        _userTrades[seller].push(tradeId);
        m.volume += uint128(paid);
        m.trades += 1;

        m.quote.safeTransferFrom(msg.sender, address(this), o.side == Side.Buy ? collateral : paid);
        if (dust != 0) m.quote.safeTransfer(o.maker, dust);
        emit Filled(tradeId, offerId, buyer, seller, units, paid, collateral);
    }

    function cancel(uint256 offerId) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (msg.sender != o.maker) revert NotYours();
        if (!o.active) revert WrongStatus();
        uint256 refund = o.locked;
        o.active = false;
        o.locked = 0;
        _markets[o.market].quote.safeTransfer(o.maker, refund);
        emit OfferCancelled(offerId, refund);
    }

    // ──────────────────────────────── settlement ────────────────────────────

    /// @notice Seller delivers: tokens go straight to the buyer, payment and collateral to the seller.
    function deliver(uint256[] calldata tradeIds) external nonReentrant {
        for (uint256 i; i < tradeIds.length; ++i) {
            Trade storage t = _trades[tradeIds[i]];
            Market storage m = _markets[t.market];
            if (t.seller != msg.sender) revert NotYours();
            if (t.status != TradeStatus.Open || m.status != Status.Settling) revert WrongStatus();
            if (block.timestamp > m.deliverBy) revert TooLate();
            t.status = TradeStatus.Delivered;
            uint256 tokens = uint256(t.units) * m.tokensPerUnit / 1e18;
            uint256 fee = uint256(t.paid) * m.feeBps / 10_000;
            feesAccrued[address(m.quote)] += fee;
            delivered[t.seller] += 1;
            m.token.safeTransferFrom(msg.sender, t.buyer, tokens);
            m.quote.safeTransfer(t.seller, uint256(t.paid) + t.collateral - fee);
            emit Delivered(tradeIds[i], t.seller, tokens, fee);
        }
    }

    /// @notice After the window, an undelivered trade pays the buyer back plus the collateral.
    ///         Anyone may call; the money always goes to the buyer.
    function claimDefault(uint256[] calldata tradeIds) external nonReentrant {
        for (uint256 i; i < tradeIds.length; ++i) {
            Trade storage t = _trades[tradeIds[i]];
            Market storage m = _markets[t.market];
            if (t.status != TradeStatus.Open || m.status != Status.Settling) revert WrongStatus();
            if (block.timestamp <= m.deliverBy) revert TooEarly();
            t.status = TradeStatus.Defaulted;
            uint256 fee = uint256(t.paid) * m.feeBps / 10_000;
            if (fee > t.collateral) fee = t.collateral;
            feesAccrued[address(m.quote)] += fee;
            defaulted[t.seller] += 1;
            uint256 toBuyer = uint256(t.paid) + t.collateral - fee;
            m.quote.safeTransfer(t.buyer, toBuyer);
            emit Defaulted(tradeIds[i], t.seller, toBuyer, fee);
        }
    }

    /// @notice In a voided market every trade unwinds: payment to the buyer, collateral to the seller.
    function refund(uint256[] calldata tradeIds) external nonReentrant {
        for (uint256 i; i < tradeIds.length; ++i) {
            Trade storage t = _trades[tradeIds[i]];
            Market storage m = _markets[t.market];
            if (t.status != TradeStatus.Open || m.status != Status.Voided) revert WrongStatus();
            t.status = TradeStatus.Refunded;
            m.quote.safeTransfer(t.buyer, t.paid);
            m.quote.safeTransfer(t.seller, t.collateral);
            emit Refunded(tradeIds[i]);
        }
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function market(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    function offer(uint256 id) external view returns (Offer memory) {
        return _offers[id];
    }

    function trade(uint256 id) external view returns (Trade memory) {
        return _trades[id];
    }

    function offerCount() external view returns (uint256) {
        return _offers.length;
    }

    function tradeCount() external view returns (uint256) {
        return _trades.length;
    }

    /// @notice Offer ids of a market, `start` to `start + n`.
    function marketOffers(uint256 id, uint256 start, uint256 n) external view returns (uint256[] memory out) {
        uint256[] storage all = _marketOffers[id];
        uint256 end = start + n > all.length ? all.length : start + n;
        out = new uint256[](end > start ? end - start : 0);
        for (uint256 i = start; i < end; ++i) out[i - start] = all[i];
    }

    function marketOfferCount(uint256 id) external view returns (uint256) {
        return _marketOffers[id].length;
    }

    function tradesOf(address who) external view returns (uint256[] memory) {
        return _userTrades[who];
    }

    // ──────────────────────────────── internal ───────────────────────────────

    function _value(uint256 units, uint256 price) private pure returns (uint256) {
        return units * price / 1e18;
    }

    function _collateral(Market storage m, uint256 value) private view returns (uint256) {
        return value * m.collateralBps / 10_000;
    }

    function _setFee(address treasury_, uint16 feeBps_) private {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadParams();
        treasury = treasury_;
        feeBps = feeBps_;
    }
}
