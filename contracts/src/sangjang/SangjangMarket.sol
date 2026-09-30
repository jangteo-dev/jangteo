// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";

/// @title SangjangMarket — 상장, parimutuel markets on "will X be listed on Upbit KRW by date D?"
///
/// @notice Each market is a YES/NO pool. At resolution the losing pool, minus a fee, is shared
///         by the winning side pro rata to stake.
///
///  Why listing markets need special handling: Upbit announces a listing at an exact moment, and
///  anyone who reads the notice first could bet after the fact. Every bet is timestamped and the
///  pools keep cumulative checkpoints, so settlement counts only bets placed strictly before the
///  announcement; later bets are refunded in full.
///
///  Resolution is optimistic: a resolver proposes (outcome, announcement time, evidence), anyone
///  holding a verified identity may dispute during the challenge window by posting a bond, and
///  the owner decides disputed markets. The owner can also void a market (full refunds). The owner can
///  never move stakes anywhere except back to the bettors.
///
///  Only Dojang-verified accounts may bet or dispute, and each has a per-market stake cap, so
///  one person cannot dominate a pool through many wallets.
contract SangjangMarket is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Proposed,
        Disputed,
        Resolved,
        Voided
    }

    struct Market {
        bytes32 symbol;
        uint64 createdAt;
        uint64 closesAt;
        uint128 cap;
        Status status;
        bool yes;
        uint64 announcedAt;
        uint64 proposedAt;
        address disputer;
        bytes32 evidence;
        uint128 yesPool;
        uint128 noPool;
        uint128 effYes;
        uint128 effNo;
        uint128 fee;
    }

    struct Checkpoint {
        uint64 at;
        uint128 yesCum;
        uint128 noCum;
    }

    struct Bet {
        uint64 at;
        bool yes;
        uint128 amount;
    }

    uint256 public constant MAX_BETS_PER_USER = 32;
    uint16 public constant MAX_FEE_BPS = 500;

    IERC20 public immutable token;
    IIdentityGate public gate;
    address public treasury;
    uint16 public feeBps;
    uint64 public challengeWindow;
    uint128 public disputeBond;

    mapping(address => bool) public isCurator;
    mapping(address => bool) public isResolver;

    Market[] private _markets;
    mapping(uint256 => Checkpoint[]) private _history;
    mapping(uint256 => mapping(address => Bet[])) private _bets;
    mapping(uint256 => mapping(address => uint128)) public staked;
    mapping(uint256 => mapping(address => bool)) public claimed;
    uint256 public treasuryAccrued;

    event MarketCreated(uint256 indexed id, bytes32 indexed symbol, uint64 closesAt, uint128 cap);
    event BetPlaced(uint256 indexed id, address indexed user, bool yes, uint256 amount, uint64 at);
    event Proposed(uint256 indexed id, bool yes, uint64 announcedAt, bytes32 evidence);
    event Disputed(uint256 indexed id, address indexed disputer);
    event Resolved(uint256 indexed id, bool yes, uint64 announcedAt, uint256 effYes, uint256 effNo, uint256 fee);
    event Voided(uint256 indexed id, string reason);
    event Claimed(uint256 indexed id, address indexed user, uint256 payout);
    event RoleSet(address indexed who, bool curator, bool resolver);
    event ParamsSet(address treasury, uint16 feeBps, uint64 challengeWindow, uint128 disputeBond);

    error NotCurator();
    error NotResolver();
    error BadParams();
    error NotOpen();
    error Closed();
    error NotEligible();
    error OverCap();
    error TooManyBets();
    error BadProposal();
    error NotProposed();
    error WindowOpen();
    error WindowClosed();
    error NotDisputed();
    error NotFinal();
    error AlreadyClaimed();
    error NothingToClaim();

    constructor(address owner_, IERC20 token_, IIdentityGate gate_, address treasury_, uint64 window_, uint128 bond_)
        Ownable(owner_)
    {
        token = token_;
        gate = gate_;
        _setParams(treasury_, 100, window_, bond_);
    }

    // ───────────────────────────────── admin ─────────────────────────────────

    function setRoles(address who, bool curator, bool resolver) external onlyOwner {
        isCurator[who] = curator;
        isResolver[who] = resolver;
        emit RoleSet(who, curator, resolver);
    }

    function setParams(address treasury_, uint16 feeBps_, uint64 window_, uint128 bond_) external onlyOwner {
        _setParams(treasury_, feeBps_, window_, bond_);
    }

    function setGate(IIdentityGate gate_) external onlyOwner {
        gate = gate_;
    }

    function withdrawTreasury() external nonReentrant {
        uint256 amt = treasuryAccrued;
        treasuryAccrued = 0;
        token.safeTransfer(treasury, amt);
    }

    // ──────────────────────────────── markets ────────────────────────────────

    function createMarket(bytes32 symbol, uint64 closesAt, uint128 cap) external returns (uint256 id) {
        if (!isCurator[msg.sender]) revert NotCurator();
        if (symbol == bytes32(0) || closesAt <= block.timestamp || cap == 0) revert BadParams();
        id = _markets.length;
        Market storage m = _markets.push();
        m.symbol = symbol;
        m.createdAt = uint64(block.timestamp);
        m.closesAt = closesAt;
        m.cap = cap;
        m.status = Status.Open;
        emit MarketCreated(id, symbol, closesAt, cap);
    }

    function bet(uint256 id, bool yes, uint128 amount) external nonReentrant {
        Market storage m = _markets[id];
        if (m.status != Status.Open) revert NotOpen();
        if (block.timestamp >= m.closesAt) revert Closed();
        if (amount == 0) revert BadParams();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        uint128 s = staked[id][msg.sender] + amount;
        if (s > m.cap) revert OverCap();
        Bet[] storage bs = _bets[id][msg.sender];
        if (bs.length >= MAX_BETS_PER_USER) revert TooManyBets();

        staked[id][msg.sender] = s;
        uint64 now_ = uint64(block.timestamp);
        bs.push(Bet({at: now_, yes: yes, amount: amount}));
        if (yes) m.yesPool += amount;
        else m.noPool += amount;

        Checkpoint[] storage h = _history[id];
        if (h.length != 0 && h[h.length - 1].at == now_) {
            Checkpoint storage last = h[h.length - 1];
            last.yesCum = m.yesPool;
            last.noCum = m.noPool;
        } else {
            h.push(Checkpoint({at: now_, yesCum: m.yesPool, noCum: m.noPool}));
        }

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit BetPlaced(id, msg.sender, yes, amount, now_);
    }

    // ─────────────────────────────── resolution ──────────────────────────────

    /// @param yes           true when Upbit announced a KRW listing before `closesAt`
    /// @param announcedAt   timestamp of that announcement (ignored for NO)
    /// @param evidence      hash of the notice (id + title) the resolver relied on
    function propose(uint256 id, bool yes, uint64 announcedAt, bytes32 evidence) external {
        if (!isResolver[msg.sender]) revert NotResolver();
        Market storage m = _markets[id];
        if (m.status != Status.Open) revert NotOpen();
        if (yes) {
            if (announcedAt > m.closesAt || announcedAt > block.timestamp) revert BadProposal();
            if (announcedAt < m.createdAt) {
                // Listed before the market existed: the question was never open.
                _void(id, "announced before market creation");
                return;
            }
        } else {
            if (block.timestamp < m.closesAt) revert BadProposal();
            announcedAt = m.closesAt;
        }
        m.yes = yes;
        m.announcedAt = announcedAt;
        m.evidence = evidence;
        m.proposedAt = uint64(block.timestamp);
        m.status = Status.Proposed;
        emit Proposed(id, yes, announcedAt, evidence);
    }

    function dispute(uint256 id) external nonReentrant {
        Market storage m = _markets[id];
        if (m.status != Status.Proposed) revert NotProposed();
        if (block.timestamp >= m.proposedAt + challengeWindow) revert WindowClosed();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        m.status = Status.Disputed;
        m.disputer = msg.sender;
        token.safeTransferFrom(msg.sender, address(this), disputeBond);
        emit Disputed(id, msg.sender);
    }

    function finalize(uint256 id) external {
        Market storage m = _markets[id];
        if (m.status != Status.Proposed) revert NotProposed();
        if (block.timestamp < m.proposedAt + challengeWindow) revert WindowOpen();
        _resolve(id);
    }

    /// @notice Owner decides a disputed market. A disputer who was right gets the bond back;
    ///         otherwise the bond goes to the treasury.
    function arbitrate(uint256 id, bool yes, uint64 announcedAt, bool voidIt) external onlyOwner nonReentrant {
        Market storage m = _markets[id];
        if (m.status != Status.Disputed) revert NotDisputed();
        bool disputerRight = voidIt || yes != m.yes || (yes && announcedAt != m.announcedAt);
        address disputer = m.disputer;
        if (disputerRight) token.safeTransfer(disputer, disputeBond);
        else treasuryAccrued += disputeBond;

        if (voidIt) {
            _void(id, "voided by arbitration");
            return;
        }
        if (yes && announcedAt > m.closesAt) revert BadProposal();
        if (yes && announcedAt < m.createdAt) {
            _void(id, "announced before market creation");
            return;
        }
        m.yes = yes;
        m.announcedAt = yes ? announcedAt : m.closesAt;
        _resolve(id);
    }

    /// @notice Emergency exit (e.g. Upbit cancels a listing it announced): every stake is refunded.
    function voidMarket(uint256 id, string calldata reason) external onlyOwner nonReentrant {
        Market storage m = _markets[id];
        if (m.status == Status.Resolved || m.status == Status.Voided) revert NotOpen();
        if (m.status == Status.Disputed) token.safeTransfer(m.disputer, disputeBond);
        _void(id, reason);
    }

    // ───────────────────────────────── claims ────────────────────────────────

    function claim(uint256 id) external nonReentrant {
        uint256 payout = claimable(id, msg.sender);
        if (claimed[id][msg.sender]) revert AlreadyClaimed();
        if (payout == 0) revert NothingToClaim();
        claimed[id][msg.sender] = true;
        token.safeTransfer(msg.sender, payout);
        emit Claimed(id, msg.sender, payout);
    }

    function claimable(uint256 id, address user) public view returns (uint256 payout) {
        Market storage m = _markets[id];
        if (claimed[id][user]) return 0;
        if (m.status == Status.Voided) return staked[id][user];
        if (m.status != Status.Resolved) return 0;
        uint256 cutoff = m.announcedAt;
        uint256 winStake;
        Bet[] storage bs = _bets[id][user];
        for (uint256 i; i < bs.length; ++i) {
            Bet storage b = bs[i];
            if (b.at >= cutoff) payout += b.amount; // late: refund
            else if (b.yes == m.yes) winStake += b.amount;
        }
        if (winStake != 0) {
            uint256 winPool = m.yes ? m.effYes : m.effNo;
            uint256 losePool = (m.yes ? m.effNo : m.effYes) - m.fee;
            payout += winStake + (winStake * losePool) / winPool;
        }
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function market(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    function betsOf(uint256 id, address user) external view returns (Bet[] memory) {
        return _bets[id][user];
    }

    function history(uint256 id) external view returns (Checkpoint[] memory) {
        return _history[id];
    }

    /// @notice Pool totals counting only bets placed strictly before `t`.
    function poolsBefore(uint256 id, uint64 t) public view returns (uint128 yesCum, uint128 noCum) {
        Checkpoint[] storage h = _history[id];
        uint256 lo;
        uint256 hi = h.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (h[mid].at < t) lo = mid + 1;
            else hi = mid;
        }
        if (lo == 0) return (0, 0);
        Checkpoint storage c = h[lo - 1];
        return (c.yesCum, c.noCum);
    }

    // ──────────────────────────────── internal ───────────────────────────────

    function _resolve(uint256 id) private {
        Market storage m = _markets[id];
        (uint128 y, uint128 n) = poolsBefore(id, m.announcedAt);
        if (y == 0 || n == 0) {
            _void(id, "one side empty at cutoff");
            return;
        }
        m.effYes = y;
        m.effNo = n;
        uint256 fee = (uint256(m.yes ? n : y) * feeBps) / 10_000;
        m.fee = uint128(fee);
        treasuryAccrued += fee;
        m.status = Status.Resolved;
        emit Resolved(id, m.yes, m.announcedAt, y, n, fee);
    }

    function _void(uint256 id, string memory reason) private {
        _markets[id].status = Status.Voided;
        emit Voided(id, reason);
    }

    function _setParams(address treasury_, uint16 feeBps_, uint64 window_, uint128 bond_) private {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS || window_ == 0) revert BadParams();
        treasury = treasury_;
        feeBps = feeBps_;
        challengeWindow = window_;
        disputeBond = bond_;
        emit ParamsSet(treasury_, feeBps_, window_, bond_);
    }
}
