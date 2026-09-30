// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title JangteoInvite — 장터 친구 초대, who brought whom.
///
/// @notice A wallet names the friend who invited it, once and for good. Nothing else happens here:
///         the season engine reads `Invited` events and credits the invite bonus only when both
///         sides are Dojang-verified people, so a pile of fresh wallets earns nothing.
contract JangteoInvite {
    mapping(address => address) public referrerOf;
    mapping(address => uint256) public invitedCount;

    event Invited(address indexed invitee, address indexed referrer);

    error AlreadyJoined();
    error BadReferrer();

    function join(address referrer) external {
        if (referrerOf[msg.sender] != address(0)) revert AlreadyJoined();
        // No self-invites and no two wallets inviting each other.
        if (referrer == address(0) || referrer == msg.sender || referrerOf[referrer] == msg.sender) revert BadReferrer();
        referrerOf[msg.sender] = referrer;
        invitedCount[referrer] += 1;
        emit Invited(msg.sender, referrer);
    }
}
