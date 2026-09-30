// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title InsaMarket — 인사동 Insadong, Jangteo's market for any ERC-721 on GIWA.
///
/// @notice Listings and offers live on-chain, so there is no off-chain order book to trust.
///
///   Listing     the owner approves the market once and lists at a fixed ETH price until an
///               expiry. The NFT stays in the owner's wallet; a listing whose seller no longer
///               owns the token simply cannot be bought.
///   Offer       a buyer escrows ETH here for one token or for any token of a collection; the
///               owner of a matching token accepts. The buyer can take the ETH back at any time,
///               and anyone can return an expired offer to its buyer.
///   Payout      on every sale the creator's ERC-2981 royalty (capped at 10%) and Jangteo's fee
///               (at most 5%) come off the price and the rest goes to the seller. A payee whose
///               wallet refuses ETH is credited and withdraws later, so no one can block a sale.
///   Fee         a new fee takes effect only DELAY after it is announced.
contract InsaMarket is Ownable2Step, ReentrancyGuard {
    uint16 public constant MAX_FEE_BPS = 500;
    uint16 public constant MAX_ROYALTY_BPS = 1000;
    uint64 public constant DELAY = 2 days;
    uint256 public constant ANY = type(uint256).max;
    uint256 public constant MIN_PRICE = 1e12; // 0.000001 ETH

    struct Listing {
        address seller;
        uint128 price;
        uint64 expiry;
    }

    struct Offer {
        address buyer;
        address collection;
        uint256 tokenId; // ANY = any token of the collection
        uint128 price;
        uint64 expiry;
        bool open;
    }

    address public treasury;
    uint16 public feeBps;
    address public pendingTreasury;
    uint16 public pendingFeeBps;
    uint64 public pendingEta;

    mapping(address => mapping(uint256 => Listing)) public listings;
    Offer[] public offers;
    mapping(address => uint256) public owed;

    event Listed(address indexed collection, uint256 indexed tokenId, address indexed seller, uint256 price, uint64 expiry);
    event Unlisted(address indexed collection, uint256 indexed tokenId);
    event Sold(address indexed collection, uint256 indexed tokenId, address seller, address buyer, uint256 price, uint256 royalty, uint256 fee, uint256 offerId);
    event OfferMade(uint256 indexed id, address indexed collection, uint256 indexed tokenId, address buyer, uint256 price, uint64 expiry);
    event OfferClosed(uint256 indexed id, bool accepted);
    event Owed(address indexed to, uint256 amount);
    event FeeProposed(address treasury, uint16 feeBps, uint64 eta);
    event FeeSet(address treasury, uint16 feeBps);

    error BadParams();
    error NotOwner();
    error NotApproved();
    error NotListed();
    error WrongPayment();
    error NotOpen();
    error TooEarly();
    error TransferFailed();

    constructor(address owner_, address treasury_, uint16 feeBps_) Ownable(owner_) {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadParams();
        treasury = treasury_;
        feeBps = feeBps_;
        emit FeeSet(treasury_, feeBps_);
    }

    // ---- listings -------------------------------------------------------------------------------

    function list(address collection, uint256 tokenId, uint128 price, uint64 expiry) external {
        if (price < MIN_PRICE || expiry <= block.timestamp) revert BadParams();
        IERC721 c = IERC721(collection);
        if (c.ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (!c.isApprovedForAll(msg.sender, address(this)) && c.getApproved(tokenId) != address(this)) revert NotApproved();
        listings[collection][tokenId] = Listing(msg.sender, price, expiry);
        emit Listed(collection, tokenId, msg.sender, price, expiry);
    }

    /// @notice The seller cancels; anyone may clear a listing whose seller no longer owns the token.
    function unlist(address collection, uint256 tokenId) external {
        Listing memory l = listings[collection][tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (msg.sender != l.seller && _ownerOf(collection, tokenId) == l.seller) revert NotOwner();
        delete listings[collection][tokenId];
        emit Unlisted(collection, tokenId);
    }

    /// @notice True when `buy` would go through (for the UI and indexers).
    function isLive(address collection, uint256 tokenId) public view returns (bool) {
        Listing memory l = listings[collection][tokenId];
        if (l.seller == address(0) || l.expiry <= block.timestamp || _ownerOf(collection, tokenId) != l.seller) return false;
        IERC721 c = IERC721(collection);
        return c.isApprovedForAll(l.seller, address(this)) || c.getApproved(tokenId) == address(this);
    }

    /// @notice Buy at exactly the listed price: if the seller changed it, the purchase reverts.
    function buy(address collection, uint256 tokenId) external payable nonReentrant {
        Listing memory l = listings[collection][tokenId];
        if (l.seller == address(0) || l.expiry <= block.timestamp) revert NotListed();
        if (msg.value != l.price) revert WrongPayment();
        delete listings[collection][tokenId];
        IERC721(collection).safeTransferFrom(l.seller, msg.sender, tokenId);
        _settle(collection, tokenId, l.seller, msg.sender, l.price, type(uint256).max);
    }

    // ---- offers ---------------------------------------------------------------------------------

    function offerCount() external view returns (uint256) {
        return offers.length;
    }

    function makeOffer(address collection, uint256 tokenId, uint64 expiry) external payable returns (uint256 id) {
        if (msg.value < MIN_PRICE || msg.value > type(uint128).max || expiry <= block.timestamp || collection.code.length == 0) revert BadParams();
        id = offers.length;
        offers.push(Offer(msg.sender, collection, tokenId, uint128(msg.value), expiry, true));
        emit OfferMade(id, collection, tokenId, msg.sender, msg.value, expiry);
    }

    /// @notice The buyer takes the offer back; anyone may return an expired offer to its buyer.
    function cancelOffer(uint256 id) external nonReentrant {
        Offer storage o = offers[id];
        if (!o.open) revert NotOpen();
        if (msg.sender != o.buyer && block.timestamp < o.expiry) revert NotOwner();
        o.open = false;
        emit OfferClosed(id, false);
        _pay(o.buyer, o.price);
    }

    /// @notice The owner of `tokenId` sells it into offer `id` (an offer's price never changes).
    function acceptOffer(uint256 id, uint256 tokenId) external nonReentrant {
        Offer storage o = offers[id];
        if (!o.open || o.expiry <= block.timestamp) revert NotOpen();
        if (o.tokenId != ANY && o.tokenId != tokenId) revert BadParams();
        address collection = o.collection;
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotOwner();
        o.open = false;
        emit OfferClosed(id, true);
        if (listings[collection][tokenId].seller != address(0)) {
            delete listings[collection][tokenId];
            emit Unlisted(collection, tokenId);
        }
        IERC721(collection).safeTransferFrom(msg.sender, o.buyer, tokenId);
        _settle(collection, tokenId, msg.sender, o.buyer, o.price, id);
    }

    // ---- money ----------------------------------------------------------------------------------

    function withdrawOwed() external nonReentrant {
        uint256 a = owed[msg.sender];
        if (a == 0) revert NotOpen();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice What a sale at `price` pays out: creator royalty, Jangteo fee, and the seller's rest.
    function split(address collection, uint256 tokenId, uint256 price) public view returns (address royaltyTo, uint256 royalty, uint256 fee, uint256 seller) {
        try IERC2981(collection).royaltyInfo(tokenId, price) returns (address r, uint256 amt) {
            uint256 cap = price * MAX_ROYALTY_BPS / 10_000;
            (royaltyTo, royalty) = r == address(0) ? (address(0), 0) : (r, amt > cap ? cap : amt);
        } catch {}
        fee = price * feeBps / 10_000;
        seller = price - royalty - fee;
    }

    function proposeFee(address treasury_, uint16 feeBps_) external onlyOwner {
        if (treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadParams();
        pendingTreasury = treasury_;
        pendingFeeBps = feeBps_;
        pendingEta = uint64(block.timestamp) + DELAY;
        emit FeeProposed(treasury_, feeBps_, pendingEta);
    }

    function applyFee() external {
        if (pendingEta == 0 || block.timestamp < pendingEta) revert TooEarly();
        treasury = pendingTreasury;
        feeBps = pendingFeeBps;
        pendingEta = 0;
        emit FeeSet(treasury, feeBps);
    }

    // ---- internals ------------------------------------------------------------------------------

    function _settle(address collection, uint256 tokenId, address seller, address buyer, uint256 price, uint256 offerId) internal {
        (address royaltyTo, uint256 royalty, uint256 fee, uint256 rest) = split(collection, tokenId, price);
        if (royalty > 0) _pay(royaltyTo, royalty);
        if (fee > 0) _pay(treasury, fee);
        _pay(seller, rest);
        emit Sold(collection, tokenId, seller, buyer, price, royalty, fee, offerId);
    }

    /// A payee that refuses ETH (or burns all the gas) is credited instead of blocking the sale.
    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) {
            owed[to] += amount;
            emit Owed(to, amount);
        }
    }

    function _ownerOf(address collection, uint256 tokenId) internal view returns (address o) {
        try IERC721(collection).ownerOf(tokenId) returns (address a) {
            o = a;
        } catch {}
    }
}
