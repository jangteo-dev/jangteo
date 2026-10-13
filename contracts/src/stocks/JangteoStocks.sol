// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";
import {StockToken} from "./StockToken.sol";

interface IStockOracle {
    function priceOf(bytes32 sym) external view returns (uint256 price, uint256 updatedAt, bool open);
}

/// @title JangteoStocks — 장터 주식: Korean and US stocks at the exchange's own price, with a
///        liquidity vault on the other side of every trade. This contract is also the vault's
///        LP token, JSLP.
///
/// @notice Trading: buy or sell any listed stock at the oracle price while its market is open and
///         the price fresh. There is no slippage and no order book: the vault takes the other side.
///         Each trade pays `tradeBps`; `protocolShareBps` of that goes to the treasury, the rest stays
///         in the vault and raises the value of every JSLP.
///
///         Vault: `cash` is the test won it holds (protocol fees excluded); `liability` is what every
///         stock token in circulation is worth at its last price. JSLP is priced at
///         NAV = cash − liability. LPs earn the fees and take the other side of traders' gains and
///         losses. Buys are capped so one stock never exceeds `maxStockBps` of cash and all stocks
///         `maxTotalBps`; sells are never capped, and if prices ever outrun the vault every
///         seller is paid the same share of what is there (see `sell`), so nobody is left unpaid. Deposits lock for `LOCK` (locked LP can't
///         be moved), and a withdrawal leaves `lpFeeBps` behind for the remaining LPs.
///
///         The owner lists markets, pauses buying a market, and tunes fees within caps. There is no
///         path for the owner, or anyone, to take vault money other than trading and pro-rata
///         withdrawal.
contract JangteoStocks is ERC20, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Market {
        StockToken token;
        bytes32 sym;
        uint8 region; // 0 = Korea, 1 = US
        bool buyPaused;
        uint256 volume; // tKRW traded, both sides
    }

    uint256 public constant MAX_MARKETS = 32;
    uint256 public constant MAX_AGE = 90;
    uint256 public constant LOCK = 24 hours;
    uint256 public constant MIN_LIQUIDITY = 1_000;
    uint256 public constant MIN_TRADE = 1_000e18; // ₩1,000
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 public constant MAX_TRADE_BPS = 100;
    uint16 public constant MAX_LP_FEE_BPS = 100;
    uint16 public constant MAX_PROTOCOL_SHARE_BPS = 5_000;

    IERC20 public immutable quote;
    IStockOracle public immutable oracle;
    IIdentityGate public gate;
    address public treasury;
    uint16 public tradeBps = 30;
    uint16 public protocolShareBps = 2_000;
    uint16 public lpFeeBps = 30;
    uint16 public maxStockBps = 2_500;
    uint16 public maxTotalBps = 7_500;
    uint256 public feesAccrued; // protocol share, not vault money

    Market[] private _markets;
    mapping(bytes32 => uint256) private _index; // sym → index + 1
    mapping(address => uint256) public lockedUntil;

    event Listed(uint256 indexed index, bytes32 indexed sym, address token, uint8 region);
    event BuyPaused(bytes32 indexed sym, bool paused);
    event Bought(bytes32 indexed sym, address indexed buyer, uint256 krwIn, uint256 shares, uint256 price, uint256 fee);
    event Sold(bytes32 indexed sym, address indexed seller, uint256 shares, uint256 krwOut, uint256 price, uint256 fee);
    event Deposited(address indexed lp, uint256 krw, uint256 minted, uint256 nav);
    event Withdrawn(address indexed lp, uint256 burned, uint256 krw, uint256 fee, uint256 nav);
    event ParamsSet(address treasury, uint16 tradeBps, uint16 protocolShareBps, uint16 lpFeeBps, uint16 maxStockBps, uint16 maxTotalBps);
    event FeesSwept(address indexed treasury, uint256 amount);

    error BadParams();
    error NotEligible();
    error UnknownMarket();
    error MarketClosed();
    error Paused();
    error Slippage();
    error OverCap();
    error Locked();
    error NoLiquidity();
    error NothingToClaim();

    constructor(address owner_, IIdentityGate gate_, IERC20 quote_, IStockOracle oracle_, address treasury_)
        ERC20("Jangteo Stocks LP", "JSLP")
        Ownable(owner_)
    {
        if (address(gate_) == address(0) || address(quote_) == address(0) || address(oracle_) == address(0)) revert BadParams();
        gate = gate_;
        quote = quote_;
        oracle = oracle_;
        _setParams(treasury_, 30, 2_000, 30, 2_500, 7_500);
    }

    // ───────────────────────────────── admin ────────────────────────────────

    function list(bytes32 sym, string calldata name_, string calldata symbol_, uint8 region) external onlyOwner returns (address token) {
        if (sym == bytes32(0) || _index[sym] != 0 || _markets.length >= MAX_MARKETS || region > 1) revert BadParams();
        StockToken t = new StockToken(name_, symbol_, sym);
        _markets.push(Market({token: t, sym: sym, region: region, buyPaused: false, volume: 0}));
        _index[sym] = _markets.length;
        emit Listed(_markets.length - 1, sym, address(t), region);
        return address(t);
    }

    /// @notice Stops new buys of one stock (e.g. a delisting); holders can always sell.
    function setBuyPaused(bytes32 sym, bool p) external onlyOwner {
        _market(sym).buyPaused = p;
        emit BuyPaused(sym, p);
    }

    function setGate(IIdentityGate gate_) external onlyOwner {
        if (address(gate_) == address(0)) revert BadParams();
        gate = gate_;
    }

    function setParams(address treasury_, uint16 tradeBps_, uint16 protocolShareBps_, uint16 lpFeeBps_, uint16 maxStockBps_, uint16 maxTotalBps_)
        external
        onlyOwner
    {
        _setParams(treasury_, tradeBps_, protocolShareBps_, lpFeeBps_, maxStockBps_, maxTotalBps_);
    }

    function sweepFees() external nonReentrant {
        uint256 amt = feesAccrued;
        if (amt == 0) revert NothingToClaim();
        feesAccrued = 0;
        quote.safeTransfer(treasury, amt);
        emit FeesSwept(treasury, amt);
    }

    // ──────────────────────────────── trading ───────────────────────────────

    function buy(bytes32 sym, uint256 krwIn, uint256 minShares) external nonReentrant returns (uint256 shares) {
        Market storage m = _market(sym);
        if (m.buyPaused) revert Paused();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        if (krwIn < MIN_TRADE) revert BadParams();
        uint256 price = _livePrice(sym);
        uint256 fee = (krwIn * tradeBps) / 10_000;
        shares = ((krwIn - fee) * 1e18) / price;
        if (shares == 0 || shares < minShares) revert Slippage();

        // Caps, with the payment already counted as cash.
        uint256 cashAfter = cash() + krwIn - _protocolCut(fee);
        uint256 stockAfter = ((m.token.totalSupply() + shares) * price) / 1e18;
        if (stockAfter * 10_000 > cashAfter * maxStockBps) revert OverCap();
        if ((liability() + (shares * price) / 1e18) * 10_000 > cashAfter * maxTotalBps) revert OverCap();

        feesAccrued += _protocolCut(fee);
        m.volume += krwIn;
        quote.safeTransferFrom(msg.sender, address(this), krwIn);
        m.token.mint(msg.sender, shares);
        emit Bought(sym, msg.sender, krwIn, shares, price, fee);
    }

    function sell(bytes32 sym, uint256 shares, uint256 minKrw) external nonReentrant returns (uint256 krwOut) {
        Market storage m = _market(sym);
        if (shares == 0) revert BadParams();
        uint256 price = _livePrice(sym);
        uint256 gross = (shares * price) / 1e18;
        // If prices ran up so far that the vault can't cover every holder (LPs are already wiped
        // out), each seller takes the same haircut, cash / liability. The ratio doesn't change as
        // people sell, so the order of selling doesn't matter and nobody is left unpaid.
        uint256 c = cash();
        uint256 l = liability();
        if (l > c) gross = (gross * c) / l;
        uint256 fee = (gross * tradeBps) / 10_000;
        krwOut = gross - fee;
        if (krwOut < minKrw) revert Slippage();
        uint256 cut = _protocolCut(fee);
        feesAccrued += cut;
        m.volume += gross;
        m.token.burn(msg.sender, shares);
        quote.safeTransfer(msg.sender, krwOut);
        emit Sold(sym, msg.sender, shares, krwOut, price, fee);
    }

    // ───────────────────────────────── vault ────────────────────────────────

    function deposit(uint256 krw, uint256 minLp) external nonReentrant returns (uint256 minted) {
        if (krw == 0) revert BadParams();
        uint256 supply = totalSupply();
        uint256 navBefore = nav();
        if (supply == 0) {
            if (krw <= MIN_LIQUIDITY) revert BadParams();
            minted = krw - MIN_LIQUIDITY;
            _mint(DEAD, MIN_LIQUIDITY);
        } else {
            if (navBefore == 0) revert NoLiquidity(); // underwater: new money would only pay old losses
            minted = (krw * supply) / navBefore;
        }
        if (minted == 0 || minted < minLp) revert Slippage();
        lockedUntil[msg.sender] = block.timestamp + LOCK;
        quote.safeTransferFrom(msg.sender, address(this), krw);
        _mint(msg.sender, minted);
        emit Deposited(msg.sender, krw, minted, navBefore + krw);
    }

    function withdraw(uint256 lp, uint256 minKrw) external nonReentrant returns (uint256 krw) {
        if (lp == 0) revert BadParams();
        if (block.timestamp < lockedUntil[msg.sender]) revert Locked();
        uint256 n = nav();
        uint256 gross = (lp * n) / totalSupply();
        if (gross == 0) revert NoLiquidity(); // don't burn LP for nothing; it is worth more if prices come back
        uint256 fee = (gross * lpFeeBps) / 10_000;
        krw = gross - fee;
        if (krw < minKrw) revert Slippage();
        _burn(msg.sender, lp);
        if (krw != 0) quote.safeTransfer(msg.sender, krw);
        emit Withdrawn(msg.sender, lp, krw, fee, n);
    }

    // ───────────────────────────────── views ────────────────────────────────

    /// @notice Test won that belongs to the vault (protocol fees excluded).
    function cash() public view returns (uint256) {
        return quote.balanceOf(address(this)) - feesAccrued;
    }

    /// @notice What every stock token in circulation is worth at its last price.
    function liability() public view returns (uint256 sum) {
        for (uint256 i; i < _markets.length; ++i) {
            uint256 s = _markets[i].token.totalSupply();
            if (s == 0) continue;
            (uint256 p,,) = oracle.priceOf(_markets[i].sym);
            sum += (s * p) / 1e18;
        }
    }

    function nav() public view returns (uint256) {
        uint256 c = cash();
        uint256 l = liability();
        return c > l ? c - l : 0;
    }

    /// @notice Value of one whole JSLP (1e18 units) in test won wei.
    function lpPrice() external view returns (uint256) {
        uint256 s = totalSupply();
        return s == 0 ? 1e18 : (nav() * 1e18) / s;
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function market(uint256 i) external view returns (Market memory) {
        return _markets[i];
    }

    function marketOf(bytes32 sym) external view returns (Market memory) {
        uint256 i = _index[sym];
        if (i == 0) revert UnknownMarket();
        return _markets[i - 1];
    }

    /// @notice Price, whether it can be traded right now, and how much more of it can be bought.
    function quoteOf(bytes32 sym) external view returns (uint256 price, uint256 updatedAt, bool tradable, uint256 buyRoomKrw) {
        Market storage m = _market(sym);
        bool open;
        (price, updatedAt, open) = oracle.priceOf(sym);
        tradable = open && price != 0 && block.timestamp - updatedAt <= MAX_AGE;
        if (price == 0) return (price, updatedAt, tradable, 0);
        uint256 c = cash();
        uint256 stockVal = (m.token.totalSupply() * price) / 1e18;
        uint256 l = liability();
        // Room so both caps hold with the payment counted as cash (fees ignored: a slight underestimate).
        uint256 a = _room(c, stockVal, maxStockBps);
        uint256 b = _room(c, l, maxTotalBps);
        buyRoomKrw = m.buyPaused ? 0 : (a < b ? a : b);
    }

    // ─────────────────────────────── internals ──────────────────────────────

    /// Largest x with (value + x) ≤ (cash + x) × bps / 10_000.
    function _room(uint256 c, uint256 value, uint16 bps) private pure returns (uint256) {
        uint256 lhs = c * bps;
        uint256 rhs = value * 10_000;
        if (lhs <= rhs) return 0;
        return (lhs - rhs) / (10_000 - bps);
    }

    function _market(bytes32 sym) private view returns (Market storage) {
        uint256 i = _index[sym];
        if (i == 0) revert UnknownMarket();
        return _markets[i - 1];
    }

    function _livePrice(bytes32 sym) private view returns (uint256 price) {
        (uint256 p, uint256 at, bool open) = oracle.priceOf(sym);
        if (p == 0 || !open || block.timestamp - at > MAX_AGE) revert MarketClosed();
        return p;
    }

    function _protocolCut(uint256 fee) private view returns (uint256) {
        return (fee * protocolShareBps) / 10_000;
    }

    /// Locked LP can't move: a fresh wallet can't skip the lock, and nobody can push a lock onto
    /// someone else by sending them LP.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && block.timestamp < lockedUntil[from]) revert Locked();
        super._update(from, to, value);
    }

    function _setParams(address treasury_, uint16 tradeBps_, uint16 protocolShareBps_, uint16 lpFeeBps_, uint16 maxStockBps_, uint16 maxTotalBps_)
        private
    {
        if (
            treasury_ == address(0) || tradeBps_ > MAX_TRADE_BPS || protocolShareBps_ > MAX_PROTOCOL_SHARE_BPS || lpFeeBps_ > MAX_LP_FEE_BPS
                || maxStockBps_ == 0 || maxStockBps_ > maxTotalBps_ || maxTotalBps_ > 9_000
        ) revert BadParams();
        treasury = treasury_;
        tradeBps = tradeBps_;
        protocolShareBps = protocolShareBps_;
        lpFeeBps = lpFeeBps_;
        maxStockBps = maxStockBps_;
        maxTotalBps = maxTotalBps_;
        emit ParamsSet(treasury_, tradeBps_, protocolShareBps_, lpFeeBps_, maxStockBps_, maxTotalBps_);
    }
}
