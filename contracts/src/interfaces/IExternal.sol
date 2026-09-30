// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Read surface of GIWA's DojangScroll (github.com/giwa-io/dojang).
interface IDojangScroll {
    function isVerified(address addr, bytes32 attesterId) external view returns (bool);
}

/// @notice Minimal EAS surface (GIWA predeploy 0x4200000000000000000000000000000000000021).
interface IEAS {
    struct AttestationRequestData {
        address recipient;
        uint64 expirationTime;
        bool revocable;
        bytes32 refUID;
        bytes data;
        uint256 value;
    }

    struct AttestationRequest {
        bytes32 schema;
        AttestationRequestData data;
    }

    function attest(AttestationRequest calldata request) external payable returns (bytes32);
}

/// @notice GIWA predeploy 0x4200000000000000000000000000000000000020.
interface ISchemaRegistry {
    function register(string calldata schema, address resolver, bool revocable) external returns (bytes32);
}
