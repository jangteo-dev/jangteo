// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {JangteoPump} from "./JangteoPump.sol";

interface IV2Router {
    function factory() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory);
    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        returns (uint256[] memory);
}

/// @title JangteoPumpRouter — one Uniswap V2 interface for 장터 펌프 tokens, before and after graduation.
///
/// @notice Wallets, bots and aggregators that already trade Uniswap V2 can point at this router
///         and buy or sell any 장터 펌프 token with the same calls: before graduation the trade
///         goes to the token's bonding curve, after it to its 장터 스왑 pool. Every other path is
///         passed straight to 장터 스왑's Router02. The router holds nothing between calls.
contract JangteoPumpRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    JangteoPump public immutable pump;
    IV2Router public immutable v2;
    address public immutable WETH;

    error BadPath();
    error Expired();
    error TransferFailed();

    constructor(JangteoPump pump_, IV2Router v2_, address weth_) {
        pump = pump_;
        v2 = v2_;
        WETH = weth_;
    }

    receive() external payable {}

    function factory() external view returns (address) {
        return v2.factory();
    }

    /// @dev A two-hop ETH path whose token is still on its curve.
    function _onCurve(address[] calldata path) private view returns (bool buying, address token) {
        if (path.length != 2) return (false, address(0));
        if (path[0] == WETH && pump.isLaunch(path[1]) && !pump.launch(path[1]).graduated) return (true, path[1]);
        if (path[1] == WETH && pump.isLaunch(path[0]) && !pump.launch(path[0]).graduated) return (false, path[0]);
        return (false, address(0));
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        (bool buying, address token) = _onCurve(path);
        if (token == address(0)) return v2.getAmountsOut(amountIn, path);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        if (buying) (amounts[1],,) = pump.quoteBuy(token, amountIn);
        else amounts[1] = pump.quoteSell(token, amountIn);
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256[] memory amounts)
    {
        if (block.timestamp > deadline) revert Expired();
        (bool buying, address token) = _onCurve(path);
        if (token == address(0)) return v2.swapExactETHForTokens{value: msg.value}(amountOutMin, path, to, deadline);
        if (!buying) revert BadPath();
        uint256 before = address(this).balance - msg.value;
        uint256 out = pump.buyFor{value: msg.value}(token, to, amountOutMin, deadline);
        // ETH past the graduation line comes back here; hand it on.
        uint256 refund = address(this).balance - before;
        if (refund > 0) _send(msg.sender, refund);
        amounts = new uint256[](2);
        amounts[0] = msg.value - refund;
        amounts[1] = out;
    }

    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256[] memory amounts)
    {
        if (block.timestamp > deadline) revert Expired();
        (bool buying, address token) = _onCurve(path);
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        if (token == address(0)) {
            IERC20(path[0]).forceApprove(address(v2), amountIn);
            return v2.swapExactTokensForETH(amountIn, amountOutMin, path, to, deadline);
        }
        if (buying) revert BadPath();
        IERC20(token).forceApprove(address(pump), amountIn);
        uint256 out = pump.sell(token, amountIn, amountOutMin, deadline);
        _send(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
