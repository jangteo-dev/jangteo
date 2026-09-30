// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWETHAgg {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IV2PairAgg {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// KachiSwap pairs: Uniswap V2 layout, but fees are cut from the input (regular pools) or, on launch
/// pools, from the quote side in either direction at a tier set by the pool's market cap.
interface IKachiPair {
    function poolType() external view returns (uint8);
    function protocolFeeBps() external view returns (uint16);
    function lpFeeBps() external view returns (uint16);
    function quoteToken() external view returns (address);
}

/// Some GIWA forks (Naruswap) dropped the flash-swap `data` argument.
interface IV2PairNoData {
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external;
}

interface IV2FactoryAgg {
    function getPair(address, address) external view returns (address);
}

interface IV3PoolAgg {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @title JangteoAggregator — 장터 스왑's route through every DEX on GIWA.
///
/// @notice Swaps along a route the web picks from the indexer's pool list: any Uniswap V2-style pair
///         (any factory, its own fee) or V3-style pool, one or several hops, ETH in or out. A route
///         that stays entirely inside 장터 스왑's own pairs pays no aggregator fee (those pairs
///         already earn Jangteo its protocol share); any other route pays `feeBps` of the input to
///         the treasury. The contract holds nothing between calls: every hop's output is measured
///         by balance, and whatever a V3 pool leaves unspent goes back to the sender.
contract JangteoAggregator is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 100;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address public immutable weth;
    IV2FactoryAgg public immutable home; // 장터 스왑's factory: routes inside it are fee-free
    address public treasury;
    uint16 public feeBps;

    /// @dev The one pool allowed to call back during the current V3 hop.
    address transient activePool;
    /// @dev Most the active pool may take, so a pool can never pull more than its hop's input.
    uint256 transient activeMax;

    uint8 public constant V2 = 0; // Uniswap V2 pair
    uint8 public constant V2_NO_DATA = 1; // V2 pair whose swap() has no data argument
    uint8 public constant V3 = 2; // Uniswap V3-style pool (Uniswap, PancakeSwap, Algebra callbacks)
    uint8 public constant KACHI = 3; // KachiSwap pair (regular or launch pool)

    struct Hop {
        address pool;
        uint8 kind;
        uint24 fee; // V2 kinds only: the pair's swap fee in millionths (3000 = 0.3%)
    }

    event Swapped(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee);
    event ParamsSet(address treasury, uint16 feeBps);

    error BadRoute();
    error Expired();
    error TooLittleReceived(uint256 out);
    error BadCallback();
    error TransferFailed();

    constructor(address owner_, address weth_, IV2FactoryAgg home_, address treasury_, uint16 feeBps_) Ownable(owner_) {
        weth = weth_;
        home = home_;
        _set(treasury_, feeBps_);
    }

    receive() external payable {
        if (msg.sender != weth) revert BadRoute();
    }

    function setParams(address treasury_, uint16 feeBps_) external onlyOwner {
        _set(treasury_, feeBps_);
    }

    /// @notice Swap `amountIn` of `path[0]` for at least `minOut` of the last token, to `to`.
    /// @param path tokens along the route; address(0) as the first or last means native ETH.
    function swap(address[] calldata path, Hop[] calldata hops, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert Expired();
        _check(path, hops);
        if (to == address(0) || amountIn == 0) revert BadRoute();
        address tokenIn = _wrapped(path[0]);
        uint256 fee = feeFor(path, hops, amountIn);

        if (path[0] == address(0)) {
            if (msg.value != amountIn) revert BadRoute();
            if (fee > 0) _sendEth(treasury, fee);
            IWETHAgg(weth).deposit{value: amountIn - fee}();
        } else {
            if (msg.value != 0) revert BadRoute();
            uint256 before = IERC20(tokenIn).balanceOf(address(this));
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
            // A token that takes a cut on transfer arrives short: route what actually arrived.
            uint256 got = IERC20(tokenIn).balanceOf(address(this)) - before;
            fee = got * fee / amountIn;
            if (fee > 0) IERC20(tokenIn).safeTransfer(treasury, fee);
            amountIn = got;
        }

        uint256 amt = amountIn - fee;
        for (uint256 i; i < hops.length; ++i) {
            amt = _hop(hops[i], _wrapped(path[i]), _wrapped(path[i + 1]), amt);
        }
        out = amt;
        if (out < minOut) revert TooLittleReceived(out);

        address last = path[path.length - 1];
        if (last == address(0)) {
            IWETHAgg(weth).withdraw(out);
            _sendEth(to, out);
        } else {
            IERC20(last).safeTransfer(to, out);
        }
        emit Swapped(msg.sender, path[0], last, amountIn, out, fee);
    }

    /// @notice What `swap` would pay out for `amountIn`, fee included. Not a view (V3 pools are
    ///         asked by a swap that reverts inside the callback); call it with eth_call.
    function quote(address[] calldata path, Hop[] calldata hops, uint256 amountIn) external nonReentrant returns (uint256 out) {
        _check(path, hops);
        out = amountIn - feeFor(path, hops, amountIn);
        for (uint256 i; i < hops.length; ++i) {
            address a = _wrapped(path[i]);
            address b = _wrapped(path[i + 1]);
            if (hops[i].kind == V3) {
                out = _quoteV3(hops[i].pool, a, b, out);
            } else {
                (uint256 rIn, uint256 rOut) = _reserves(hops[i].pool, a);
                out = _pairOut(hops[i], a, out, rIn, rOut);
            }
            if (out == 0) return 0;
        }
    }

    /// @notice The aggregator fee on `amountIn` along this route: zero inside 장터 스왑's own pairs.
    function feeFor(address[] calldata path, Hop[] calldata hops, uint256 amountIn) public view returns (uint256) {
        if (feeBps == 0) return 0;
        bool homeOnly = true;
        for (uint256 i; i < hops.length && homeOnly; ++i) {
            homeOnly = hops[i].kind == V2 && home.getPair(_wrapped(path[i]), _wrapped(path[i + 1])) == hops[i].pool;
        }
        return homeOnly ? 0 : amountIn * feeBps / 10_000;
    }

    // ---- V3 callbacks (Uniswap, PancakeSwap and Algebra spell it differently) --------------------

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata data) external {
        _callback(d0, d1, data);
    }

    function pancakeV3SwapCallback(int256 d0, int256 d1, bytes calldata data) external {
        _callback(d0, d1, data);
    }

    function algebraSwapCallback(int256 d0, int256 d1, bytes calldata data) external {
        _callback(d0, d1, data);
    }

    // ---- internals ------------------------------------------------------------------------------

    function _callback(int256 d0, int256 d1, bytes calldata data) internal {
        if (msg.sender != activePool || activePool == address(0)) revert BadCallback();
        (address tokenIn, bool quoting) = abi.decode(data, (address, bool));
        (uint256 pay, uint256 got) = d0 > 0 ? (uint256(d0), uint256(-d1)) : (uint256(d1), uint256(-d0));
        if (quoting) {
            assembly {
                let p := mload(0x40)
                mstore(p, got)
                revert(p, 32)
            }
        }
        if (pay > activeMax) revert BadCallback();
        IERC20(tokenIn).safeTransfer(msg.sender, pay);
    }

    function _hop(Hop calldata h, address a, address b, uint256 amt) internal returns (uint256) {
        uint256 before = IERC20(b).balanceOf(address(this));
        if (h.kind == V3) {
            uint256 aBefore = IERC20(a).balanceOf(address(this));
            activePool = h.pool;
            activeMax = amt;
            bool zeroForOne = a < b;
            IV3PoolAgg(h.pool).swap(
                address(this), zeroForOne, int256(amt), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(a, false)
            );
            activePool = address(0);
            activeMax = 0;
            // A pool that ran out of range leaves part of the input unspent: it goes back to the sender.
            uint256 spent = aBefore - IERC20(a).balanceOf(address(this));
            if (spent < amt) IERC20(a).safeTransfer(msg.sender, amt - spent);
        } else {
            IERC20(a).safeTransfer(h.pool, amt);
            (uint256 rIn, uint256 rOut) = _reserves(h.pool, a);
            // Measured at the pair, so tokens that tax transfers still route.
            uint256 inPair = IERC20(a).balanceOf(h.pool) - rIn;
            uint256 o = _pairOut(h, a, inPair, rIn, rOut);
            (uint256 o0, uint256 o1) = a < b ? (uint256(0), o) : (o, uint256(0));
            if (h.kind == V2_NO_DATA) IV2PairNoData(h.pool).swap(o0, o1, address(this));
            else IV2PairAgg(h.pool).swap(o0, o1, address(this), "");
        }
        return IERC20(b).balanceOf(address(this)) - before;
    }

    function _quoteV3(address pool, address a, address b, uint256 amt) internal returns (uint256) {
        activePool = pool;
        bool zeroForOne = a < b;
        try IV3PoolAgg(pool).swap(
            address(this), zeroForOne, int256(amt), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(a, true)
        ) {
            activePool = address(0);
            return 0; // a pool that did not call back is not one we can quote
        } catch (bytes memory r) {
            activePool = address(0);
            return r.length == 32 ? abi.decode(r, (uint256)) : 0;
        }
    }

    function _reserves(address pair, address tokenIn) internal view returns (uint256 rIn, uint256 rOut) {
        (uint112 r0, uint112 r1,) = IV2PairAgg(pair).getReserves();
        (rIn, rOut) = IV2PairAgg(pair).token0() == tokenIn ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _pairOut(Hop calldata h, address tokenIn, uint256 amountIn, uint256 rIn, uint256 rOut) internal view returns (uint256) {
        return h.kind == KACHI ? _kachiOut(h.pool, tokenIn, amountIn, rIn, rOut) : _v2Out(amountIn, rIn, rOut, h.fee);
    }

    /// @dev The largest output KachiSwap's K check accepts, mirroring its _swapRegular/_swapLaunch.
    function _kachiOut(address pair, address tokenIn, uint256 amountIn, uint256 rIn, uint256 rOut) internal view returns (uint256) {
        if (amountIn == 0 || rIn == 0 || rOut == 0) return 0;
        IKachiPair k = IKachiPair(pair);
        uint256 lp = k.lpFeeBps();
        if (k.poolType() == 0) {
            uint256 cut = _ceilDiv(amountIn * k.protocolFeeBps(), 10_000);
            uint256 x = (amountIn - cut) * 10_000 - amountIn * lp;
            return rOut * x / (rIn * 10_000 + x);
        }
        address quote = k.quoteToken();
        bool quoteIn = tokenIn == quote;
        (uint256 rQ, uint256 rB) = quoteIn ? (rIn, rOut) : (rOut, rIn);
        address base = IV2PairAgg(pair).token0() == quote ? _token1(pair) : IV2PairAgg(pair).token0();
        (uint256 ext, uint256 tierLp) = _kachiTier(rQ * IERC20(base).totalSupply() / rB);
        if (quoteIn) {
            uint256 cut = _ceilDiv(amountIn * ext, 10_000);
            uint256 x = (amountIn - cut) * 10_000 - amountIn * tierLp;
            return rB * x / (rQ * 10_000 + x);
        }
        uint256 y = amountIn * (10_000 - tierLp);
        uint256 gross = rQ * y / (rB * 10_000 + y);
        return gross * (10_000 - ext) / 10_000;
    }

    /// @dev KachiPoolFeeSchedule.feesAt: (creator + protocol) bps and the LP bps at a market cap.
    function _kachiTier(uint256 mc) internal pure returns (uint256 ext, uint256 lp) {
        if (mc < 59_000e6) return (123, 2);
        lp = 30;
        if (mc < 300_000e6) return (105, lp);
        if (mc < 500_000e6) return (100, lp);
        if (mc < 700_000e6) return (95, lp);
        if (mc < 900_000e6) return (90, lp);
        if (mc < 2_000_000e6) return (85, lp);
        if (mc < 3_000_000e6) return (80, lp);
        if (mc < 4_000_000e6) return (75, lp);
        if (mc < 5_000_000e6) return (70, lp);
        if (mc < 6_000_000e6) return (65, lp);
        if (mc < 7_000_000e6) return (60, lp);
        if (mc < 8_000_000e6) return (55, lp);
        if (mc < 9_000_000e6) return (50, lp);
        if (mc < 10_000_000e6) return (45, lp);
        if (mc < 11_000_000e6) return (40, lp);
        if (mc < 12_000_000e6) return (38, lp);
        if (mc < 13_000_000e6) return (35, lp);
        if (mc < 14_000_000e6) return (33, lp);
        if (mc < 15_000_000e6) return (30, lp);
        if (mc < 16_000_000e6) return (28, lp);
        if (mc < 17_000_000e6) return (25, lp);
        if (mc < 18_000_000e6) return (23, lp);
        if (mc < 19_000_000e6) return (20, lp);
        if (mc < 20_000_000e6) return (18, lp);
        return (17, lp);
    }

    function _token1(address pair) internal view returns (address t) {
        (bool ok, bytes memory r) = pair.staticcall(abi.encodeWithSignature("token1()"));
        if (!ok || r.length < 32) revert BadRoute();
        t = abi.decode(r, (address));
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _v2Out(uint256 amountIn, uint256 rIn, uint256 rOut, uint24 fee) internal pure returns (uint256) {
        if (amountIn == 0 || rIn == 0 || rOut == 0) return 0;
        uint256 x = amountIn * (1_000_000 - fee);
        return x * rOut / (rIn * 1_000_000 + x);
    }

    function _check(address[] calldata path, Hop[] calldata hops) internal pure {
        if (hops.length == 0 || hops.length > 4 || path.length != hops.length + 1) revert BadRoute();
        for (uint256 i; i < hops.length; ++i) {
            if (hops[i].fee >= 1_000_000 || hops[i].kind > KACHI) revert BadRoute();
            // Native ETH may only open or close a route.
            if (i > 0 && path[i] == address(0)) revert BadRoute();
        }
    }

    function _wrapped(address t) internal view returns (address) {
        return t == address(0) ? weth : t;
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _set(address treasury_, uint16 feeBps_) internal {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadRoute();
        treasury = treasury_;
        feeBps = feeBps_;
        emit ParamsSet(treasury_, feeBps_);
    }
}
