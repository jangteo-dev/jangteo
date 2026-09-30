// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";
import {YutBoard} from "./YutBoard.sol";

/// @title YutGame — 윷놀이 for two verified players, four 말 each, for a stake.
///
/// @notice Rules: 도 1, 개 2, 걸 3, 윷 4, 모 5, 빽도 one step back. 윷 and 모 earn another throw.
///         Throws are collected, then spent one by one on any piece. Own pieces sharing a station
///         move together (업기). Landing on the opponent sends their pieces back (잡기) and earns
///         another throw. First to bring all four pieces home takes the pot, less the fee.
///
///  Randomness, with no oracle: each player commits the tip of a secret hash chain when they sit
///  down. Every throw reveals the next link (its hash must equal the previous link), and the
///  outcome is keccak(link, blockhash(block after the previous action)). The opponent cannot know
///  the link, nobody knows that blockhash when the previous action is sent, and the thrower cannot
///  change either: the only choice left is not throwing, which loses on time.
contract YutGame is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Playing,
        Done,
        Cancelled
    }

    enum Phase {
        Throwing,
        Moving
    }

    uint8 public constant PIECES = 4;
    uint8 public constant MAX_PENDING = 8;
    uint16 public constant CHAIN_LENGTH = 256;
    uint16 public constant MAX_FEE_BPS = 1_000;
    /// @dev blockhash is only readable for 256 blocks; throws must land well inside that.
    uint64 public constant MAX_THROW_DELAY_BLOCKS = 240;
    /// @dev `turn` before the opener is known: it is fixed by the block after the join.
    uint8 internal constant UNDECIDED = 2;

    struct Game {
        address[2] players;
        uint128 stake;
        Status status;
        uint8 turn;
        Phase phase;
        uint8 extra;
        uint8 pendingCount;
        uint64 deadline;
        uint64 lastBlock;
        address winner;
        uint16 feeBps;
        bytes32[2] link;
        bytes32[2] salt;
        uint16[2] throws;
        int8[8] pending;
        uint8[8] pos; // pieces 0‥3 belong to player 0, 4‥7 to player 1
        uint8[8] route;
    }

    IERC20 public immutable token;
    IIdentityGate public gate;
    address public treasury;
    uint16 public feeBps;
    uint64 public actionTime;
    uint128 public minStake;
    uint256 public feesAccrued;

    Game[] private _games;
    mapping(address => uint256) public claimable;

    event Created(uint256 indexed id, address indexed creator, uint256 stake);
    event Joined(uint256 indexed id, address indexed player, uint8 firstTurn);
    event Thrown(uint256 indexed id, uint8 indexed player, int8 value, uint16 throwNo);
    event Moved(uint256 indexed id, uint8 indexed player, uint8 piece, int8 value, uint8 from, uint8 to, uint8 captured);
    event Passed(uint256 indexed id, uint8 indexed player, int8 value);
    event TurnChanged(uint256 indexed id, uint8 turn);
    event Finished(uint256 indexed id, address indexed winner, uint256 payout, uint256 fee, uint8 reason);
    event Cancelled(uint256 indexed id);
    event Claimed(address indexed who, uint256 amount);
    event FeesSwept(address indexed treasury, uint256 amount);

    error NotEligible();
    error BadStake();
    error BadCommit();
    error WrongStatus();
    error NotYourTurn();
    error WrongPhase();
    error TooSoon();
    error TooLate();
    error BadReveal();
    error BadPiece();
    error BadThrow();
    error HasLegalMove();
    error NotTimedOut();
    error NotPlayer();
    error NothingToClaim();
    error BadParams();

    constructor(address owner_, IERC20 token_, IIdentityGate gate_, address treasury_, uint16 feeBps_, uint64 actionTime_, uint128 minStake_)
        Ownable(owner_)
    {
        token = token_;
        gate = gate_;
        _setParams(treasury_, feeBps_, actionTime_, minStake_);
    }

    // ───────────────────────────────── admin ─────────────────────────────────

    function setParams(address treasury_, uint16 feeBps_, uint64 actionTime_, uint128 minStake_) external onlyOwner {
        _setParams(treasury_, feeBps_, actionTime_, minStake_);
    }

    function setGate(IIdentityGate gate_) external onlyOwner {
        gate = gate_;
    }

    function sweepFees() external nonReentrant {
        uint256 amt = feesAccrued;
        if (amt == 0) revert NothingToClaim();
        feesAccrued = 0;
        token.safeTransfer(treasury, amt);
        emit FeesSwept(treasury, amt);
    }

    // ─────────────────────────────── lobby ──────────────────────────────────

    /// @param tip   H^256(secret): the end of the creator's hash chain
    /// @param salt  public salt the client used to derive the secret (lets a wallet re-derive it)
    function create(uint128 stake, bytes32 tip, bytes32 salt) external nonReentrant returns (uint256 id) {
        if (stake < minStake) revert BadStake();
        if (tip == bytes32(0)) revert BadCommit();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        id = _games.length;
        Game storage g = _games.push();
        g.players[0] = msg.sender;
        g.stake = stake;
        g.status = Status.Open;
        g.link[0] = tip;
        g.salt[0] = salt;
        g.feeBps = feeBps;
        for (uint256 i; i < 8; ++i) {
            g.pos[i] = YutBoard.OFF;
        }
        token.safeTransferFrom(msg.sender, address(this), stake);
        emit Created(id, msg.sender, stake);
    }

    function join(uint256 id, bytes32 tip, bytes32 salt) external nonReentrant {
        Game storage g = _games[id];
        if (g.status != Status.Open) revert WrongStatus();
        if (msg.sender == g.players[0]) revert NotPlayer();
        if (tip == bytes32(0)) revert BadCommit();
        if (!gate.isEligible(msg.sender)) revert NotEligible();
        g.players[1] = msg.sender;
        g.link[1] = tip;
        g.salt[1] = salt;
        g.status = Status.Playing;
        // Who opens is fixed by the hash of the block *after* this join, mixed with both players'
        // commitments. Nobody knows that hash when they sign, so the joiner cannot pick a tip that
        // makes them start (the previous blockhash could be ground against; this one cannot).
        g.turn = UNDECIDED;
        g.phase = Phase.Throwing;
        _touch(g);
        token.safeTransferFrom(msg.sender, address(this), g.stake);
        emit Joined(id, msg.sender, UNDECIDED);
    }

    function cancel(uint256 id) external nonReentrant {
        Game storage g = _games[id];
        if (g.status != Status.Open) revert WrongStatus();
        if (msg.sender != g.players[0]) revert NotPlayer();
        g.status = Status.Cancelled;
        claimable[g.players[0]] += g.stake;
        emit Cancelled(id);
    }

    // ──────────────────────────────── play ──────────────────────────────────

    /// @param link  the next link of the caller's hash chain: keccak256(link) must equal the last one
    function throwSticks(uint256 id, bytes32 link) external {
        Game storage g = _games[id];
        uint8 me = _mover(id, g);
        if (g.phase != Phase.Throwing) revert WrongPhase();
        if (block.number < g.lastBlock + 2) revert TooSoon();
        if (block.number > g.lastBlock + MAX_THROW_DELAY_BLOCKS) revert TooLate();
        if (keccak256(abi.encodePacked(link)) != g.link[me]) revert BadReveal();
        g.link[me] = link;
        g.throws[me] += 1;

        int8 v = YutBoard.throwValue(uint256(keccak256(abi.encodePacked(link, blockhash(g.lastBlock + 1)))));
        emit Thrown(id, me, v, g.throws[me]);

        // 빽도 with nothing on the board can never be played: it is simply lost.
        if (v < 0 && !_anyOnBoard(g, me)) {
            emit Passed(id, me, v);
        } else {
            g.pending[g.pendingCount++] = v;
        }
        bool again = (v == 4 || v == 5) && g.pendingCount < MAX_PENDING;
        if (!again) {
            if (g.pendingCount == 0) _afterMoves(id, g);
            else g.phase = Phase.Moving;
        }
        _touch(g);
    }

    /// @notice Spend pending throw `slot` on piece `piece` (0‥3, the caller's own pieces).
    function move(uint256 id, uint8 slot, uint8 piece) external {
        Game storage g = _games[id];
        uint8 me = _mover(id, g);
        if (g.phase != Phase.Moving) revert WrongPhase();
        if (slot >= g.pendingCount) revert BadThrow();
        if (piece >= PIECES) revert BadPiece();
        int8 v = g.pending[slot];
        uint8 idx = me * PIECES + piece;
        uint8 from = g.pos[idx];
        if (from == YutBoard.HOME) revert BadPiece();
        if (v < 0 && !YutBoard.onBoard(from)) revert BadPiece();

        (uint8 to, uint8 route) = YutBoard.advance(from, g.route[idx], v);

        // 업기: every own piece on the same station travels with this one.
        uint8 base = me * PIECES;
        for (uint8 i = base; i < base + PIECES; ++i) {
            if (i == idx || (YutBoard.onBoard(from) && g.pos[i] == from)) {
                g.pos[i] = to;
                g.route[i] = route;
            }
        }

        // 잡기: land on the opponent and their pieces there go back to the start.
        uint8 captured;
        if (YutBoard.onBoard(to)) {
            uint8 obase = (1 - me) * PIECES;
            for (uint8 i = obase; i < obase + PIECES; ++i) {
                if (g.pos[i] == to) {
                    g.pos[i] = YutBoard.OFF;
                    g.route[i] = YutBoard.OUTER;
                    ++captured;
                }
            }
            if (captured != 0) g.extra += 1;
        }
        _removePending(g, slot);
        emit Moved(id, me, piece, v, from, to, captured);

        if (_allHome(g, me)) {
            _finish(id, g, me, 0);
            return;
        }
        if (g.pendingCount == 0) _afterMoves(id, g);
        _touch(g);
    }

    /// @notice Drop a pending throw that has no legal move (a 빽도 with every piece off the board).
    function pass(uint256 id, uint8 slot) external {
        Game storage g = _games[id];
        uint8 me = _mover(id, g);
        if (g.phase != Phase.Moving) revert WrongPhase();
        if (slot >= g.pendingCount) revert BadThrow();
        int8 v = g.pending[slot];
        if (v > 0 || _anyOnBoard(g, me)) revert HasLegalMove();
        _removePending(g, slot);
        emit Passed(id, me, v);
        if (g.pendingCount == 0) _afterMoves(id, g);
        _touch(g);
    }

    function resign(uint256 id) external nonReentrant {
        Game storage g = _games[id];
        if (g.status != Status.Playing) revert WrongStatus();
        uint8 who;
        if (msg.sender == g.players[0]) who = 0;
        else if (msg.sender == g.players[1]) who = 1;
        else revert NotPlayer();
        _finish(id, g, 1 - who, 2);
    }

    /// @notice The player to move ran out of time: the other player wins. Anyone may call.
    function claimTimeout(uint256 id) external nonReentrant {
        Game storage g = _games[id];
        if (g.status != Status.Playing) revert WrongStatus();
        if (block.timestamp <= g.deadline) revert NotTimedOut();
        _decide(id, g);
        _finish(id, g, 1 - g.turn, 1);
    }

    function claim() external nonReentrant {
        uint256 amt = claimable[msg.sender];
        if (amt == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        token.safeTransfer(msg.sender, amt);
        emit Claimed(msg.sender, amt);
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function gameCount() external view returns (uint256) {
        return _games.length;
    }

    /// @notice The game as stored, with the opener filled in as soon as it is determined (from
    ///         the block after the join), so readers never see the internal "undecided" value
    ///         except in the join block itself.
    function game(uint256 id) external view returns (Game memory g) {
        g = _games[id];
        if (g.turn == UNDECIDED) {
            (bool ok, uint8 t) = _opener(g);
            if (ok) g.turn = t;
        }
    }

    /// @notice Settle who opens a freshly joined game (anyone may call; the first throw does it too).
    function decideOpener(uint256 id) external {
        _decide(id, _games[id]);
    }

    /// @notice Where `piece` of `player` would land with pending throw `slot`, for move previews.
    function preview(uint256 id, uint8 player, uint8 slot, uint8 piece) external view returns (uint8 to) {
        Game storage g = _games[id];
        uint8 idx = player * PIECES + piece;
        (to,) = YutBoard.advance(g.pos[idx], g.route[idx], g.pending[slot]);
    }

    // ──────────────────────────────── internal ───────────────────────────────

    /// @dev Opener = hash(both commitments, hash of the block after the join) mod 2. `lastBlock` is
    ///      still the join block until the first throw, which cannot land before join + 2.
    function _opener(Game memory g) private view returns (bool ok, uint8 t) {
        if (block.number <= g.lastBlock + 1) return (false, 0);
        bytes32 h = blockhash(g.lastBlock + 1);
        if (h == bytes32(0)) {
            // Nobody acted for 256 blocks: fall back to the latest hash (the game is timed out by then anyway).
            h = blockhash(block.number - 1);
        }
        return (true, uint8(uint256(keccak256(abi.encode(g.link[0], g.link[1], h))) % 2));
    }

    function _decide(uint256 id, Game storage g) private {
        if (g.turn != UNDECIDED || g.status != Status.Playing) return;
        (bool ok, uint8 t) = _opener(g);
        if (!ok) revert TooSoon();
        g.turn = t;
        emit TurnChanged(id, t);
    }

    function _mover(uint256 id, Game storage g) private returns (uint8 me) {
        if (g.status != Status.Playing) revert WrongStatus();
        _decide(id, g);
        me = g.turn;
        if (msg.sender != g.players[me]) revert NotYourTurn();
        if (block.timestamp > g.deadline) revert TooLate();
    }

    function _touch(Game storage g) private {
        g.lastBlock = uint64(block.number);
        g.deadline = uint64(block.timestamp) + actionTime;
    }

    /// @dev All pending throws are spent: a capture earns one more throw, otherwise the turn passes.
    function _afterMoves(uint256 id, Game storage g) private {
        g.phase = Phase.Throwing;
        if (g.extra != 0) {
            g.extra -= 1;
            return;
        }
        g.turn = 1 - g.turn;
        emit TurnChanged(id, g.turn);
    }

    function _removePending(Game storage g, uint8 slot) private {
        uint8 n = g.pendingCount;
        for (uint8 i = slot; i + 1 < n; ++i) {
            g.pending[i] = g.pending[i + 1];
        }
        g.pending[n - 1] = 0;
        g.pendingCount = n - 1;
    }

    function _anyOnBoard(Game storage g, uint8 player) private view returns (bool) {
        uint8 base = player * PIECES;
        for (uint8 i = base; i < base + PIECES; ++i) {
            if (YutBoard.onBoard(g.pos[i])) return true;
        }
        return false;
    }

    function _allHome(Game storage g, uint8 player) private view returns (bool) {
        uint8 base = player * PIECES;
        for (uint8 i = base; i < base + PIECES; ++i) {
            if (g.pos[i] != YutBoard.HOME) return false;
        }
        return true;
    }

    /// @param reason 0 all pieces home, 1 opponent timed out, 2 opponent resigned
    function _finish(uint256 id, Game storage g, uint8 winnerIdx, uint8 reason) private {
        g.status = Status.Done;
        address w = g.players[winnerIdx];
        g.winner = w;
        uint256 pot = uint256(g.stake) * 2;
        uint256 fee = pot * g.feeBps / 10_000;
        feesAccrued += fee;
        claimable[w] += pot - fee;
        emit Finished(id, w, pot - fee, fee, reason);
    }

    function _setParams(address treasury_, uint16 feeBps_, uint64 actionTime_, uint128 minStake_) private {
        // The throw window must close before blockhash(lastBlock + 1) expires (256 blocks).
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS || actionTime_ < 30 || actionTime_ > 200) revert BadParams();
        treasury = treasury_;
        feeBps = feeBps_;
        actionTime = actionTime_;
        minStake = minStake_;
    }
}
