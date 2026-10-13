// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";
import {PropertyShare, IPropertyRegistry} from "./PropertyShare.sol";

/// @title JangteoProperty — 장터 부동산, fractional property.
///
/// @notice A property is split into shares sold for the quote token (tKRW). Holders receive rent
///         every period pro rata, trade shares on a built-in market, and when the property is
///         sold they redeem their shares for the proceeds.
///
///   Funding   anyone may buy shares at a fixed price until sold out or the deadline. Below the
///             soft cap at the deadline the sale fails and every buyer gets their money back.
///   Active    the issuer receives the proceeds minus the fee and a rent reserve. Every `period`
///             the rent is owed; it is paid from the reserve (anyone can trigger it) to the
///             shares not sitting in market escrow. Unpaid rent piles up as arrears and is paid
///             first whenever the reserve is topped up. Rent is claimable at any time, forever.
///   Sold      the issuer deposits the sale proceeds. Arrears are paid first, the remaining
///             reserve returns to the issuer, and the rest is redeemable share by share.
///
///  There is no loop over holders anywhere, and no path for the owner to move holders' money:
///  the owner can only badge properties, cancel a sale that is still funding (full refunds),
///  change fees for future properties and sweep fees already earned.
contract JangteoProperty is Ownable2Step, ReentrancyGuard, IPropertyRegistry {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Funding,
        Active,
        Failed,
        Sold
    }

    struct Terms {
        uint256 totalShares;
        uint256 minShares;
        uint256 price; // quote wei per share
        uint256 duration; // seconds the sale stays open
        uint256 rentPerPeriod; // quote wei for all holders together
        uint256 reserveMonths; // periods of rent held back from the proceeds
    }

    struct Property {
        PropertyShare share;
        address issuer;
        Status status;
        bool verified;
        uint16 saleBps;
        uint16 tradeBps;
        uint16 exitBps;
        uint256 totalShares;
        uint256 minShares;
        uint256 price;
        uint256 endAt;
        uint256 rentPerPeriod;
        uint256 reserveMonths;
        uint256 sold;
        // Active
        uint256 activatedAt;
        uint256 lastPeriodAt;
        uint256 reserve;
        uint256 due; // arrears
        uint256 accPerShare; // rent per share, scaled by SCALE
        uint256 rentPaid; // total rent ever paid out to holders
        uint256 rentUnclaimed;
        // Failed
        uint256 refundable;
        // Sold
        uint256 salePrice;
        uint256 pool;
        uint256 exitSupply;
        uint256 redeemed; // shares redeemed so far
    }

    struct Listing {
        uint256 property;
        address seller;
        uint256 shares; // still for sale
        uint256 price; // quote wei per share
    }

    uint256 public constant SCALE = 1e18;
    uint256 public constant MAX_SHARES = 1e12;
    uint256 public constant MAX_PRICE = 1e30;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant MIN_RESERVE_MONTHS = 3;
    uint256 public constant MAX_RESERVE_MONTHS = 24;
    uint256 public constant MAX_META = 4096;
    uint16 public constant MAX_SALE_BPS = 500;
    uint16 public constant MAX_TRADE_BPS = 300;
    uint16 public constant MAX_EXIT_BPS = 300;

    IERC20 public immutable quote;
    uint256 public immutable period;
    uint256 public immutable minDuration;

    IIdentityGate public gate;
    address public treasury;
    uint16 public saleBps;
    uint16 public tradeBps;
    uint16 public exitBps;
    uint256 public feesAccrued;

    Property[] private _props;
    Listing[] private _listings;
    mapping(uint256 => string) public metadata;
    mapping(uint256 => uint256[]) private _propListings;
    mapping(uint256 => mapping(address => uint256)) public rentDebt; // accPerShare already settled
    mapping(uint256 => mapping(address => uint256)) public rentOwed; // settled, not yet claimed

    event Created(uint256 indexed id, address indexed issuer, address share, string metadata);
    event VerifiedSet(uint256 indexed id, bool verified);
    event Bought(uint256 indexed id, address indexed buyer, uint256 shares, uint256 paid);
    event Activated(uint256 indexed id, uint256 sold, uint256 raised, uint256 fee, uint256 reserve, uint256 toIssuer);
    event Failed(uint256 indexed id, uint256 sold, bool cancelled);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 shares, uint256 amount);
    event RentAccrued(uint256 indexed id, uint256 periods, uint256 paid, uint256 due);
    event ReserveFunded(uint256 indexed id, address indexed from, uint256 amount);
    event RentClaimed(uint256 indexed id, address indexed holder, uint256 amount);
    event Listed(uint256 indexed listing, uint256 indexed id, address indexed seller, uint256 shares, uint256 price);
    event ListingFilled(uint256 indexed listing, uint256 indexed id, address indexed buyer, uint256 shares, uint256 paid, uint256 fee);
    event ListingCancelled(uint256 indexed listing, uint256 shares);
    event PropertySold(uint256 indexed id, uint256 salePrice, uint256 arrearsPaid, uint256 reserveReturned, uint256 fee, uint256 pool);
    event Redeemed(uint256 indexed id, address indexed holder, uint256 shares, uint256 amount);
    event FeesSet(address treasury, uint16 saleBps, uint16 tradeBps, uint16 exitBps);
    event FeesSwept(address indexed treasury, uint256 amount);

    error BadParams();
    error NotEligible();
    error WrongStatus();
    error NotOpen();
    error NotYet();
    error NotIssuer();
    error NotYours();
    error NothingToClaim();
    error SoldOut();
    error Locked();
    error OnlyShare();

    constructor(
        address owner_,
        IIdentityGate gate_,
        IERC20 quote_,
        address treasury_,
        uint256 period_,
        uint256 minDuration_
    ) Ownable(owner_) {
        if (address(gate_) == address(0) || address(quote_) == address(0) || period_ == 0 || minDuration_ == 0) {
            revert BadParams();
        }
        gate = gate_;
        quote = quote_;
        period = period_;
        minDuration = minDuration_;
        _setFees(treasury_, 200, 100, 100);
    }

    // ───────────────────────────────── admin ────────────────────────────────

    function setVerified(uint256 id, bool v) external onlyOwner {
        _prop(id).verified = v;
        emit VerifiedSet(id, v);
    }

    function setGate(IIdentityGate gate_) external onlyOwner {
        if (address(gate_) == address(0)) revert BadParams();
        gate = gate_;
    }

    /// @notice Applies to properties created afterwards; each property keeps the fees it was created with.
    function setFees(address treasury_, uint16 saleBps_, uint16 tradeBps_, uint16 exitBps_) external onlyOwner {
        _setFees(treasury_, saleBps_, tradeBps_, exitBps_);
    }

    function sweepFees() external nonReentrant {
        uint256 amt = feesAccrued;
        if (amt == 0) revert NothingToClaim();
        feesAccrued = 0;
        quote.safeTransfer(treasury, amt);
        emit FeesSwept(treasury, amt);
    }

    // ──────────────────────────────── funding ───────────────────────────────

    /// @notice Open to Dojang-verified wallets; the curator lists its own (verified) properties too.
    function create(Terms calldata t, string calldata meta) external nonReentrant returns (uint256 id) {
        if (msg.sender != owner() && !gate.isEligible(msg.sender)) revert NotEligible();
        if (
            t.totalShares == 0 || t.totalShares > MAX_SHARES || t.minShares == 0 || t.minShares > t.totalShares
                || t.price == 0 || t.price > MAX_PRICE || t.duration < minDuration || t.duration > MAX_DURATION
                || bytes(meta).length > MAX_META
        ) revert BadParams();
        if (t.rentPerPeriod == 0) {
            if (t.reserveMonths != 0) revert BadParams();
        } else {
            if (t.reserveMonths < MIN_RESERVE_MONTHS || t.reserveMonths > MAX_RESERVE_MONTHS) revert BadParams();
            // The reserve must always be payable out of the smallest successful raise.
            uint256 minNet = t.minShares * t.price - (t.minShares * t.price * saleBps) / 10_000;
            if (t.rentPerPeriod > MAX_PRICE || t.reserveMonths * t.rentPerPeriod > minNet) revert BadParams();
        }

        id = _props.length;
        string memory n = Strings.toString(id);
        PropertyShare share = new PropertyShare(string.concat("Jangteo Property #", n), string.concat("JPROP", n), id);
        Property storage p = _props.push();
        p.share = share;
        p.issuer = msg.sender;
        p.status = Status.Funding;
        p.saleBps = saleBps;
        p.tradeBps = tradeBps;
        p.exitBps = exitBps;
        p.totalShares = t.totalShares;
        p.minShares = t.minShares;
        p.price = t.price;
        p.endAt = block.timestamp + t.duration;
        p.rentPerPeriod = t.rentPerPeriod;
        p.reserveMonths = t.reserveMonths;
        metadata[id] = meta;
        emit Created(id, msg.sender, address(share), meta);
    }

    function buy(uint256 id, uint256 shares) external nonReentrant {
        Property storage p = _prop(id);
        if (p.status != Status.Funding || block.timestamp >= p.endAt) revert NotOpen();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        if (shares == 0) revert BadParams();
        if (p.sold + shares > p.totalShares) revert SoldOut();
        uint256 cost = shares * p.price;
        p.sold += shares;
        quote.safeTransferFrom(msg.sender, address(this), cost);
        p.share.mint(msg.sender, shares);
        emit Bought(id, msg.sender, shares, cost);
    }

    /// @notice Closes the sale once it sold out or its deadline passed. Anyone may call.
    function finalize(uint256 id) external nonReentrant {
        Property storage p = _prop(id);
        if (p.status != Status.Funding) revert WrongStatus();
        if (p.sold < p.totalShares && block.timestamp < p.endAt) revert NotYet();
        if (p.sold < p.minShares) {
            _fail(id, p, false);
            return;
        }
        uint256 raised = p.sold * p.price;
        uint256 fee = (raised * p.saleBps) / 10_000;
        uint256 reserve = p.reserveMonths * p.rentPerPeriod;
        uint256 toIssuer = raised - fee - reserve;
        p.status = Status.Active;
        p.activatedAt = block.timestamp;
        p.lastPeriodAt = block.timestamp;
        p.reserve = reserve;
        feesAccrued += fee;
        if (toIssuer != 0) quote.safeTransfer(p.issuer, toIssuer);
        emit Activated(id, p.sold, raised, fee, reserve, toIssuer);
    }

    /// @notice Issuer or curator stops a sale that is still funding; every buyer is refunded in full.
    function cancel(uint256 id) external nonReentrant {
        Property storage p = _prop(id);
        if (msg.sender != p.issuer && msg.sender != owner()) revert NotIssuer();
        if (p.status != Status.Funding) revert WrongStatus();
        _fail(id, p, true);
    }

    function refund(uint256 id) external nonReentrant {
        Property storage p = _prop(id);
        if (p.status != Status.Failed) revert WrongStatus();
        uint256 shares = p.share.balanceOf(msg.sender);
        if (shares == 0) revert NothingToClaim();
        uint256 amount = shares * p.price;
        p.refundable -= amount;
        p.share.burn(msg.sender, shares);
        quote.safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, shares, amount);
    }

    // ───────────────────────────────── rent ─────────────────────────────────

    /// @notice Books every rent period that has passed and pays what the reserve covers. Anyone may call.
    function accrue(uint256 id) external {
        _accrue(id, _prop(id));
    }

    /// @notice Tops up the rent reserve (issuer, or anyone paying rent on their behalf).
    function fundReserve(uint256 id, uint256 amount) external nonReentrant {
        Property storage p = _prop(id);
        if (p.status != Status.Active) revert WrongStatus();
        if (amount == 0) revert BadParams();
        quote.safeTransferFrom(msg.sender, address(this), amount);
        _accrue(id, p);
        p.reserve += amount;
        _pay(id, p);
        emit ReserveFunded(id, msg.sender, amount);
    }

    function claimRent(uint256 id) external nonReentrant returns (uint256 amount) {
        Property storage p = _prop(id);
        _accrue(id, p);
        _settle(id, p, msg.sender);
        amount = rentOwed[id][msg.sender];
        if (amount == 0) revert NothingToClaim();
        rentOwed[id][msg.sender] = 0;
        p.rentUnclaimed -= amount;
        quote.safeTransfer(msg.sender, amount);
        emit RentClaimed(id, msg.sender, amount);
    }

    // ──────────────────────────────── market ────────────────────────────────

    function list(uint256 id, uint256 shares, uint256 price) external nonReentrant returns (uint256 lid) {
        Property storage p = _prop(id);
        if (p.status != Status.Active) revert WrongStatus();
        if (shares == 0 || price == 0 || price > MAX_PRICE) revert BadParams();
        lid = _listings.length;
        _listings.push(Listing({property: id, seller: msg.sender, shares: shares, price: price}));
        _propListings[id].push(lid);
        p.share.move(msg.sender, address(this), shares);
        emit Listed(lid, id, msg.sender, shares, price);
    }

    function buyListing(uint256 lid, uint256 shares) external nonReentrant {
        Listing storage l = _listing(lid);
        Property storage p = _props[l.property];
        if (p.status != Status.Active) revert WrongStatus();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        if (shares == 0 || shares > l.shares) revert BadParams();
        uint256 cost = shares * l.price;
        uint256 fee = (cost * p.tradeBps) / 10_000;
        l.shares -= shares;
        feesAccrued += fee;
        quote.safeTransferFrom(msg.sender, address(this), cost);
        quote.safeTransfer(l.seller, cost - fee);
        p.share.move(address(this), msg.sender, shares);
        emit ListingFilled(lid, l.property, msg.sender, shares, cost, fee);
    }

    /// @notice Takes unsold listed shares back. Works after the property was sold, so they can be redeemed.
    function cancelListing(uint256 lid) external nonReentrant {
        Listing storage l = _listing(lid);
        if (msg.sender != l.seller) revert NotYours();
        uint256 shares = l.shares;
        if (shares == 0) revert NothingToClaim();
        l.shares = 0;
        _props[l.property].share.move(address(this), l.seller, shares);
        emit ListingCancelled(lid, shares);
    }

    // ───────────────────────────────── exit ─────────────────────────────────

    /// @notice The issuer sold the property and deposits `amount`; holders redeem shares for it.
    function sell(uint256 id, uint256 amount) external nonReentrant {
        Property storage p = _prop(id);
        if (msg.sender != p.issuer) revert NotIssuer();
        if (p.status != Status.Active) revert WrongStatus();
        if (amount == 0) revert BadParams();
        quote.safeTransferFrom(msg.sender, address(this), amount);
        _accrue(id, p); // arrears are paid from the reserve first

        uint256 arrearsPaid;
        uint256 eligible = _eligible(p);
        if (p.due != 0 && eligible != 0) {
            arrearsPaid = p.due < amount ? p.due : amount;
            _distribute(p, arrearsPaid, eligible);
        }
        p.due = 0; // with no eligible shares, the arrears stay in the pool every share redeems from
        uint256 back = p.reserve;
        p.reserve = 0;
        uint256 rest = amount - arrearsPaid;
        uint256 fee = (rest * p.exitBps) / 10_000;
        feesAccrued += fee;
        p.status = Status.Sold;
        p.salePrice = amount;
        p.pool = rest - fee;
        p.exitSupply = p.share.totalSupply();
        if (back != 0) quote.safeTransfer(p.issuer, back);
        emit PropertySold(id, amount, arrearsPaid, back, fee, p.pool);
    }

    function redeem(uint256 id, uint256 shares) external nonReentrant returns (uint256 amount) {
        Property storage p = _prop(id);
        if (p.status != Status.Sold) revert WrongStatus();
        if (shares == 0) revert BadParams();
        // Cumulative rounding: the last share redeemed takes exactly what is left.
        uint256 before = (p.pool * p.redeemed) / p.exitSupply;
        p.redeemed += shares;
        amount = (p.pool * p.redeemed) / p.exitSupply - before;
        p.share.burn(msg.sender, shares); // reverts if the caller holds fewer
        if (amount != 0) quote.safeTransfer(msg.sender, amount);
        emit Redeemed(id, msg.sender, shares, amount);
    }

    // ───────────────────────────── share hook ───────────────────────────────

    /// @inheritdoc IPropertyRegistry
    function onShareTransfer(uint256 id, address from, address to) external {
        Property storage p = _prop(id);
        if (msg.sender != address(p.share)) revert OnlyShare();
        if (from != address(0) && to != address(0)) {
            // A plain move between holders, or into / out of market escrow.
            if (p.status == Status.Active) {
                if (from != address(this) && to != address(this) && !gate.isEligible(to)) revert NotEligible();
            } else if (!(p.status == Status.Sold && from == address(this))) {
                revert Locked();
            }
        }
        _accrue(id, p);
        _settle(id, p, from);
        _settle(id, p, to);
    }

    // ───────────────────────────────── views ────────────────────────────────

    function count() external view returns (uint256) {
        return _props.length;
    }

    function property(uint256 id) external view returns (Property memory) {
        return _props[id];
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function listing(uint256 lid) external view returns (Listing memory) {
        return _listings[lid];
    }

    function listingsOf(uint256 id) external view returns (uint256[] memory) {
        return _propListings[id];
    }

    /// @notice Shares that earn rent: everything not sitting in market escrow.
    function eligibleShares(uint256 id) external view returns (uint256) {
        return _eligible(_props[id]);
    }

    /// @notice Rent `who` could claim right now, including periods not yet booked.
    function claimable(uint256 id, address who) external view returns (uint256) {
        Property storage p = _props[id];
        uint256 acc = p.accPerShare;
        if (p.status == Status.Active) {
            uint256 due = p.due + ((block.timestamp - p.lastPeriodAt) / period) * p.rentPerPeriod;
            uint256 pay = due < p.reserve ? due : p.reserve;
            uint256 eligible = _eligible(p);
            if (pay != 0 && eligible != 0) acc += (pay * SCALE) / eligible;
        }
        uint256 owed = rentOwed[id][who];
        if (who != address(this) && who != address(0)) owed += (p.share.balanceOf(who) * (acc - rentDebt[id][who])) / SCALE;
        return owed;
    }

    /// @notice Periods booked but unpaid plus periods passed and not booked yet.
    function arrears(uint256 id) external view returns (uint256 due, uint256 nextPeriodAt) {
        Property storage p = _props[id];
        if (p.status != Status.Active) return (0, 0);
        uint256 n = (block.timestamp - p.lastPeriodAt) / period;
        uint256 total = p.due + n * p.rentPerPeriod;
        due = total > p.reserve ? total - p.reserve : 0;
        nextPeriodAt = p.lastPeriodAt + (n + 1) * period;
    }

    // ─────────────────────────────── internals ──────────────────────────────

    function _prop(uint256 id) private view returns (Property storage) {
        if (id >= _props.length) revert BadParams();
        return _props[id];
    }

    function _listing(uint256 lid) private view returns (Listing storage) {
        if (lid >= _listings.length) revert BadParams();
        return _listings[lid];
    }

    function _eligible(Property storage p) private view returns (uint256) {
        return p.share.totalSupply() - p.share.balanceOf(address(this));
    }

    function _fail(uint256 id, Property storage p, bool cancelled) private {
        p.status = Status.Failed;
        p.refundable = p.sold * p.price;
        emit Failed(id, p.sold, cancelled);
    }

    function _accrue(uint256 id, Property storage p) private {
        if (p.status != Status.Active) return;
        uint256 n = (block.timestamp - p.lastPeriodAt) / period;
        if (n != 0) {
            p.lastPeriodAt += n * period;
            p.due += n * p.rentPerPeriod;
        }
        uint256 paid = _pay(id, p);
        if (n != 0 || paid != 0) emit RentAccrued(id, n, paid, p.due);
    }

    function _pay(uint256, Property storage p) private returns (uint256 amt) {
        if (p.due == 0 || p.reserve == 0) return 0;
        uint256 eligible = _eligible(p);
        if (eligible == 0) return 0; // waits until some shares are out of escrow
        amt = p.due < p.reserve ? p.due : p.reserve;
        p.reserve -= amt;
        p.due -= amt;
        _distribute(p, amt, eligible);
    }

    function _distribute(Property storage p, uint256 amt, uint256 eligible) private {
        p.accPerShare += (amt * SCALE) / eligible;
        p.rentPaid += amt;
        p.rentUnclaimed += amt;
    }

    function _settle(uint256 id, Property storage p, address who) private {
        if (who == address(0) || who == address(this)) return;
        uint256 acc = p.accPerShare;
        uint256 bal = p.share.balanceOf(who);
        if (bal != 0) rentOwed[id][who] += (bal * (acc - rentDebt[id][who])) / SCALE;
        rentDebt[id][who] = acc;
    }

    function _setFees(address treasury_, uint16 saleBps_, uint16 tradeBps_, uint16 exitBps_) private {
        if (treasury_ == address(0) || saleBps_ > MAX_SALE_BPS || tradeBps_ > MAX_TRADE_BPS || exitBps_ > MAX_EXIT_BPS) {
            revert BadParams();
        }
        treasury = treasury_;
        saleBps = saleBps_;
        tradeBps = tradeBps_;
        exitBps = exitBps_;
        emit FeesSet(treasury_, saleBps_, tradeBps_, exitBps_);
    }
}
