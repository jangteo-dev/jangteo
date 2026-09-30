// SPDX-License-Identifier: MIT
// Same suite as Pump.t.sol with the v2 parameters live since 2026-09-26: virtual 2 ETH, 750M on the curve, creators buy at most 0.1 ETH.
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IUniswapV2Router02} from "../src/cheongyak/CheongyakV2.sol";
import {DojangGate} from "../src/gates/DojangGate.sol";
import {IDojangScroll} from "../src/interfaces/IExternal.sol";
import {JangteoPump, IWETH, IV2Factory} from "../src/pump/JangteoPump.sol";
import {JangteoPumpRouter, IV2Router} from "../src/pump/JangteoPumpRouter.sol";
import {PumpToken} from "../src/pump/PumpToken.sol";
import {MockScroll} from "./mocks/Mocks.sol";

contract WETH9 {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 wad) public {
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
    }

    function totalSupply() public view returns (uint256) {
        return address(this).balance;
    }

    function approve(address guy, uint256 wad) public returns (bool) {
        allowance[msg.sender][guy] = wad;
        return true;
    }

    function transfer(address dst, uint256 wad) public returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "bal");
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "allow");
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        return true;
    }
}

interface IPairT {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function balanceOf(address) external view returns (uint256);
    function sync() external;
}

interface IFactoryT {
    function createPair(address, address) external returns (address);
}

contract PumpV2ParamsTest is Test {
    bytes32 constant UPBIT = keccak256("dojang.dojangattesterids.upbitkorea");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    WETH9 weth;
    address factory;
    IUniswapV2Router02 v2;
    JangteoPump pump;
    JangteoPumpRouter router;
    MockScroll scroll;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address outsider = makeAddr("outsider"); // not Dojang-verified: may trade, may not launch

    function setUp() public {
        vm.warp(1_800_000_000);
        weth = new WETH9();
        bytes memory f = abi.encodePacked(vm.parseBytes(vm.readFile("external/uniswap/UniswapV2Factory.hex")), abi.encode(owner));
        address fa;
        assembly {
            fa := create(0, add(f, 0x20), mload(f))
        }
        factory = fa;
        bytes memory r = abi.encodePacked(vm.parseBytes(vm.readFile("external/uniswap/UniswapV2Router02.hex")), abi.encode(fa, address(weth)));
        address ra;
        assembly {
            ra := create(0, add(r, 0x20), mload(r))
        }
        v2 = IUniswapV2Router02(ra);
        scroll = new MockScroll();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = UPBIT;
        DojangGate gate = new DojangGate(owner, IDojangScroll(address(scroll)), ids);
        pump = new JangteoPump(owner, gate, IWETH(address(weth)), IV2Factory(fa), treasury, 4.2 ether, 2 ether, 750_000_000 ether, 0.1 ether);
        router = new JangteoPumpRouter(pump, IV2Router(ra), address(weth));
        for (uint256 i; i < 3; ++i) scroll.set([creator, alice, bob][i], UPBIT, true);
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(outsider, 100 ether);
    }

    function _launch(uint256 devBuy) internal returns (PumpToken t) {
        vm.prank(creator);
        t = PumpToken(pump.create{value: devBuy}("Dosirak", "DSRK", '{"about":"lunchbox"}'));
    }

    function _buy(address who, PumpToken t, uint256 eth) internal returns (uint256) {
        vm.prank(who);
        return pump.buy{value: eth}(address(t), 0, block.timestamp);
    }

    function _solvent() internal view {
        uint256 owed = pump.protocolFees();
        for (uint256 i; i < pump.tokenCount(); ++i) {
            JangteoPump.Launch memory l = pump.launch(pump.tokens(i));
            owed += l.realEth + l.creatorFees;
        }
        assertEq(address(pump).balance, owed, "pump ETH == what it owes");
    }

    // ───────────────────────────────── launching ─────────────────────────────

    function test_ParamsGiveExactCurve() public view {
        // Selling all 750M moves the curve from 2 to 6.2 ETH.
        assertEq(pump.virtualTokens(), uint256(750_000_000 ether) * 62 / 42);
    }

    function test_OnlyVerifiedLaunch() public {
        vm.prank(outsider);
        vm.expectRevert(JangteoPump.NotEligible.selector);
        pump.create("X", "XX", "");
        vm.prank(creator);
        vm.expectRevert(JangteoPump.BadParams.selector);
        pump.create{value: 0.5 ether}("X", "XX", ""); // over the creator-buy cap
    }

    function test_LaunchDeploysTokenAndPair() public {
        PumpToken t = _launch(0.1 ether);
        assertEq(t.totalSupply(), 1_000_000_000 ether);
        address pair = IV2Factory(factory).getPair(address(t), address(weth));
        assertEq(pair, t.pair());
        assertEq(pump.launch(address(t)).pair, pair);
        assertGt(t.balanceOf(creator), 0);
        assertEq(pump.metadata(address(t)), '{"about":"lunchbox"}');
        _solvent();
    }

    function test_PrecreatedPairDoesNotBlockLaunch() public {
        // Predict the next token's address and create its pair first.
        address next = vm.computeCreateAddress(address(pump), vm.getNonce(address(pump)));
        IFactoryT(factory).createPair(next, address(weth));
        PumpToken t = _launch(0);
        assertEq(address(t), next);
        _buy(alice, t, 1 ether);
    }

    // ───────────────────────────────── trading ───────────────────────────────

    function test_OutsidersCanTrade() public {
        PumpToken t = _launch(0);
        uint256 out = _buy(outsider, t, 0.5 ether);
        assertGt(out, 0);
        vm.startPrank(outsider);
        t.approve(address(pump), out);
        uint256 back = pump.sell(address(t), out, 0, block.timestamp);
        vm.stopPrank();
        // Round trip loses the two 1% fees, never gains.
        assertLt(back, 0.5 ether);
        assertGt(back, 0.5 ether * 97 / 100);
        _solvent();
    }

    function test_PairLockedUntilGraduation() public {
        PumpToken t = _launch(0);
        _buy(alice, t, 1 ether);
        address pair = t.pair();
        vm.prank(alice);
        vm.expectRevert(PumpToken.PairLocked.selector);
        t.transfer(pair, 1 ether);
        // Ordinary transfers are free.
        vm.prank(alice);
        t.transfer(bob, 1 ether);
    }

    function test_SlippageAndDeadline() public {
        PumpToken t = _launch(0);
        (uint256 q,,) = pump.quoteBuy(address(t), 1 ether);
        vm.prank(alice);
        vm.expectRevert(JangteoPump.Slippage.selector);
        pump.buy{value: 1 ether}(address(t), q + 1, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(JangteoPump.Expired.selector);
        pump.buy{value: 1 ether}(address(t), 0, block.timestamp - 1);
        vm.prank(alice);
        assertEq(pump.buy{value: 1 ether}(address(t), q, block.timestamp), q);
    }

    // ──────────────────────────────── graduation ─────────────────────────────

    function test_GraduationIsFairAndLocked() public {
        PumpToken t = _launch(0.1 ether);
        _buy(alice, t, 2 ether);
        _buy(bob, t, 1.5 ether);
        // Curve holds ~3.61 ETH net; this buy is far bigger than the room left.
        uint256 priceBefore;
        uint256 bal0 = bob.balance;
        vm.prank(bob);
        uint256 out = pump.buy{value: 5 ether}(address(t), 0, block.timestamp);
        JangteoPump.Launch memory l = pump.launch(address(t));
        assertTrue(l.graduated);
        assertTrue(t.graduated());
        // Bob paid only what reached the line; the rest came back.
        uint256 spent = bal0 - bob.balance;
        assertLt(spent, 1 ether);
        assertGt(out, 0);
        // Exactly the curve supply was sold (to rounding).
        assertApproxEqAbs(l.sold, 750_000_000 ether, 1e12);
        // Pool opens at the curve's final price.
        priceBefore = (2 ether + 4.2 ether) * 1e18 / (pump.virtualTokens() - l.sold);
        (uint112 r0, uint112 r1,) = IPairT(t.pair()).getReserves();
        (uint256 rt, uint256 rw) = IPairT(t.pair()).token0() == address(t) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        assertApproxEqRel(rw * 1e18 / rt, priceBefore, 1e12); // within 0.0001%
        assertEq(rw, 4.2 ether - 0.042 ether);
        // LP burned, leftovers burned, nothing left in the pump.
        assertGt(IPairT(t.pair()).balanceOf(DEAD), 0);
        assertEq(t.balanceOf(address(pump)), 0);
        assertGt(t.balanceOf(DEAD), 0);
        // Curve closed; the pool is open to everyone.
        vm.prank(alice);
        vm.expectRevert(JangteoPump.AlreadyGraduated.selector);
        pump.buy{value: 1 ether}(address(t), 0, block.timestamp);
        address pair = t.pair();
        vm.prank(alice);
        t.transfer(pair, 1 ether); // pair unlocked
        _solvent();
    }

    function test_DonatedWethDoesNotBreakGraduation() public {
        PumpToken t = _launch(0);
        vm.startPrank(alice);
        weth.deposit{value: 1 ether}();
        weth.transfer(t.pair(), 1 ether);
        vm.stopPrank();
        IPairT(t.pair()).sync();
        _buy(bob, t, 10 ether);
        assertTrue(pump.launch(address(t)).graduated);
    }

    function test_FeesSplitAndClaim() public {
        PumpToken t = _launch(0);
        _buy(alice, t, 2 ether); // fee 0.02: 0.01 creator, 0.01 protocol
        assertEq(pump.launch(address(t)).creatorFees, 0.01 ether);
        assertEq(pump.protocolFees(), 0.01 ether);
        vm.prank(alice);
        vm.expectRevert(JangteoPump.NothingToClaim.selector);
        pump.claimCreatorFees(address(0xBEEF));
        uint256 c0 = creator.balance;
        pump.claimCreatorFees(address(t)); // anyone may trigger; it pays the creator
        assertEq(creator.balance - c0, 0.01 ether);
        pump.withdrawProtocolFees();
        assertEq(treasury.balance, 0.01 ether);
        _solvent();
    }

    // ─────────────────────────────────── router ──────────────────────────────

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function test_RouterBuysAndSellsOnCurveThenPool() public {
        PumpToken t = _launch(0);
        uint256[] memory q = router.getAmountsOut(1 ether, _path(address(weth), address(t)));
        vm.prank(outsider);
        uint256[] memory got = router.swapExactETHForTokens{value: 1 ether}(q[1], _path(address(weth), address(t)), outsider, block.timestamp);
        assertEq(got[1], q[1]);
        assertEq(t.balanceOf(outsider), q[1]);

        // Sell half back through the router.
        vm.startPrank(outsider);
        t.approve(address(router), type(uint256).max);
        uint256 e0 = outsider.balance;
        router.swapExactTokensForETH(q[1] / 2, 0, _path(address(t), address(weth)), outsider, block.timestamp);
        vm.stopPrank();
        assertGt(outsider.balance, e0);

        // A buy through the router that crosses the line gets its change back.
        uint256 e1 = outsider.balance;
        vm.prank(outsider);
        router.swapExactETHForTokens{value: 20 ether}(0, _path(address(weth), address(t)), outsider, block.timestamp);
        assertTrue(pump.launch(address(t)).graduated);
        assertLt(e1 - outsider.balance, 5 ether);
        assertEq(address(router).balance, 0);

        // After graduation the same calls trade the 장터 스왑 pool.
        uint256 before = t.balanceOf(outsider);
        vm.prank(outsider);
        router.swapExactETHForTokens{value: 0.1 ether}(0, _path(address(weth), address(t)), outsider, block.timestamp);
        assertGt(t.balanceOf(outsider), before);
        vm.prank(outsider);
        router.swapExactTokensForETH(1_000_000 ether, 0, _path(address(t), address(weth)), outsider, block.timestamp);
        _solvent();
    }

    // ────────────────────────────── invariants ───────────────────────────────

    function testFuzz_TradesStaySolventAndSane(uint256 seed, uint8 n) public {
        n = uint8(bound(n, 1, 40));
        PumpToken t = _launch(0.05 ether);
        address[3] memory who = [alice, bob, outsider];
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address w = who[r % 3];
            if (pump.launch(address(t)).graduated) break;
            if (r % 2 == 0 || t.balanceOf(w) == 0) {
                _buy(w, t, bound(r >> 8, 0.001 ether, 1.5 ether));
            } else {
                uint256 amt = bound(r >> 16, 1, t.balanceOf(w));
                if (pump.quoteSell(address(t), amt) == 0) continue;
                vm.startPrank(w);
                t.approve(address(pump), amt);
                pump.sell(address(t), amt, 0, block.timestamp);
                vm.stopPrank();
            }
            JangteoPump.Launch memory l = pump.launch(address(t));
            assertLe(l.sold, 750_000_000 ether);
            assertLe(l.realEth, 4.2 ether);
            _solvent();
        }
    }
}
