// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IDojangScroll} from "../interfaces/IExternal.sol";
import {IIdentityGate} from "../interfaces/IGye.sol";

/// @title DojangGate
/// @notice An account is eligible when any accepted Dojang attester has issued it a live
///         Verified Address attestation. On mainnet the only accepted attester is Upbit Korea;
///         on GIWA Sepolia the playground's TESTNET FAUCET attester is accepted too.
contract DojangGate is IIdentityGate, Ownable2Step {
    IDojangScroll public immutable scroll;

    bytes32[] private _attesters;
    mapping(bytes32 => bool) public accepted;

    event AttesterSet(bytes32 indexed attesterId, bool accepted);

    error AlreadySet();

    constructor(address owner_, IDojangScroll scroll_, bytes32[] memory attesters) Ownable(owner_) {
        scroll = scroll_;
        for (uint256 i; i < attesters.length; ++i) {
            _set(attesters[i], true);
        }
    }

    function setAttester(bytes32 attesterId, bool on) external onlyOwner {
        _set(attesterId, on);
    }

    function attesters() external view returns (bytes32[] memory) {
        return _attesters;
    }

    function isEligible(address account) external view returns (bool) {
        uint256 n = _attesters.length;
        for (uint256 i; i < n; ++i) {
            // A broken or upgraded scroll must not brick joins for other attesters.
            try scroll.isVerified(account, _attesters[i]) returns (bool ok) {
                if (ok) return true;
            } catch {}
        }
        return false;
    }

    function _set(bytes32 attesterId, bool on) private {
        if (accepted[attesterId] == on) revert AlreadySet();
        accepted[attesterId] = on;
        if (on) {
            _attesters.push(attesterId);
        } else {
            uint256 n = _attesters.length;
            for (uint256 i; i < n; ++i) {
                if (_attesters[i] == attesterId) {
                    _attesters[i] = _attesters[n - 1];
                    _attesters.pop();
                    break;
                }
            }
        }
        emit AttesterSet(attesterId, on);
    }
}
