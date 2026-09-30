// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {InsaDrop} from "../src/insa/InsaDrop.sol";
import {InsaFactory} from "../src/insa/InsaFactory.sol";
import {InsaMarket} from "../src/insa/InsaMarket.sol";
import {TalArt} from "../src/insa/TalArt.sol";
import {TalRenderer} from "../src/insa/TalRenderer.sol";
import {IIdentityGate} from "../src/interfaces/IGye.sol";

contract Gate is IIdentityGate {
    mapping(address => bool) public ok;

    function set(address a, bool v) external {
        ok[a] = v;
    }

    function isEligible(address a) external view returns (bool) {
        return ok[a];
    }
}

contract Refuser {
    receive() external payable {
        revert();
    }

    function approve(InsaDrop d, address m) external {
        d.setApprovalForAll(m, true);
    }

    function list(InsaMarket m, address c, uint256 id, uint128 p) external {
        m.list(c, id, p, uint64(block.timestamp + 1 days));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

contract InsaTest is Test {
    Gate gate;
    InsaFactory factory;
    InsaMarket market;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        vm.warp(1_800_000_000);
        gate = new Gate();
        gate.set(creator, true);
        factory = new InsaFactory(owner, gate, treasury, 250);
        market = new InsaMarket(owner, treasury, 200);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    function _leaf(address a) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a))));
    }

    function _root2(address a, address b) internal pure returns (bytes32) {
        (bytes32 x, bytes32 y) = (_leaf(a), _leaf(b));
        return x < y ? keccak256(abi.encode(x, y)) : keccak256(abi.encode(y, x));
    }

    function _cfg(uint32 supply) internal view returns (InsaDrop.Config memory c) {
        c = InsaDrop.Config("Test", "TST", creator, creator, supply, 500, "ipfs://x/", "", address(0));
    }

    function _drop() internal returns (InsaDrop d) {
        InsaDrop.Phase[] memory ph = new InsaDrop.Phase[](2);
        uint64 t = uint64(block.timestamp);
        ph[0] = InsaDrop.Phase(t, t + 1 days, 0, 1, _root2(alice, bob)); // free allowlist, 1 each
        ph[1] = InsaDrop.Phase(t + 1 days, 0, 0.01 ether, 3, bytes32(0)); // public
        vm.prank(creator);
        d = InsaDrop(factory.create(_cfg(10), ph));
    }

    function _proof(address other) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = _leaf(other);
    }

    // ---- factory ----

    function test_OnlyVerifiedCreatorsLaunch() public {
        InsaDrop.Phase[] memory ph;
        vm.prank(alice);
        vm.expectRevert(InsaFactory.NotEligible.selector);
        factory.create(InsaDrop.Config("A", "A", alice, alice, 5, 0, "", "", address(0)), ph);
        vm.prank(creator);
        vm.expectRevert(InsaFactory.BadParams.selector); // cannot launch in someone else's name
        factory.create(InsaDrop.Config("A", "A", alice, alice, 5, 0, "", "", address(0)), ph);
    }

    // ---- minting ----

    function test_AllowlistPhase() public {
        InsaDrop d = _drop();
        vm.prank(alice);
        d.mint(0, 1, _proof(bob));
        assertEq(d.ownerOf(1), alice);
        vm.prank(alice);
        vm.expectRevert(InsaDrop.WalletCap.selector);
        d.mint(0, 1, _proof(bob));
        vm.prank(carol);
        vm.expectRevert(InsaDrop.NotAllowed.selector);
        d.mint(0, 1, _proof(bob));
        vm.prank(alice);
        vm.expectRevert(InsaDrop.NotLive.selector);
        d.mint(1, 1, new bytes32[](0)); // public not open yet
    }

    function test_PublicPhaseMoneySplit() public {
        InsaDrop d = _drop();
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert(InsaDrop.NotLive.selector);
        d.mint(0, 1, _proof(bob)); // allowlist closed
        vm.prank(carol);
        vm.expectRevert(InsaDrop.WrongPayment.selector);
        d.mint{value: 0.01 ether}(1, 2, new bytes32[](0));
        vm.prank(carol);
        d.mint{value: 0.03 ether}(1, 3, new bytes32[](0));
        assertEq(d.totalSupply(), 3);
        assertEq(d.balanceOf(carol), 3);
        d.withdraw();
        assertEq(treasury.balance, 0.03 ether * 250 / 10_000);
        assertEq(creator.balance, 0.03 ether - 0.03 ether * 250 / 10_000);
        assertEq(address(d).balance, 0);
    }

    function test_SupplyCap() public {
        InsaDrop d = _drop();
        vm.warp(block.timestamp + 1 days);
        for (uint256 i; i < 3; ++i) {
            address m = makeAddr(string.concat("m", vm.toString(i)));
            vm.deal(m, 1 ether);
            vm.prank(m);
            d.mint{value: 0.03 ether}(1, 3, new bytes32[](0));
        }
        vm.prank(alice);
        vm.expectRevert(InsaDrop.SoldOut.selector);
        d.mint{value: 0.02 ether}(1, 2, new bytes32[](0));
        vm.prank(alice);
        d.mint{value: 0.01 ether}(1, 1, new bytes32[](0));
        assertEq(d.totalSupply(), 10);
        vm.prank(creator);
        vm.expectRevert(InsaDrop.BadParams.selector);
        d.capSupply(11); // only down
    }

    function test_PhaseCannotChangeOnceStarted() public {
        InsaDrop d = _drop();
        uint64 t = uint64(block.timestamp);
        vm.startPrank(creator);
        vm.expectRevert(InsaDrop.BadParams.selector);
        d.setPhase(0, InsaDrop.Phase(t + 10, 0, 1 ether, 1, bytes32(0))); // phase 0 already live
        d.setPhase(1, InsaDrop.Phase(t + 2 days, 0, 0.02 ether, 3, bytes32(0))); // not started: fine
        d.setPhase(2, InsaDrop.Phase(t + 3 days, 0, 0.03 ether, 3, bytes32(0))); // append
        vm.stopPrank();
        assertEq(d.phases().length, 3);
    }

    function test_MetadataFreezeAndEdition() public {
        InsaDrop d = _drop();
        vm.prank(alice);
        d.mint(0, 1, _proof(bob));
        assertEq(d.tokenURI(1), "ipfs://x/1.json");
        vm.startPrank(creator);
        d.setBaseURI("ipfs://edition.json");
        assertEq(d.tokenURI(1), "ipfs://edition.json");
        d.freeze();
        vm.expectRevert(InsaDrop.IsFrozen.selector);
        d.setBaseURI("ipfs://rug/");
        vm.stopPrank();
    }

    function test_RoyaltyOnlyDown() public {
        InsaDrop d = _drop();
        (, uint256 r) = d.royaltyInfo(1, 1 ether);
        assertEq(r, 0.05 ether);
        vm.startPrank(creator);
        vm.expectRevert(InsaDrop.BadParams.selector);
        d.lowerRoyalty(600);
        d.lowerRoyalty(100);
        vm.stopPrank();
        (, r) = d.royaltyInfo(1, 1 ether);
        assertEq(r, 0.01 ether);
    }

    // ---- Tal ----

    function test_TalRevealFlow() public {
        TalRenderer rend = new TalRenderer(new TalArt());
        InsaDrop.Config memory c = InsaDrop.Config("Tal", "TAL", owner, treasury, 1000, 500, "", "", address(rend));
        InsaDrop.Phase[] memory ph = new InsaDrop.Phase[](1);
        ph[0] = InsaDrop.Phase(uint64(block.timestamp), 0, 0, 5, bytes32(0));
        vm.prank(owner);
        InsaDrop d = InsaDrop(factory.create(c, ph));
        vm.prank(alice);
        d.mint(0, 2, new bytes32[](0));
        string memory before = d.tokenURI(1);
        vm.expectRevert(InsaDrop.BadParams.selector);
        d.revealSeed();
        vm.prank(owner);
        d.commitSeed();
        vm.roll(vm.getBlockNumber() + 6);
        vm.setBlockhash(vm.getBlockNumber() - 1, keccak256("h"));
        d.revealSeed();
        assertTrue(d.seed() != 0);
        assertTrue(keccak256(bytes(d.tokenURI(1))) != keccak256(bytes(before)));
        vm.prank(owner);
        vm.expectRevert(InsaDrop.BadParams.selector);
        d.commitSeed(); // the seed is final
    }

    // ---- market ----

    function _minted() internal returns (InsaDrop d) {
        d = _drop();
        vm.prank(alice);
        d.mint(0, 1, _proof(bob)); // alice #1
        vm.prank(bob);
        d.mint(0, 1, _proof(alice)); // bob #2
        vm.prank(alice);
        d.setApprovalForAll(address(market), true);
        vm.prank(bob);
        d.setApprovalForAll(address(market), true);
    }

    function test_ListAndBuyPaysRoyaltyAndFee() public {
        InsaDrop d = _minted();
        vm.prank(alice);
        market.list(address(d), 1, 1 ether, uint64(block.timestamp + 1 days));
        assertTrue(market.isLive(address(d), 1));
        uint256 a0 = alice.balance;
        vm.prank(carol);
        vm.expectRevert(InsaMarket.WrongPayment.selector);
        market.buy{value: 0.9 ether}(address(d), 1);
        vm.prank(carol);
        market.buy{value: 1 ether}(address(d), 1);
        assertEq(d.ownerOf(1), carol);
        assertEq(creator.balance, 0.05 ether);
        assertEq(treasury.balance, 0.02 ether);
        assertEq(alice.balance - a0, 0.93 ether);
        (address s,,) = market.listings(address(d), 1);
        assertEq(s, address(0));
    }

    function test_StaleListingCannotBeBought() public {
        InsaDrop d = _minted();
        vm.startPrank(alice);
        market.list(address(d), 1, 1 ether, uint64(block.timestamp + 1 days));
        d.transferFrom(alice, bob, 1);
        vm.stopPrank();
        assertFalse(market.isLive(address(d), 1));
        vm.prank(carol);
        vm.expectRevert();
        market.buy{value: 1 ether}(address(d), 1);
        market.unlist(address(d), 1); // anyone clears it now
        vm.prank(alice);
        vm.expectRevert(InsaMarket.NotOwner.selector);
        market.list(address(d), 1, 1 ether, uint64(block.timestamp + 1 days));
    }

    function test_ExpiredListing() public {
        InsaDrop d = _minted();
        vm.prank(alice);
        market.list(address(d), 1, 1 ether, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);
        vm.prank(carol);
        vm.expectRevert(InsaMarket.NotListed.selector);
        market.buy{value: 1 ether}(address(d), 1);
    }

    function test_CollectionOfferAcceptedByAnyHolder() public {
        InsaDrop d = _minted();
        vm.prank(alice);
        market.list(address(d), 2 - 1, 5 ether, uint64(block.timestamp + 1 days));
        vm.prank(carol);
        uint256 id = market.makeOffer{value: 0.5 ether}(address(d), type(uint256).max, uint64(block.timestamp + 1 days));
        assertEq(address(market).balance, 0.5 ether);
        uint256 a0 = alice.balance;
        vm.prank(bob);
        vm.expectRevert(InsaMarket.NotOwner.selector);
        market.acceptOffer(id, 1); // bob does not own #1
        vm.prank(alice);
        market.acceptOffer(id, 1);
        assertEq(d.ownerOf(1), carol);
        assertEq(alice.balance - a0, 0.5 ether * 93 / 100);
        (address s,,) = market.listings(address(d), 1);
        assertEq(s, address(0)); // the old listing went with the sale
        vm.prank(bob);
        vm.expectRevert(InsaMarket.NotOpen.selector);
        market.acceptOffer(id, 2); // one offer, one sale
        assertEq(address(market).balance, 0);
    }

    function test_TokenOfferOnlyThatToken() public {
        InsaDrop d = _minted();
        vm.prank(carol);
        uint256 id = market.makeOffer{value: 0.5 ether}(address(d), 2, uint64(block.timestamp + 1 days));
        vm.prank(alice);
        vm.expectRevert(InsaMarket.BadParams.selector);
        market.acceptOffer(id, 1);
    }

    function test_OfferCancelAndExpiry() public {
        InsaDrop d = _minted();
        vm.prank(carol);
        uint256 id = market.makeOffer{value: 0.5 ether}(address(d), 1, uint64(block.timestamp + 1 days));
        vm.prank(bob);
        vm.expectRevert(InsaMarket.NotOwner.selector);
        market.cancelOffer(id);
        vm.warp(block.timestamp + 2 days);
        uint256 c0 = carol.balance;
        vm.prank(bob);
        market.cancelOffer(id); // expired: anyone returns it
        assertEq(carol.balance - c0, 0.5 ether);
        vm.prank(alice);
        vm.expectRevert(InsaMarket.NotOpen.selector);
        market.acceptOffer(id, 1);
    }

    function test_SellerThatRefusesEthIsCredited() public {
        InsaDrop d = _minted();
        Refuser r = new Refuser();
        vm.prank(alice);
        d.transferFrom(alice, address(r), 1);
        r.approve(d, address(market));
        r.list(market, address(d), 1, 1 ether);
        vm.prank(carol);
        market.buy{value: 1 ether}(address(d), 1);
        assertEq(d.ownerOf(1), carol);
        assertEq(market.owed(address(r)), 0.93 ether);
    }

    function test_FeeTimelock() public {
        vm.prank(owner);
        vm.expectRevert(InsaMarket.BadParams.selector);
        market.proposeFee(treasury, 501);
        vm.prank(owner);
        market.proposeFee(treasury, 300);
        vm.expectRevert(InsaMarket.TooEarly.selector);
        market.applyFee();
        vm.warp(block.timestamp + 2 days);
        market.applyFee();
        assertEq(market.feeBps(), 300);
    }

    function testFuzz_SplitConserves(uint96 price) public {
        InsaDrop d = _minted();
        (, uint256 roy, uint256 fee, uint256 rest) = market.split(address(d), 1, price);
        assertEq(roy + fee + rest, price);
    }

    /// The web app's Merkle tree (web/src/lib/merkle.ts) against OpenZeppelin's verifier.
    function test_WebMerkleTreeMatches() public {
        bytes32[] memory p = new bytes32[](3);
        p[0] = 0x607bca8f7c1c56da874da29cd62c3769b9880d38a258a91fc6dd1cfb6b4d1a8e;
        p[1] = 0x161691c7185a37ff918e70bebef716ddd87844ac47f419ea23eaf4fe983fbf2c;
        p[2] = 0x5d64dafd8733aa7fbd594dd0d1cc2e8ed1e915d86eeb5dcdd2010cfc80a376f9;
        InsaDrop.Phase[] memory ph = new InsaDrop.Phase[](1);
        ph[0] = InsaDrop.Phase(uint64(block.timestamp), 0, 0, 1, 0x7523248e4e372c90556b5b5f3851dcb8b955a5a9093f770f734d3eb9560b0465);
        vm.prank(creator);
        InsaDrop d = InsaDrop(factory.create(_cfg(10), ph));
        vm.prank(address(3));
        d.mint(0, 1, p);
        assertEq(d.ownerOf(1), address(3));
    }
}
