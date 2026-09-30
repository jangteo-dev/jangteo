// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IIdentityGate {
    function isEligible(address account) external view returns (bool);
}

interface IGyeReputation {
    function canJoin(address account) external view returns (bool);
    function holdbackBps(address account) external view returns (uint16);
    function availableCredit(address account) external view returns (uint256);

    function registerCircle(address circle) external;
    function onJoin(address account) external;
    function onLeave(address account) external;
    function onCreditDrawn(address account, uint256 usdAmount) external;
    function onFinish(address account, bool clean, uint256 contributedUsd, uint256 creditUsd, uint16 missed)
        external;
    function onDefault(address account, uint256 lossUsd) external;
}
