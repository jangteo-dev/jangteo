// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JangteoProperty} from "../src/property/JangteoProperty.sol";
import {PropertyShare} from "../src/property/PropertyShare.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll} from "./mocks/Mocks.sol";

/// Random walks over every action. Calls that would revert are skipped by the handler's guards
/// or simply revert (fail_on_revert = false); the invariants must hold after every step.
contract PropertyHandler is Test {
    uint256 constant W = 1e18;
    JangteoProperty public reg;
    MockToken public won;
    address public issuer;
    address[4] public actors;

    constructor(JangteoProperty reg_, MockToken won_, address issuer_, address[4] memory actors_) {
        reg = reg_;
        won = won_;
        issuer = issuer_;
        actors = actors_;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function _pid(uint256 s) internal view returns (bool ok, uint256 id) {
        uint256 n = reg.count();
        if (n == 0) return (false, 0);
        return (true, s % n);
    }

    function create(uint256 total, uint256 minPct, uint256 price, uint256 rent, uint256 months) external {
        if (reg.count() >= 6) return;
        total = bound(total, 1, 2_000);
        uint256 minShares = bound(minPct, 1, 100) * total / 100;
        if (minShares == 0) minShares = 1;
        price = bound(price, 1, 1_000_000) * W / 100;
        months = bound(months, 0, 24);
        if (months != 0 && months < 3) months = 3;
        uint256 minNet = minShares * price - (minShares * price * 200) / 10_000;
        rent = months == 0 ? 0 : bound(rent, 1, minNet / months);
        vm.prank(issuer);
        reg.create(
            JangteoProperty.Terms({
                totalShares: total, minShares: minShares, price: price, duration: 2 days, rentPerPeriod: rent, reserveMonths: months
            }),
            ""
        );
    }

    function buy(uint256 s, uint256 who, uint256 n) external {
        (bool ok, uint256 id) = _pid(s);
        if (!ok) return;
        JangteoProperty.Property memory p = reg.property(id);
        if (p.status != JangteoProperty.Status.Funding || vm.getBlockTimestamp() >= p.endAt || p.sold == p.totalShares) return;
        n = bound(n, 1, p.totalShares - p.sold);
        vm.prank(_actor(who));
        reg.buy(id, n);
    }

    function warp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 70 days));
    }

    function finalize(uint256 s) external {
        (bool ok, uint256 id) = _pid(s);
        if (ok) try reg.finalize(id) {} catch {}
    }

    function cancel(uint256 s) external {
        (bool ok, uint256 id) = _pid(s);
        if (!ok) return;
        vm.prank(issuer);
        try reg.cancel(id) {} catch {}
    }

    function refund(uint256 s, uint256 who) external {
        (bool ok, uint256 id) = _pid(s);
        if (!ok) return;
        vm.prank(_actor(who));
        try reg.refund(id) {} catch {}
    }

    function accrue(uint256 s) external {
        (bool ok, uint256 id) = _pid(s);
        if (ok) reg.accrue(id);
    }

    function fund(uint256 s, uint256 amt) external {
        (bool ok, uint256 id) = _pid(s);
        if (!ok) return;
        vm.prank(issuer);
        try reg.fundReserve(id, bound(amt, 1, 10_000_000 * W)) {} catch {}
    }

    function claim(uint256 s, uint256 who) external {
        (bool ok, uint256 id) = _pid(s);
        if (!ok) return;
        vm.prank(_actor(who));
        try reg.claimRent(id) {} catch {}
    }

    function transfer(uint256 s, uint256 from, uint256 to, uint256 n) external {
        (bool ok, uint256 id) = _pid(s);
        if (!ok) return;
        PropertyShare sh = reg.property(id).share;
        address f = _actor(from);
        uint256 bal = sh.balanceOf(f);
        if (bal == 0) return;
        vm.prank(f);
        try sh.transfer(_actor(to), bound(n, 1, bal)) {} catch {}
    }

    function list(uint256 s, uint256 who, uint256 n, uint256 price) external {
        (bool ok, uint256 id) = _pid(s);
        if (!ok) return;
        address a = _actor(who);
        uint256 bal = reg.property(id).share.balanceOf(a);
        if (bal == 0) return;
        vm.prank(a);
        try reg.list(id, bound(n, 1, bal), bound(price, 1, 1_000_000 * W)) {} catch {}
    }

    function buyListing(uint256 l, uint256 who, uint256 n) external {
        uint256 c = reg.listingCount();
        if (c == 0) return;
        uint256 lid = l % c;
        uint256 left = reg.listing(lid).shares;
        if (left == 0) return;
        vm.prank(_actor(who));
        try reg.buyListing(lid, bound(n, 1, left)) {} catch {}
    }

    function cancelListing(uint256 l) external {
        uint256 c = reg.listingCount();
        if (c == 0) return;
        uint256 lid = l % c;
        vm.prank(reg.listing(lid).seller);
        try reg.cancelListing(lid) {} catch {}
    }

    function sell(uint256 s, uint256 amt) external {
        (bool ok, uint256 id) = _pid(s);
        if (!ok) return;
        vm.prank(issuer);
        try reg.sell(id, bound(amt, 1, 100_000_000 * W)) {} catch {}
    }

    function redeem(uint256 s, uint256 who, uint256 n) external {
        (bool ok, uint256 id) = _pid(s);
        if (!ok) return;
        address a = _actor(who);
        uint256 bal = reg.property(id).share.balanceOf(a);
        if (bal == 0) return;
        vm.prank(a);
        try reg.redeem(id, bound(n, 1, bal)) {} catch {}
    }

    function sweep() external {
        try reg.sweepFees() {} catch {}
    }
}

contract PropertyInvariantTest is Test {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");
    MockToken won;
    JangteoProperty reg;
    PropertyHandler h;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address issuer = makeAddr("issuer");
    address[4] actors;

    function setUp() public {
        vm.warp(1_800_000_000);
        won = new MockToken(18);
        MockScroll scroll = new MockScroll();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        reg = new JangteoProperty(owner, gate, IERC20(address(won)), treasury, 30 days, 1 hours);
        actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        h = new PropertyHandler(reg, won, issuer, actors);
        address[5] memory all = [issuer, actors[0], actors[1], actors[2], actors[3]];
        for (uint256 i; i < all.length; ++i) {
            if (all[i] != actors[3]) scroll.set(all[i], UPBIT, true); // a3 is unverified
            won.mint(all[i], 1e36);
            vm.prank(all[i]);
            won.approve(address(reg), type(uint256).max);
        }
        targetContract(address(h));
    }

    /// Everything the registry owes, property by property.
    function _liabilities() internal view returns (uint256 sum) {
        sum = reg.feesAccrued();
        for (uint256 id; id < reg.count(); ++id) {
            JangteoProperty.Property memory p = reg.property(id);
            if (p.status == JangteoProperty.Status.Funding) sum += p.sold * p.price;
            else if (p.status == JangteoProperty.Status.Failed) sum += p.refundable;
            else if (p.status == JangteoProperty.Status.Active) sum += p.reserve + p.rentUnclaimed;
            else if (p.status == JangteoProperty.Status.Sold) {
                sum += p.rentUnclaimed + p.pool - (p.pool * p.redeemed) / p.exitSupply;
            }
        }
    }

    function invariant_solvent() public view {
        assertGe(won.balanceOf(address(reg)), _liabilities());
    }

    function invariant_escrowMatchesListings() public view {
        for (uint256 id; id < reg.count(); ++id) {
            uint256 listed;
            uint256[] memory ls = reg.listingsOf(id);
            for (uint256 i; i < ls.length; ++i) listed += reg.listing(ls[i]).shares;
            assertEq(reg.property(id).share.balanceOf(address(reg)), listed);
        }
    }

    function invariant_claimsWithinPaidRent() public view {
        for (uint256 id; id < reg.count(); ++id) {
            uint256 sum;
            for (uint256 i; i < 4; ++i) sum += reg.claimable(id, actors[i]);
            JangteoProperty.Property memory p = reg.property(id);
            // The view may include rent booked-on-read; bound it by what the reserve could add.
            assertLe(sum, p.rentUnclaimed + p.reserve);
        }
    }

    /// After any history, every party can get every token out: nothing is stuck.
    function afterInvariant() public {
        for (uint256 id; id < reg.count(); ++id) {
            JangteoProperty.Property memory p = reg.property(id);
            if (p.status == JangteoProperty.Status.Funding) {
                if (vm.getBlockTimestamp() < p.endAt) vm.warp(p.endAt); // time never runs backwards
                reg.finalize(id);
                p = reg.property(id);
            }
            if (p.status == JangteoProperty.Status.Active) {
                vm.prank(issuer);
                reg.sell(id, 1_000 * 1e18);
            }
        }
        for (uint256 lid; lid < reg.listingCount(); ++lid) {
            JangteoProperty.Listing memory l = reg.listing(lid);
            if (l.shares != 0) {
                vm.prank(l.seller);
                reg.cancelListing(lid);
            }
        }
        for (uint256 id; id < reg.count(); ++id) {
            JangteoProperty.Property memory p = reg.property(id);
            for (uint256 i; i < 4; ++i) {
                address a = actors[i];
                uint256 bal = p.share.balanceOf(a);
                vm.startPrank(a);
                if (bal != 0 && p.status == JangteoProperty.Status.Failed) reg.refund(id);
                if (bal != 0 && p.status == JangteoProperty.Status.Sold) reg.redeem(id, bal);
                if (reg.claimable(id, a) != 0) reg.claimRent(id);
                vm.stopPrank();
                assertEq(p.share.balanceOf(a), 0);
            }
            assertEq(p.share.totalSupply(), 0);
        }
        if (reg.feesAccrued() != 0) reg.sweepFees();
        // Only rent rounding dust (< 1 wei per holder per payment) may remain.
        assertLt(won.balanceOf(address(reg)), 1e9);
    }
}
