// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title StockOracle — 장터 주식 prices, in test won per share.
/// @notice One reporter posts the price of every stock it can see trading, with whether its market
///         is open. The exchange only trades on a price that is fresh and open, so a market that
///         closes (or a reporter that stops) simply stops trading; no funds move here.
///
///         Guard: a post moving a price more than MAX_MOVE_BPS from a price under GUARD_WINDOW old is
///         rejected (Korean stocks move at most 30% a day). After a longer gap (overnight, weekend)
///         any price is accepted, since that is where real gaps happen.
contract StockOracle is Ownable2Step {
    struct Price {
        uint128 price; // tKRW wei per 1e18 share units
        uint64 updatedAt;
        bool open;
    }

    uint256 public constant MAX_MOVE_BPS = 3_000;
    uint256 public constant GUARD_WINDOW = 1 hours;
    uint256 public constant REPORTER_DELAY = 48 hours;

    address public reporter;
    address public pendingReporter;
    uint256 public pendingReporterAt;
    mapping(bytes32 => Price) private _prices;

    event Posted(bytes32 indexed sym, uint256 price, bool open);
    event Rejected(bytes32 indexed sym, uint256 price, uint256 last);
    event ReporterProposed(address reporter, uint256 activeAt);
    event ReporterSet(address reporter);

    error NotReporter();
    error BadParams();
    error TooEarly();

    constructor(address owner_, address reporter_) Ownable(owner_) {
        reporter = reporter_;
        emit ReporterSet(reporter_);
    }

    /// @notice Posts prices. A price the guard refuses is skipped (and logged), the rest still land,
    ///         so one bad quote never blocks the whole batch.
    function post(bytes32[] calldata syms, uint128[] calldata prices, bool[] calldata open) external {
        if (msg.sender != reporter) revert NotReporter();
        if (syms.length != prices.length || syms.length != open.length) revert BadParams();
        for (uint256 i; i < syms.length; ++i) {
            uint256 p = prices[i];
            if (p == 0) continue;
            Price storage cur = _prices[syms[i]];
            if (cur.price != 0 && block.timestamp - cur.updatedAt < GUARD_WINDOW) {
                uint256 last = cur.price;
                uint256 diff = p > last ? p - last : last - p;
                if (diff * 10_000 > last * MAX_MOVE_BPS) {
                    emit Rejected(syms[i], p, last);
                    continue;
                }
            }
            cur.price = prices[i];
            cur.updatedAt = uint64(block.timestamp);
            cur.open = open[i];
            emit Posted(syms[i], p, open[i]);
        }
    }

    function priceOf(bytes32 sym) external view returns (uint256 price, uint256 updatedAt, bool open) {
        Price memory x = _prices[sym];
        return (x.price, x.updatedAt, x.open);
    }

    // ─────────────────────────────── reporter ───────────────────────────────

    /// @notice A new reporter can post only after a 48 h delay, so a stolen owner key can't feed
    ///         prices at once.
    function proposeReporter(address r) external onlyOwner {
        if (r == address(0)) revert BadParams();
        pendingReporter = r;
        pendingReporterAt = block.timestamp + REPORTER_DELAY;
        emit ReporterProposed(r, pendingReporterAt);
    }

    function activateReporter() external onlyOwner {
        if (pendingReporter == address(0)) revert BadParams();
        if (block.timestamp < pendingReporterAt) revert TooEarly();
        reporter = pendingReporter;
        pendingReporter = address(0);
        emit ReporterSet(reporter);
    }

    /// @notice Instant: stops all posting, so trading stops as prices go stale.
    function removeReporter() external onlyOwner {
        reporter = address(0);
        emit ReporterSet(address(0));
    }
}
