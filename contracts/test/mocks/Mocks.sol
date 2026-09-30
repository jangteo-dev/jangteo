// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IDojangScroll, IEAS} from "../../src/interfaces/IExternal.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 dec_) ERC20("Mock", "MOCK") {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockScroll is IDojangScroll {
    mapping(address => mapping(bytes32 => bool)) public v;
    bool public broken;

    function set(address a, bytes32 id, bool on) external {
        v[a][id] = on;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function isVerified(address addr, bytes32 attesterId) external view returns (bool) {
        require(!broken, "broken");
        return v[addr][attesterId];
    }
}

contract MockEAS is IEAS {
    uint256 public count;
    bool public fail;
    mapping(address => bytes) public lastData;

    function setFail(bool f) external {
        fail = f;
    }

    function attest(AttestationRequest calldata request) external payable returns (bytes32) {
        require(!fail, "eas down");
        ++count;
        lastData[request.data.recipient] = request.data.data;
        return keccak256(abi.encode(count));
    }
}
