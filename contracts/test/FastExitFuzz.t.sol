// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {JangteoFastExit, IL2Messenger} from "../src/bridge/JangteoFastExit.sol";
import {JangteoFastVault, IL1Messenger} from "../src/bridge/JangteoFastVault.sol";

/// Queues every L2 message so settlements can arrive in any order, like real withdrawals.
contract QueueMessengers is IL2Messenger, IL1Messenger {
    struct Msg {
        address target;
        bytes data;
        uint256 value;
        address sender;
    }
    Msg[] public q;
    address internal relaying;

    function sendMessage(address t, bytes calldata m, uint32) external payable {
        q.push(Msg(t, m, msg.value, msg.sender));
    }

    function count() external view returns (uint256) {
        return q.length;
    }

    function relay(uint256 i) external returns (bool ok) {
        Msg storage m = q[i];
        if (m.target == address(0)) return false;
        relaying = m.sender;
        (ok,) = m.target.call{value: m.value}(m.data);
        relaying = address(0);
        if (ok) delete q[i];
    }

    function xDomainMessageSender() external view returns (address) {
        return relaying;
    }
}

contract FastHandler is Test {
    JangteoFastExit public exitc;
    JangteoFastVault public vault;
    QueueMessengers public m;
    address filler = makeAddr("filler");
    address[] users;
    // ghost ledger
    uint256 public deposited;
    uint256 public paidOutFast;
    uint256 public settled;
    mapping(uint256 => address) public toOf;
    mapping(uint256 => uint256) public outOf;
    mapping(uint256 => uint256) public amountOf;
    uint256 public exits;

    constructor(JangteoFastExit e, JangteoFastVault v, QueueMessengers mm) {
        (exitc, vault, m) = (e, v, mm);
        for (uint256 i; i < 4; ++i) {
            address u = makeAddr(string(abi.encode("user", i)));
            users.push(u);
            vm.deal(u, 100 ether);
        }
        vm.deal(filler, 1_000 ether);
    }

    function exit(uint256 u, uint256 amt, uint256 r) external {
        amt = bound(amt, exitc.minExit(), exitc.maxExit());
        address from = users[u % users.length];
        address to = users[r % users.length];
        vm.prank(from);
        uint256 id = exitc.exit{value: amt}(to);
        (uint256 out,) = exitc.quote(amt);
        (toOf[id], outOf[id], amountOf[id]) = (to, out, amt);
        deposited += amt;
        exits = id;
    }

    function fill(uint256 i, bool wrong) external {
        if (exits == 0) return;
        uint256 id = (i % exits) + 1;
        uint256 out = outOf[id] - (wrong ? 1 : 0);
        vm.prank(filler);
        try vault.fill{value: out}(id, toOf[id], out) {
            if (!wrong) paidOutFast += out;
        } catch {}
    }

    function wealth() external view returns (uint256 w) {
        for (uint256 i; i < users.length; ++i) w += users[i].balance;
        w += filler.balance + address(vault).balance + address(m).balance;
    }

    function relay(uint256 i) external {
        uint256 n = m.count();
        if (n == 0) return;
        uint256 k = i % n;
        (, , uint256 value,) = m.q(k);
        if (m.relay(k)) settled += value;
    }
}

contract FastExitFuzzTest is Test {
    FastHandler h;
    JangteoFastVault vault;

    function setUp() public {
        QueueMessengers m = new QueueMessengers();
        vault = new JangteoFastVault(address(this), IL1Messenger(address(m)));
        JangteoFastExit e = new JangteoFastExit(address(this), IL2Messenger(address(m)), address(vault), 100, 0.0005 ether, 0.005 ether, 0.5 ether);
        vault.setL2Exit(address(e));
        h = new FastHandler(e, vault, m);
        targetContract(address(h));
    }

    /// The vault never keeps ETH it does not owe to someone (bounced payments only).
    function invariant_vault_holds_only_owed() public view {
        // owed can only be non-zero for addresses that reject ETH; none here, so the vault is empty.
        assertEq(address(vault).balance, 0);
    }

    /// Every settled exit moved exactly its deposit: nothing created, nothing lost.
    /// ETH is conserved across users, the filler, the vault and messages still in flight.
    function invariant_eth_conserved() public view {
        assertEq(h.wealth(), 4 * 100 ether + 1_000 ether);
    }

    function invariant_settlements_conserve() public view {
        assertLe(h.settled(), h.deposited());
    }
}
