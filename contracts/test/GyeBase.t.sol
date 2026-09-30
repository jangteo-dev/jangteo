// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GyeCircle} from "../src/GyeCircle.sol";
import {GyeFactory} from "../src/GyeFactory.sol";
import {GyeReputation} from "../src/GyeReputation.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll, IEAS} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll, MockEAS} from "./mocks/Mocks.sol";

abstract contract GyeBase is Test {
    bytes32 internal constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");
    bytes32 internal constant SCHEMA = keccak256("gye-schema");
    uint128 internal constant C = 100e6; // 100 USDC-like
    uint32 internal constant ROUND = 7 days;

    address internal owner = makeAddr("owner");
    MockToken internal usd;
    MockScroll internal scroll;
    MockEAS internal eas;
    DojangGate internal gate;
    GyeReputation internal rep;
    GyeFactory internal factory;

    address[] internal people;

    function setUp() public virtual {
        usd = new MockToken(6);
        scroll = new MockScroll();
        eas = new MockEAS();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        rep = new GyeReputation(owner, IEAS(address(eas)), SCHEMA);
        factory = new GyeFactory(owner, rep, gate, 1 hours);
        vm.startPrank(owner);
        rep.setFactory(address(factory));
        factory.listToken(address(usd), 1e30); // 1e6 units == $1 (1e18)
        vm.stopPrank();

        for (uint256 i; i < 12; ++i) {
            address p = makeAddr(string.concat("p", vm.toString(i)));
            people.push(p);
            scroll.set(p, UPBIT, true);
            usd.mint(p, 1_000_000e6);
        }
    }

    function _cfg(uint8 size, GyeCircle.Mode mode) internal view returns (GyeCircle.Config memory cfg) {
        cfg = GyeCircle.Config({
            token: usd,
            contribution: C,
            size: size,
            mode: mode,
            roundDuration: ROUND,
            maxDiscountBps: mode == GyeCircle.Mode.Auction ? 3_000 : 0,
            fillDeadline: uint64(block.timestamp + 3 days),
            name: "test"
        });
    }

    /// @dev Creates a circle and fills it with people[from .. from+size).
    function _circle(uint8 size, GyeCircle.Mode mode, uint256 from) internal returns (GyeCircle c) {
        address creator = people[from];
        vm.startPrank(creator);
        usd.approve(address(factory), type(uint256).max);
        c = factory.createCircle(_cfg(size, mode), true);
        usd.approve(address(c), type(uint256).max);
        vm.stopPrank();
        for (uint256 i = 1; i < size; ++i) {
            _join(c, people[from + i]);
        }
    }

    function _join(GyeCircle c, address p) internal {
        vm.startPrank(p);
        usd.approve(address(c), type(uint256).max);
        c.join();
        vm.stopPrank();
    }

    function _pay(GyeCircle c, address p) internal {
        vm.prank(p);
        c.contribute();
    }

    function _payAll(GyeCircle c) internal {
        address[] memory m = c.members();
        for (uint256 i; i < m.length; ++i) {
            if (!c.hasPaid(m[i])) _pay(c, m[i]);
        }
    }

    function _settle(GyeCircle c) internal {
        vm.warp(c.deadline());
        c.settle();
    }

    function _claimAll(GyeCircle c) internal {
        address[] memory m = c.members();
        for (uint256 i; i < m.length; ++i) {
            if (c.memberOf(m[i]).claimable != 0) {
                vm.prank(m[i]);
                c.claim();
            }
        }
    }

    /// @dev balance == Σescrow + Σclaimable + roundCollected + feesAccrued  and  Σdebt == Σowed
    function _assertBooks(GyeCircle c) internal view {
        address[] memory m = c.members();
        uint256 escrow;
        uint256 claimable;
        uint256 debt;
        uint256 owed;
        for (uint256 i; i < m.length; ++i) {
            GyeCircle.Member memory x = c.memberOf(m[i]);
            escrow += x.escrow;
            claimable += x.claimable;
            debt += x.debt;
            owed += x.owed;
        }
        assertEq(usd.balanceOf(address(c)), escrow + claimable + c.roundCollected() + c.feesAccrued(), "balance books");
        assertEq(debt, owed, "debt == owed");
    }
}
