// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IGyeReputation, IIdentityGate} from "./interfaces/IGye.sol";

/// @title GyeCircle — one 계 (gye), a rotating savings and credit circle.
///
/// @notice Every round each member pays `contribution`; one member takes the pot.
///
///   Ordered  (번호계)  pot goes by join order.
///   Random   (추첨계)  pot goes to a random member who paid this round.
///   Auction  (낙찰계)  members bid the discount they accept to take the pot now; the
///                      discount is shared by everyone else who paid, so it acts as interest.
///
///  How the circle protects the members who keep paying:
///   1. Only accounts with a Dojang Verified Address (a KYC-verified Upbit identity) may join, and
///      defaults are written permanently to that identity's on-chain record.
///   2. Each member posts one contribution as collateral.
///   3. A winner who still owes future rounds gets part of the pot held back in escrow. How much
///      depends on their gye history: newcomers are 100% secured, and only credit proven in
///      earlier circles can be advanced (see GyeReputation).
///   4. A missed payment is covered from the payer's escrow first. Any uncovered amount becomes
///      that member's debt and an IOU to the round's winner. A member who has not received yet
///      pays the debt out of their own future pot, so these debts settle themselves.
///
///  Platform fee: `feeBps` of every pot, fixed when the circle is created, is set aside for the
///  treasury and swept out with `sweepFees`.
///
///  Accounting invariant: token balance == sum(escrow) + sum(claimable) + roundCollected + feesAccrued,
///  and sum(debt) == sum(owed).
contract GyeCircle is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Mode {
        Ordered,
        Random,
        Auction
    }

    enum Phase {
        None,
        Filling,
        Active,
        Completed,
        Cancelled
    }

    struct Config {
        IERC20 token;
        uint128 contribution;
        uint8 size;
        Mode mode;
        uint32 roundDuration;
        uint16 maxDiscountBps;
        uint64 fillDeadline;
        bytes32 name;
    }

    struct Member {
        bool exists;
        bool received;
        bool defaulted;
        uint8 receivedRound;
        uint16 holdbackBps;
        uint16 missed;
        uint64 paidMask;
        uint128 escrow;
        uint128 debt;
        uint128 owed;
        uint128 claimable;
        uint128 creditUsd;
    }

    struct Snapshot {
        Phase phase;
        Config config;
        address creator;
        uint8 round;
        uint8 memberCount;
        uint64 roundStart;
        uint64 deadline;
        uint128 roundCollected;
        address bestBidder;
        uint128 bestBid;
        uint256 usdPerUnitWad;
        uint16 feeBps;
    }

    uint256 public constant MAX_SIZE = 50;
    uint256 private constant BPS = 10_000;

    address public factory;
    address public creator;
    IGyeReputation public reputation;
    IIdentityGate public gate;
    uint256 public usdPerUnitWad;
    uint16 public feeBps;
    address public treasury;
    uint256 public feesAccrued;

    Config private _cfg;
    Phase public phase;
    uint8 public round;
    uint64 public roundStart;
    uint128 public roundCollected;
    address public bestBidder;
    uint128 public bestBid;

    address[] private _members;
    mapping(address => Member) private _m;

    address[] private _creditors;
    uint256 private _creditorCursor;

    event Joined(address indexed member, uint16 holdbackBps);
    event Left(address indexed member);
    event Activated(uint64 at);
    event Contributed(address indexed member, uint8 indexed round, uint256 amount);
    event BidPlaced(address indexed member, uint8 indexed round, uint256 discount);
    event Covered(address indexed member, uint8 indexed round, uint256 fromEscrow, uint256 uncovered);
    event Defaulted(address indexed member, uint8 indexed round, uint256 lossTokens);
    event Settled(
        uint8 indexed round,
        address indexed winner,
        uint256 gross,
        uint256 discount,
        uint256 holdback,
        uint256 net,
        uint256 shortfall
    );
    event DebtRepaid(address indexed member, uint256 amount);
    event CreditorPaid(address indexed creditor, uint256 amount);
    event Claimed(address indexed member, uint256 amount);
    event Completed(uint64 at);
    event Cancelled(uint64 at);
    event FeeTaken(uint8 indexed round, uint256 amount);
    event FeesSwept(address indexed treasury, uint256 amount);

    error AlreadyInitialized();
    error NotFactory();
    error WrongPhase();
    error NotMember();
    error AlreadyMember();
    error NotEligible();
    error ReputationBlocked();
    error FillClosed();
    error FillOpen();
    error AlreadyPaid();
    error RoundOpen();
    error RoundClosed();
    error NotAuction();
    error CannotBid();
    error BidTooLow();
    error BidTooHigh();
    error BadAmount();
    error NothingToClaim();

    // ─────────────────────────────── lifecycle ───────────────────────────────

    function initialize(
        Config calldata cfg,
        address creator_,
        IGyeReputation reputation_,
        IIdentityGate gate_,
        uint256 usdPerUnitWad_,
        uint16 feeBps_,
        address treasury_
    ) external {
        if (factory != address(0)) revert AlreadyInitialized();
        factory = msg.sender;
        creator = creator_;
        reputation = reputation_;
        gate = gate_;
        usdPerUnitWad = usdPerUnitWad_;
        feeBps = feeBps_;
        treasury = treasury_;
        _cfg = cfg;
        phase = Phase.Filling;
    }

    function join() external nonReentrant {
        _join(msg.sender, msg.sender);
    }

    /// @dev The factory has already pulled the collateral from `account` into this circle.
    function joinFor(address account) external nonReentrant {
        if (msg.sender != factory) revert NotFactory();
        _join(account, address(0));
    }

    function leave() external nonReentrant {
        if (phase != Phase.Filling) revert WrongPhase();
        Member storage m = _m[msg.sender];
        if (!m.exists) revert NotMember();
        uint256 refund = m.escrow;
        _removeMember(msg.sender);
        reputation.onLeave(msg.sender);
        _cfg.token.safeTransfer(msg.sender, refund);
        emit Left(msg.sender);
    }

    /// @notice Anyone may cancel a circle that did not fill before its deadline.
    ///         Collateral becomes claimable.
    function cancel() external nonReentrant {
        if (phase != Phase.Filling) revert WrongPhase();
        if (block.timestamp <= _cfg.fillDeadline) revert FillOpen();
        phase = Phase.Cancelled;
        uint256 n = _members.length;
        for (uint256 i; i < n; ++i) {
            address a = _members[i];
            Member storage m = _m[a];
            m.claimable += m.escrow;
            m.escrow = 0;
            reputation.onLeave(a);
        }
        emit Cancelled(uint64(block.timestamp));
    }

    // ──────────────────────────────── rounds ─────────────────────────────────

    function contribute() external nonReentrant {
        if (phase != Phase.Active) revert WrongPhase();
        Member storage m = _m[msg.sender];
        if (!m.exists) revert NotMember();
        uint64 bit = uint64(1) << (round - 1);
        if (m.paidMask & bit != 0) revert AlreadyPaid();
        m.paidMask |= bit;
        uint128 c = _cfg.contribution;
        roundCollected += c;
        _cfg.token.safeTransferFrom(msg.sender, address(this), c);
        emit Contributed(msg.sender, round, c);
    }

    /// @notice Auction mode: offer `discount` (token units) off the pot to receive it this round.
    function bid(uint128 discount) external {
        if (phase != Phase.Active) revert WrongPhase();
        if (_cfg.mode != Mode.Auction) revert NotAuction();
        if (block.timestamp >= deadline()) revert RoundClosed();
        Member storage m = _m[msg.sender];
        if (!m.exists || m.received || m.defaulted) revert CannotBid();
        if (m.paidMask & (uint64(1) << (round - 1)) == 0) revert CannotBid();
        if (discount <= bestBid) revert BidTooLow();
        if (discount > pot() * _cfg.maxDiscountBps / BPS) revert BidTooHigh();
        bestBid = discount;
        bestBidder = msg.sender;
        emit BidPlaced(msg.sender, round, discount);
    }

    /// @notice Close the current round. Anyone may call once the deadline has passed.
    function settle() external nonReentrant {
        if (phase != Phase.Active) revert WrongPhase();
        if (block.timestamp < deadline()) revert RoundOpen();

        uint8 r = round;
        uint64 bit = uint64(1) << (r - 1);
        uint256 c = _cfg.contribution;
        uint256 collected = roundCollected;
        uint256 shortfall;

        uint256 n = _members.length;
        for (uint256 i; i < n; ++i) {
            address a = _members[i];
            Member storage m = _m[a];
            if (m.paidMask & bit != 0) continue;
            uint256 fromEscrow = m.escrow < c ? m.escrow : c;
            m.escrow -= uint128(fromEscrow);
            collected += fromEscrow;
            uint256 uncovered = c - fromEscrow;
            m.missed += 1;
            if (uncovered != 0) {
                m.debt += uint128(uncovered);
                shortfall += uncovered;
                if (m.received && !m.defaulted) {
                    m.defaulted = true;
                    uint256 loss = uncovered + (_cfg.size - r) * c;
                    reputation.onDefault(a, _toUsd(loss));
                    emit Defaulted(a, r, loss);
                }
            }
            emit Covered(a, r, fromEscrow, uncovered);
        }

        address winner = _pickWinner(r, bit);
        Member storage w = _m[winner];

        uint256 fee = collected * feeBps / BPS;
        if (fee != 0) {
            feesAccrued += fee;
            emit FeeTaken(r, fee);
        }
        uint256 afterFee = collected - fee;
        uint256 discount = winner == bestBidder ? bestBid : 0;
        if (discount > afterFee) discount = afterFee;
        uint256 net = afterFee - discount;
        if (discount != 0) net += _shareDiscount(discount, winner, bit);

        // The round's shortfall becomes an IOU to the winner. It is recorded before the winner's
        // own debt is netted, so sum(debt) == sum(owed) always holds.
        if (shortfall != 0) {
            w.owed += uint128(shortfall);
            _creditors.push(winner);
        }
        if (w.debt != 0) {
            uint256 repay = w.debt < net ? w.debt : net;
            w.debt -= uint128(repay);
            net -= repay;
            _payCreditors(repay);
            emit DebtRepaid(winner, repay);
        }

        uint256 hold = _holdback(winner, w, r, c, net);
        w.escrow += uint128(hold);
        net -= hold;

        w.claimable += uint128(net);
        w.received = true;
        w.receivedRound = r;

        emit Settled(r, winner, collected, discount, hold, net, shortfall);

        roundCollected = 0;
        bestBid = 0;
        bestBidder = address(0);
        if (r == _cfg.size) {
            _complete();
        } else {
            round = r + 1;
            roundStart = uint64(block.timestamp);
        }
    }

    /// @notice Pay back debt from missed rounds; the payment goes straight to the IOU holders.
    function repayDebt(uint128 amount) external nonReentrant {
        Member storage m = _m[msg.sender];
        if (!m.exists) revert NotMember();
        if (amount == 0 || amount > m.debt) revert BadAmount();
        m.debt -= amount;
        _cfg.token.safeTransferFrom(msg.sender, address(this), amount);
        _payCreditors(amount);
        emit DebtRepaid(msg.sender, amount);
    }

    /// @notice Sends collected platform fees to the treasury. Anyone may call it.
    function sweepFees() external nonReentrant {
        uint256 amount = feesAccrued;
        if (amount == 0) revert NothingToClaim();
        feesAccrued = 0;
        _cfg.token.safeTransfer(treasury, amount);
        emit FeesSwept(treasury, amount);
    }

    function claim() external nonReentrant {
        Member storage m = _m[msg.sender];
        uint256 amount = m.claimable;
        if (amount == 0) revert NothingToClaim();
        m.claimable = 0;
        _cfg.token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function config() external view returns (Config memory) {
        return _cfg;
    }

    function members() external view returns (address[] memory) {
        return _members;
    }

    function memberOf(address account) external view returns (Member memory) {
        return _m[account];
    }

    function pot() public view returns (uint256) {
        return uint256(_cfg.contribution) * _cfg.size;
    }

    function deadline() public view returns (uint64) {
        return roundStart + _cfg.roundDuration;
    }

    function hasPaid(address account) external view returns (bool) {
        if (round == 0) return false;
        return _m[account].paidMask & (uint64(1) << (round - 1)) != 0;
    }

    function settleable() external view returns (bool) {
        return phase == Phase.Active && block.timestamp >= deadline();
    }

    function snapshot() external view returns (Snapshot memory s) {
        s.phase = phase;
        s.config = _cfg;
        s.creator = creator;
        s.round = round;
        s.memberCount = uint8(_members.length);
        s.roundStart = roundStart;
        s.deadline = round == 0 ? 0 : deadline();
        s.roundCollected = roundCollected;
        s.bestBidder = bestBidder;
        s.bestBid = bestBid;
        s.usdPerUnitWad = usdPerUnitWad;
        s.feeBps = feeBps;
    }

    // ──────────────────────────────── internal ───────────────────────────────

    function _join(address account, address payer) private {
        if (phase != Phase.Filling) revert WrongPhase();
        if (block.timestamp > _cfg.fillDeadline) revert FillClosed();
        Member storage m = _m[account];
        if (m.exists) revert AlreadyMember();
        if (!gate.isEligible(account)) revert NotEligible();
        if (!reputation.canJoin(account)) revert ReputationBlocked();

        uint128 collateral = _cfg.contribution;
        m.exists = true;
        m.escrow = collateral;
        m.holdbackBps = reputation.holdbackBps(account);
        _members.push(account);
        reputation.onJoin(account);
        if (payer != address(0)) _cfg.token.safeTransferFrom(payer, address(this), collateral);
        emit Joined(account, m.holdbackBps);

        if (_members.length == _cfg.size) {
            phase = Phase.Active;
            round = 1;
            roundStart = uint64(block.timestamp);
            emit Activated(uint64(block.timestamp));
        }
    }

    /// @dev Removes a member while keeping join order, which is the Ordered-mode queue.
    function _removeMember(address account) private {
        uint256 n = _members.length;
        for (uint256 i; i < n; ++i) {
            if (_members[i] == account) {
                for (uint256 j = i; j + 1 < n; ++j) {
                    _members[j] = _members[j + 1];
                }
                _members.pop();
                break;
            }
        }
        delete _m[account];
    }

    function _pickWinner(uint8 r, uint64 bit) private view returns (address) {
        if (_cfg.mode == Mode.Auction && bestBidder != address(0)) return bestBidder;

        // Candidates: members who have not received the pot, preferring those who paid this round.
        // Only members who already received can default, so a candidate always exists
        // (round r always has size - r + 1 members who have not received).
        uint256 n = _members.length;
        address[] memory pool = new address[](n);
        uint256 k;
        for (uint256 pass; pass < 2 && k == 0; ++pass) {
            for (uint256 i; i < n; ++i) {
                Member storage m = _m[_members[i]];
                if (m.received || m.defaulted) continue;
                if (pass == 0 && m.paidMask & bit == 0) continue;
                pool[k++] = _members[i];
            }
        }
        if (_cfg.mode == Mode.Ordered) return pool[0];
        // L2 randomness: the sequencer could bias this. That is acceptable for a savings circle
        // where the prize equals your own future contributions; value-bearing lotteries would
        // need VRF.
        uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), address(this), r)));
        return pool[seed % k];
    }

    function _shareDiscount(uint256 discount, address winner, uint64 bit) private returns (uint256 dust) {
        uint256 n = _members.length;
        uint256 k;
        for (uint256 i; i < n; ++i) {
            address a = _members[i];
            if (a != winner && _m[a].paidMask & bit != 0) ++k;
        }
        if (k == 0) return discount;
        uint256 each = discount / k;
        for (uint256 i; i < n; ++i) {
            address a = _members[i];
            if (a != winner && _m[a].paidMask & bit != 0) _m[a].claimable += uint128(each);
        }
        return discount - each * k;
    }

    /// @dev Hold back enough of the pot that the winner's remaining obligations are covered,
    ///      except for the part of those obligations the reputation layer vouches for.
    function _holdback(address winner, Member storage w, uint8 r, uint256 c, uint256 net)
        private
        returns (uint256 hold)
    {
        uint256 remaining = (uint256(_cfg.size) - r) * c;
        if (remaining == 0) return 0;
        uint256 tierCredit = remaining * (BPS - w.holdbackBps) / BPS;
        uint256 provenCredit = _fromUsd(reputation.availableCredit(winner));
        uint256 allowed = tierCredit < provenCredit ? tierCredit : provenCredit;
        uint256 target = remaining - allowed;
        hold = target > w.escrow ? target - w.escrow : 0;
        if (hold > net) hold = net;
        uint256 secured = uint256(w.escrow) + hold;
        if (remaining > secured) {
            uint256 usd = _toUsd(remaining - secured);
            w.creditUsd = uint128(usd);
            reputation.onCreditDrawn(winner, usd);
        }
    }

    function _payCreditors(uint256 amount) private {
        uint256 len = _creditors.length;
        uint256 cur = _creditorCursor;
        while (amount != 0 && cur < len) {
            address a = _creditors[cur];
            Member storage m = _m[a];
            uint256 pay = m.owed < amount ? m.owed : amount;
            m.owed -= uint128(pay);
            m.claimable += uint128(pay);
            amount -= pay;
            if (pay != 0) emit CreditorPaid(a, pay);
            if (m.owed == 0) ++cur;
        }
        _creditorCursor = cur;
    }

    function _complete() private {
        phase = Phase.Completed;
        uint256 c = _cfg.contribution;
        uint256 n = _members.length;
        for (uint256 i; i < n; ++i) {
            address a = _members[i];
            Member storage m = _m[a];
            if (m.debt != 0 && m.escrow != 0) {
                uint256 pay = m.debt < m.escrow ? m.debt : m.escrow;
                m.debt -= uint128(pay);
                m.escrow -= uint128(pay);
                _payCreditors(pay);
                emit DebtRepaid(a, pay);
            }
            m.claimable += m.escrow;
            m.escrow = 0;
            bool clean = !m.defaulted && m.missed == 0 && m.debt == 0;
            uint256 contributedUsd = _toUsd(_popcount(m.paidMask) * c);
            reputation.onFinish(a, clean, contributedUsd, m.creditUsd, m.missed);
        }
        emit Completed(uint64(block.timestamp));
    }

    function _toUsd(uint256 tokens) private view returns (uint256) {
        return tokens * usdPerUnitWad / 1e18;
    }

    function _fromUsd(uint256 usd) private view returns (uint256) {
        return usdPerUnitWad == 0 ? 0 : usd * 1e18 / usdPerUnitWad;
    }

    function _popcount(uint64 x) private pure returns (uint256 count) {
        while (x != 0) {
            x &= x - 1;
            ++count;
        }
    }
}
