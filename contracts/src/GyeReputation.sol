// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IEAS} from "./interfaces/IExternal.sol";
import {IGyeReputation} from "./interfaces/IGye.sol";

/// @title GyeReputation
/// @notice Credit history earned by finishing 계 (gye) circles.
///
///  Underwriting rule: a member may only be advanced money they have already proven they
///  repay. `provenUsd` grows with every contribution made in a circle that finished cleanly;
///  `creditInUse` is the unsecured part of pots currently paid out ahead of contributions.
///  The circle holds back the rest of the pot as escrow, so a brand-new identity is 100%
///  secured and cannot hurt anyone by vanishing.
///
///  Outcomes are also written as EAS attestations on GIWA, so any other dApp can read a
///  member's gye record next to their Dojang identity.
contract GyeReputation is IGyeReputation, Ownable2Step {
    uint8 public constant OUTCOME_CLEAN = 1;
    uint8 public constant OUTCOME_DEFAULT = 2;
    uint8 public constant OUTCOME_LATE = 3;

    uint8 public constant MAX_CONCURRENT = 5;

    struct Record {
        uint32 completed;
        uint32 late;
        uint32 defaults;
        uint16 active;
        uint128 provenUsd;
        uint128 creditInUse;
        uint128 lossUsd;
        bytes32 lastAttestation;
    }

    IEAS public immutable eas;
    bytes32 public schema;
    address public factory;

    mapping(address => Record) private _records;
    mapping(address => bool) public isCircle;

    event FactorySet(address factory);
    event SchemaSet(bytes32 schema);
    event CircleRegistered(address indexed circle);
    event Outcome(address indexed account, address indexed circle, uint8 outcome, uint256 usd, bytes32 attestation);
    event AttestationFailed(address indexed account, address indexed circle, uint8 outcome);

    error NotFactory();
    error NotCircle();
    error FactoryAlreadySet();

    modifier onlyCircle() {
        if (!isCircle[msg.sender]) revert NotCircle();
        _;
    }

    constructor(address owner_, IEAS eas_, bytes32 schema_) Ownable(owner_) {
        eas = eas_;
        schema = schema_;
    }

    // ───────────────────────────────── admin ─────────────────────────────────

    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        factory = factory_;
        emit FactorySet(factory_);
    }

    function setSchema(bytes32 schema_) external onlyOwner {
        schema = schema_;
        emit SchemaSet(schema_);
    }

    function registerCircle(address circle) external {
        if (msg.sender != factory) revert NotFactory();
        isCircle[circle] = true;
        emit CircleRegistered(circle);
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function recordOf(address account) external view returns (Record memory) {
        return _records[account];
    }

    function canJoin(address account) external view returns (bool) {
        Record storage r = _records[account];
        return r.defaults == 0 && r.active < maxConcurrent(account);
    }

    /// @notice New members may run one circle at a time; each clean finish unlocks one more.
    function maxConcurrent(address account) public view returns (uint16) {
        uint256 n = uint256(_records[account].completed) + 1;
        return uint16(n > MAX_CONCURRENT ? MAX_CONCURRENT : n);
    }

    /// @notice Share of a member's future obligations held back from their pot.
    function holdbackBps(address account) external view returns (uint16) {
        Record storage r = _records[account];
        if (r.defaults != 0) return 10_000;
        uint32 c = r.completed;
        if (c == 0) return 10_000;
        if (c == 1) return 8_000;
        if (c == 2) return 6_000;
        if (c == 3) return 4_000;
        if (c == 4) return 2_500;
        return 1_500;
    }

    function availableCredit(address account) external view returns (uint256) {
        Record storage r = _records[account];
        if (r.defaults != 0 || r.provenUsd <= r.creditInUse) return 0;
        return r.provenUsd - r.creditInUse;
    }

    // ───────────────────────────────── hooks ─────────────────────────────────

    function onJoin(address account) external onlyCircle {
        _records[account].active += 1;
    }

    function onLeave(address account) external onlyCircle {
        _records[account].active -= 1;
    }

    function onCreditDrawn(address account, uint256 usdAmount) external onlyCircle {
        _records[account].creditInUse += uint128(usdAmount);
    }

    function onDefault(address account, uint256 lossUsd) external onlyCircle {
        Record storage r = _records[account];
        r.defaults += 1;
        r.lossUsd += uint128(lossUsd);
        _attest(account, OUTCOME_DEFAULT, 0, lossUsd, 0);
    }

    function onFinish(address account, bool clean, uint256 contributedUsd, uint256 creditUsd, uint16 missed)
        external
        onlyCircle
    {
        Record storage r = _records[account];
        r.active -= 1;
        r.creditInUse = creditUsd >= r.creditInUse ? 0 : r.creditInUse - uint128(creditUsd);
        if (r.defaults != 0) return; // outcome already attested by onDefault
        if (clean) {
            r.completed += 1;
            r.provenUsd += uint128(contributedUsd);
            _attest(account, OUTCOME_CLEAN, contributedUsd, 0, 0);
        } else {
            r.late += 1;
            _attest(account, OUTCOME_LATE, contributedUsd, 0, missed);
        }
    }

    // ──────────────────────────────── internal ───────────────────────────────

    function _attest(address account, uint8 outcome, uint256 contributedUsd, uint256 lossUsd, uint16 missed)
        private
    {
        bytes32 uid;
        if (address(eas) != address(0) && schema != bytes32(0)) {
            IEAS.AttestationRequest memory req = IEAS.AttestationRequest({
                schema: schema,
                data: IEAS.AttestationRequestData({
                    recipient: account,
                    expirationTime: 0,
                    revocable: false,
                    refUID: bytes32(0),
                    data: abi.encode(msg.sender, outcome, contributedUsd, lossUsd, missed),
                    value: 0
                })
            });
            // Reputation bookkeeping must never be blocked by the attestation layer.
            try eas.attest(req) returns (bytes32 id) {
                uid = id;
                _records[account].lastAttestation = id;
            } catch {
                emit AttestationFailed(account, msg.sender, outcome);
            }
        }
        emit Outcome(account, msg.sender, outcome, outcome == OUTCOME_DEFAULT ? lossUsd : contributedUsd, uid);
    }
}
