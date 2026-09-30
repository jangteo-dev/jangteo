// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CheongyakV2, IUniswapV2Router02, IUniswapV2Factory} from "../src/cheongyak/CheongyakV2.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {MockToken, MockScroll} from "./mocks/Mocks.sol";

interface IFactoryFull {
    function createPair(address a, address b) external returns (address);
}

interface IPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function sync() external;
}

/// Deploys the official Uniswap V2 build artifacts (no recompilation) so liquidity is tested
/// against the exact bytecode that goes on-chain.
abstract contract UniV2Fixture is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;

    function _deployUniV2(address feeToSetter) internal returns (IUniswapV2Router02 router, address factory) {
        bytes memory f = abi.encodePacked(vm.parseBytes(vm.readFile("external/uniswap/UniswapV2Factory.hex")), abi.encode(feeToSetter));
        bytes memory r0 = vm.parseBytes(vm.readFile("external/uniswap/UniswapV2Router02.hex"));
        assembly {
            factory := create(0, add(f, 0x20), mload(f))
        }
        require(factory != address(0), "factory");
        bytes memory r = abi.encodePacked(r0, abi.encode(factory, WETH));
        address ra;
        assembly {
            ra := create(0, add(r, 0x20), mload(r))
        }
        require(ra != address(0), "router");
        router = IUniswapV2Router02(ra);
    }
}

contract CheongyakV2Test is UniV2Fixture {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");

    MockToken won;
    MockToken usd;
    MockToken hanok;
    MockScroll scroll;
    CheongyakV2 cy;
    IUniswapV2Router02 router;
    address factory;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address issuer = makeAddr("issuer");
    address[] people;

    function setUp() public {
        vm.warp(1_800_000_000);
        won = new MockToken(18);
        usd = new MockToken(18);
        hanok = new MockToken(18);
        scroll = new MockScroll();
        (router, factory) = _deployUniV2(owner);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        cy = new CheongyakV2(owner, gate, router, treasury, 200);
        vm.startPrank(owner);
        cy.setQuote(address(won), true);
        cy.setQuote(address(usd), true);
        vm.stopPrank();
        hanok.mint(issuer, 1e30);
        vm.prank(issuer);
        hanok.approve(address(cy), type(uint256).max);
        for (uint256 i; i < 30; ++i) {
            address p = makeAddr(string.concat("p", vm.toString(i)));
            people.push(p);
            scroll.set(p, UPBIT, true);
            won.mint(p, 1e30);
            usd.mint(p, 1e30);
            vm.startPrank(p);
            won.approve(address(cy), type(uint256).max);
            usd.approve(address(cy), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// 1,000 HANOK at ₩1,000; half split evenly; ₩10,000–₩500,000 per person.
    function _terms() internal view returns (CheongyakV2.Terms memory t) {
        t.token = IERC20(address(hanok));
        t.quote = IERC20(address(won));
        t.name = "HANOK";
        t.totalTokens = 1_000e18;
        t.price = 1_000e18;
        t.startAt = uint64(vm.getBlockTimestamp() + 1 hours);
        t.endAt = uint64(vm.getBlockTimestamp() + 1 days);
        t.equalBps = 5_000;
        t.minDeposit = 10_000e18;
        t.maxDeposit = 500_000e18;
    }

    function _create(CheongyakV2.Terms memory t) internal returns (uint256 id) {
        vm.prank(issuer);
        id = cy.create(t, '{"site":"https://hanok.example"}');
    }

    function _sub(uint256 id, uint256 who, uint128 amount) internal {
        vm.prank(people[who]);
        cy.subscribe(id, amount);
    }

    function _open(uint256 id) internal {
        vm.warp(cy.offering(id).t.startAt);
    }

    function _settleAll(uint256 id, uint32 batch) internal {
        vm.warp(cy.offering(id).t.endAt);
        for (uint256 i; i < 1000; ++i) {
            CheongyakV2.Status s = cy.offering(id).status;
            if (s != CheongyakV2.Status.Scheduled && s != CheongyakV2.Status.Settling) break;
            cy.settle(id, batch);
        }
    }

    function _claim(uint256 id, uint256 who) internal returns (uint256 tokens, uint256 refund) {
        IERC20 q = cy.offering(id).t.quote;
        uint256 t0 = hanok.balanceOf(people[who]);
        uint256 w0 = q.balanceOf(people[who]);
        vm.prank(people[who]);
        cy.claim(id);
        tokens = hanok.balanceOf(people[who]) - t0;
        refund = q.balanceOf(people[who]) - w0;
    }

    // ─────────────────────────────── creating ───────────────────────────────

    function test_CreateValidation() public {
        CheongyakV2.Terms memory t = _terms();
        t.quote = IERC20(address(hanok));
        vm.prank(issuer);
        vm.expectRevert(CheongyakV2.BadParams.selector);
        cy.create(t, "");

        t = _terms();
        t.quote = IERC20(makeAddr("notAllowed"));
        vm.prank(issuer);
        vm.expectRevert(CheongyakV2.BadParams.selector);
        cy.create(t, "");

        t = _terms();
        t.softCap = 1_000_001e18; // above hard cap
        vm.prank(issuer);
        vm.expectRevert(CheongyakV2.BadParams.selector);
        cy.create(t, "");

        t = _terms();
        t.liqBps = 2_000;
        t.lpLock = 7 days; // under the 30-day minimum
        vm.prank(issuer);
        vm.expectRevert(CheongyakV2.BadParams.selector);
        cy.create(t, "");

        t = _terms();
        t.liqBps = 6_000;
        t.lpLock = 30 days;
        vm.prank(issuer);
        vm.expectRevert(CheongyakV2.BadParams.selector);
        cy.create(t, "");
    }

    function test_CreateEscrowsLiquidityTokens() public {
        CheongyakV2.Terms memory t = _terms();
        t.liqBps = 2_000;
        t.lpLock = 30 days;
        uint256 b0 = hanok.balanceOf(issuer);
        uint256 id = _create(t);
        assertEq(b0 - hanok.balanceOf(issuer), 1_200e18);
        assertEq(cy.offering(id).liqEscrow, 200e18);
        assertEq(cy.metadata(id), '{"site":"https://hanok.example"}');
    }

    function test_MetadataAndVerified() public {
        uint256 id = _create(_terms());
        vm.prank(people[0]);
        vm.expectRevert(CheongyakV2.NotIssuer.selector);
        cy.setMetadata(id, "x");
        vm.prank(issuer);
        cy.setMetadata(id, '{"logo":"ipfs://x"}');
        assertEq(cy.metadata(id), '{"logo":"ipfs://x"}');

        vm.prank(issuer);
        vm.expectRevert();
        cy.setVerified(id, true);
        vm.prank(owner);
        cy.setVerified(id, true);
        assertTrue(cy.offering(id).verified);

        vm.warp(cy.offering(id).t.endAt);
        vm.prank(issuer);
        vm.expectRevert(CheongyakV2.WrongStatus.selector);
        cy.setMetadata(id, "late");
    }

    function test_CancelReturnsEverything() public {
        CheongyakV2.Terms memory t = _terms();
        t.liqBps = 1_000;
        t.lpLock = 30 days;
        uint256 b0 = hanok.balanceOf(issuer);
        uint256 id = _create(t);
        vm.prank(issuer);
        cy.cancel(id);
        assertEq(hanok.balanceOf(issuer), b0);
    }

    // ─────────────────────────────── soft cap ───────────────────────────────

    function test_SoftCapMissedRefundsAll() public {
        CheongyakV2.Terms memory t = _terms();
        t.softCap = 300_000e18;
        t.liqBps = 2_000;
        t.lpLock = 30 days;
        uint256 b0 = hanok.balanceOf(issuer);
        uint256 id = _create(t);
        _open(id);
        _sub(id, 0, 100_000e18);
        _sub(id, 1, 150_000e18);
        _settleAll(id, 10);
        assertEq(uint8(cy.offering(id).status), uint8(CheongyakV2.Status.Failed));
        assertEq(hanok.balanceOf(issuer), b0);
        (uint256 tk, uint256 rf) = _claim(id, 0);
        assertEq(tk, 0);
        assertEq(rf, 100_000e18);
        (, rf) = _claim(id, 1);
        assertEq(rf, 150_000e18);
        vm.prank(people[0]);
        vm.expectRevert(CheongyakV2.NothingToClaim.selector);
        cy.claim(id);
        assertEq(won.balanceOf(address(cy)), 0);
        assertEq(cy.feesAccrued(address(won)), 0);
    }

    function test_SoftCapMetSettles() public {
        CheongyakV2.Terms memory t = _terms();
        t.softCap = 300_000e18;
        uint256 id = _create(t);
        _open(id);
        _sub(id, 0, 200_000e18);
        _sub(id, 1, 100_000e18);
        _settleAll(id, 10);
        assertEq(uint8(cy.offering(id).status), uint8(CheongyakV2.Status.Settled));
    }

    // ─────────────────────────────── vesting ────────────────────────────────

    function test_VestingTgeCliffLinear() public {
        CheongyakV2.Terms memory t = _terms();
        t.tgeBps = 2_000;
        t.cliff = 30 days;
        t.vesting = 100 days;
        uint256 id = _create(t);
        _open(id);
        _sub(id, 0, 100_000e18); // 100 tokens, undersubscribed
        _settleAll(id, 10);
        uint64 s = cy.offering(id).settledAt;

        (uint256 tk, uint256 rf) = _claim(id, 0);
        assertEq(tk, 20e18);
        assertEq(rf, 0);
        vm.prank(people[0]);
        vm.expectRevert(CheongyakV2.NothingToClaim.selector);
        cy.claim(id);

        vm.warp(s + 30 days + 50 days);
        (tk,) = _claim(id, 0);
        assertEq(tk, 40e18); // 20 + 80 * 50/100 = 60 total
        vm.warp(s + 30 days + 500 days);
        (tk,) = _claim(id, 0);
        assertEq(tk, 40e18);
        assertEq(hanok.balanceOf(people[0]), 100e18);
        assertEq(cy.allocationOf(id, people[0]).released, 100e18);
    }

    function test_RefundPaidAtOnceEvenWhenVesting() public {
        CheongyakV2.Terms memory t = _terms();
        t.tgeBps = 0;
        t.cliff = 10 days;
        uint256 id = _create(t);
        _open(id);
        for (uint256 i; i < 4; ++i) _sub(id, i, 500_000e18); // 2,000 tokens asked for 1,000
        _settleAll(id, 3);
        (uint256 tk, uint256 rf) = _claim(id, 0);
        assertEq(tk, 0);
        assertApproxEqAbs(rf, 250_000e18, 1e6); // pro-rata rounding dust goes to the subscriber
        vm.warp(cy.offering(id).settledAt + 10 days);
        (tk, rf) = _claim(id, 0);
        assertApproxEqAbs(tk, 250e18, 1e6);
        assertEq(rf, 0);
    }

    // ─────────────────────────────── liquidity ──────────────────────────────

    function _liqOffer(uint16 liqBps) internal returns (uint256 id) {
        CheongyakV2.Terms memory t = _terms();
        t.liqBps = liqBps;
        t.lpLock = 60 days;
        id = _create(t);
        _open(id);
        for (uint256 i; i < 3; ++i) _sub(id, i, 200_000e18); // 600 tokens, ₩600,000 raised
    }

    function test_AutoLiquidityAndLpLock() public {
        uint256 id = _liqOffer(2_000);
        uint256 b0 = hanok.balanceOf(issuer);
        _settleAll(id, 10);
        CheongyakV2.Offering memory o = cy.offering(id);
        assertEq(o.liqQuote, 120_000e18);
        assertEq(o.liqTokens, 120e18);
        assertGt(o.lpAmount, 0);
        address pair = IUniswapV2Factory(factory).getPair(address(hanok), address(won));
        assertEq(o.pair, pair);
        assertEq(IERC20(pair).balanceOf(address(cy)), o.lpAmount);
        (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
        (uint256 rh, uint256 rw) = IPair(pair).token0() == address(hanok) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        assertEq(rw * 1e18 / rh, 1_000e18); // pool opens at the offer price

        cy.payIssuer(id);
        // proceeds = 600k - 2% fee - 120k liquidity
        assertEq(won.balanceOf(issuer), 600_000e18 - 12_000e18 - 120_000e18);
        // unsold 400 + unused liquidity escrow 80
        assertEq(hanok.balanceOf(issuer) - b0, 480e18);
        assertEq(cy.feesAccrued(address(won)), 12_000e18);

        vm.prank(issuer);
        vm.expectRevert(CheongyakV2.Locked.selector);
        cy.withdrawLp(id);
        vm.warp(o.settledAt + 60 days);
        vm.prank(people[0]);
        vm.expectRevert(CheongyakV2.NotIssuer.selector);
        cy.withdrawLp(id);
        vm.prank(issuer);
        cy.withdrawLp(id);
        assertEq(IERC20(pair).balanceOf(issuer), o.lpAmount);

        for (uint256 i; i < 3; ++i) _claim(id, i);
        cy.sweepFees(address(won));
        assertEq(won.balanceOf(treasury), 12_000e18);
        assertEq(hanok.balanceOf(address(cy)), 0);
        assertEq(won.balanceOf(address(cy)), 0);
    }

    function test_ManipulatedPoolSkipsLiquidity() public {
        uint256 id = _liqOffer(2_000);
        // Someone seeds the pair at 10x the offer price before settlement.
        hanok.mint(address(this), 1e18);
        won.mint(address(this), 10_000e18);
        address pair = IFactoryFull(factory).createPair(address(hanok), address(won));
        hanok.transfer(pair, 1e18);
        won.transfer(pair, 10_000e18);
        IPair(pair).sync();

        uint256 b0 = hanok.balanceOf(issuer);
        _settleAll(id, 10);
        CheongyakV2.Offering memory o = cy.offering(id);
        assertEq(uint8(o.status), uint8(CheongyakV2.Status.Settled));
        assertEq(o.lpAmount, 0);
        cy.payIssuer(id);
        assertEq(won.balanceOf(issuer), 600_000e18 - 12_000e18);
        assertEq(hanok.balanceOf(issuer) - b0, 600e18);
        assertEq(won.allowance(address(cy), address(router)), 0);
        vm.prank(issuer);
        vm.expectRevert(CheongyakV2.NothingToClaim.selector);
        cy.withdrawLp(id);
    }

    function test_OtherQuoteToken() public {
        CheongyakV2.Terms memory t = _terms();
        t.quote = IERC20(address(usd));
        t.price = 1e18;
        t.minDeposit = 1e18;
        t.maxDeposit = 1_000e18;
        t.liqBps = 5_000;
        t.lpLock = 30 days;
        uint256 id = _create(t);
        _open(id);
        _sub(id, 0, 1_000e18);
        _settleAll(id, 10);
        assertGt(cy.offering(id).lpAmount, 0);
        cy.payIssuer(id);
        assertEq(usd.balanceOf(issuer), 1_000e18 - 20e18 - 500e18);
        assertEq(cy.feesAccrued(address(usd)), 20e18);
        assertEq(cy.feesAccrued(address(won)), 0);
    }

    // ───────────────────────────── conservation ─────────────────────────────

    function testFuzz_Conservation(uint8 n, uint256 seed, uint16 liqBps, uint16 equalBps) public {
        n = uint8(bound(n, 1, 30));
        liqBps = uint16(bound(liqBps, 0, 5_000));
        CheongyakV2.Terms memory t = _terms();
        t.equalBps = uint16(bound(equalBps, 0, 10_000));
        t.liqBps = liqBps;
        t.lpLock = 30 days;
        t.tgeBps = 5_000;
        t.vesting = 10 days;
        uint256 b0 = hanok.balanceOf(issuer);
        uint256 id = _create(t);
        _open(id);
        uint256 deposited;
        for (uint256 i; i < n; ++i) {
            uint128 amt = uint128(bound(uint256(keccak256(abi.encode(seed, i))), 10_000e18, 500_000e18));
            _sub(id, i, amt);
            deposited += amt;
        }
        _settleAll(id, 7);
        vm.warp(block.timestamp + 20 days);
        cy.payIssuer(id);
        uint256 got;
        uint256 refunds;
        for (uint256 i; i < n; ++i) {
            (uint256 tk, uint256 rf) = _claim(id, i);
            got += tk;
            refunds += rf;
        }
        CheongyakV2.Offering memory o = cy.offering(id);
        assertLe(o.allocated, t.totalTokens);
        assertEq(got, o.allocated);
        assertEq(b0 - hanok.balanceOf(issuer), got + o.liqTokens);
        // every won is accounted for: refunds + issuer + pool + fee
        assertEq(refunds + won.balanceOf(issuer) + o.liqQuote + cy.feesAccrued(address(won)), deposited);
        assertEq(hanok.balanceOf(address(cy)), 0);
        assertEq(won.balanceOf(address(cy)), cy.feesAccrued(address(won)));
    }
}
