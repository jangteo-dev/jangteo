// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Draws a token on-chain. `seed` is 0 until the collection is revealed.
interface IInsaRenderer {
    function tokenURI(address drop, uint256 id, uint256 seed) external view returns (string memory);
}

/// @title InsaDrop — one NFT collection launched on 인사동 Insadong, Jangteo's NFT market.
///
/// @notice Minting runs in phases (free or paid, allowlisted by a Merkle root or public, each with
///         its own window and per-wallet cap). The contract keeps the promises a minter relies on:
///
///   Supply      never above `maxSupply`; the creator may only lower it (to close a mint early).
///   Phases      a phase can be edited only before it starts, so its price and list cannot change
///               under a minter. Phases are appended up to MAX_PHASES.
///   Money       every mint splits at once into the creator's share and Jangteo's `platformBps`
///               (fixed at launch, at most 10%); `withdraw` pays both out, and anyone may call it.
///   Royalty     ERC-2981 to the creator, at most 10%, and it can only go down.
///   Metadata    `baseURI` ending in "/" serves `<base><id>.json`, otherwise every token shares it
///               (an edition). The creator can change it until `freeze`, which is permanent.
///               Collections drawn on-chain use a renderer and a seed that no one knows while
///               minting: `commitSeed` picks a block a few blocks ahead, `revealSeed` (anyone)
///               takes that block's hash.
contract InsaDrop is ERC721, ERC2981, ReentrancyGuard {
    using Strings for uint256;

    struct Phase {
        uint64 start;
        uint64 end;
        uint128 price; // per token, in wei
        uint32 perWallet; // 0 = no cap beyond MAX_PER_TX per call
        bytes32 root; // 0 = public
    }

    struct Config {
        string name;
        string symbol;
        address creator;
        address payout;
        uint32 maxSupply;
        uint16 royaltyBps;
        string baseURI;
        string contractURI;
        address renderer;
    }

    uint256 public constant MAX_PHASES = 5;
    uint256 public constant MAX_PER_TX = 20;
    uint16 public constant MAX_ROYALTY_BPS = 1000;

    address public immutable factory;
    address public immutable treasury;
    uint16 public immutable platformBps;

    address public creator;
    address public payout;
    address public renderer;
    uint32 public maxSupply;
    uint32 public totalSupply;
    uint16 public royaltyBps;
    bool public frozen;
    uint64 public seedBlock;
    uint256 public seed;
    string public baseURI;
    string public contractURI;
    uint256 public creatorOwed;
    uint256 public platformOwed;

    Phase[] internal _phases;
    mapping(uint256 => mapping(address => uint32)) public mintedIn;

    event PhaseSet(uint256 indexed index, Phase phase);
    event Minted(address indexed to, uint256 indexed phase, uint256 firstId, uint256 quantity, uint256 paid);
    event BaseURISet(string uri);
    event ContractURISet(string uri);
    event Frozen();
    event SupplyCapped(uint32 maxSupply);
    event SeedCommitted(uint64 block_);
    event SeedRevealed(uint256 seed);
    event Withdrawn(uint256 toCreator, uint256 toPlatform);
    event CreatorSet(address creator, address payout);
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    error NotCreator();
    error BadParams();
    error NotLive();
    error NotAllowed();
    error SoldOut();
    error WalletCap();
    error WrongPayment();
    error IsFrozen();
    error TransferFailed();

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }

    constructor(Config memory c, Phase[] memory phases_, address treasury_, uint16 platformBps_) ERC721(c.name, c.symbol) {
        if (c.creator == address(0) || c.payout == address(0) || c.maxSupply == 0 || c.royaltyBps > MAX_ROYALTY_BPS) revert BadParams();
        if (platformBps_ > 1000 || treasury_ == address(0) || phases_.length > MAX_PHASES) revert BadParams();
        factory = msg.sender;
        treasury = treasury_;
        platformBps = platformBps_;
        creator = c.creator;
        payout = c.payout;
        maxSupply = c.maxSupply;
        royaltyBps = c.royaltyBps;
        renderer = c.renderer;
        baseURI = c.baseURI;
        contractURI = c.contractURI;
        _setDefaultRoyalty(c.payout, c.royaltyBps);
        for (uint256 i; i < phases_.length; ++i) {
            _check(phases_[i]);
            _phases.push(phases_[i]);
            emit PhaseSet(i, phases_[i]);
        }
    }

    // ---- minting --------------------------------------------------------------------------------

    function phases() external view returns (Phase[] memory) {
        return _phases;
    }

    /// @notice Mint `quantity` in phase `index`; `proof` shows msg.sender is on that phase's list.
    function mint(uint256 index, uint256 quantity, bytes32[] calldata proof) external payable nonReentrant {
        if (index >= _phases.length) revert NotLive();
        Phase memory p = _phases[index];
        if (block.timestamp < p.start || (p.end != 0 && block.timestamp >= p.end)) revert NotLive();
        if (quantity == 0 || quantity > MAX_PER_TX) revert BadParams();
        if (p.root != bytes32(0)) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
            if (!MerkleProof.verifyCalldata(proof, p.root, leaf)) revert NotAllowed();
        }
        uint256 already = mintedIn[index][msg.sender];
        if (p.perWallet != 0 && already + quantity > p.perWallet) revert WalletCap();
        uint256 first = totalSupply + 1;
        if (first + quantity - 1 > maxSupply) revert SoldOut();
        uint256 cost = uint256(p.price) * quantity;
        if (msg.value != cost) revert WrongPayment();

        mintedIn[index][msg.sender] = uint32(already + quantity);
        totalSupply = uint32(first + quantity - 1);
        if (cost > 0) {
            uint256 fee = cost * platformBps / 10_000;
            platformOwed += fee;
            creatorOwed += cost - fee;
        }
        for (uint256 i; i < quantity; ++i) {
            _mint(msg.sender, first + i);
        }
        emit Minted(msg.sender, index, first, quantity, cost);
    }

    /// @notice Pays out the creator's and Jangteo's shares. Anyone can call it.
    function withdraw() external nonReentrant {
        uint256 c = creatorOwed;
        uint256 f = platformOwed;
        creatorOwed = 0;
        platformOwed = 0;
        if (c > 0) _send(payout, c);
        if (f > 0) _send(treasury, f);
        emit Withdrawn(c, f);
    }

    // ---- creator --------------------------------------------------------------------------------

    /// @notice Edit a phase that has not started, or append one.
    function setPhase(uint256 index, Phase calldata p) external onlyCreator {
        _check(p);
        if (p.start <= block.timestamp) revert BadParams();
        if (index == _phases.length) {
            if (index >= MAX_PHASES) revert BadParams();
            _phases.push(p);
        } else {
            if (index > _phases.length || _phases[index].start <= block.timestamp) revert BadParams();
            _phases[index] = p;
        }
        emit PhaseSet(index, p);
    }

    /// @notice Close the mint early: the cap can only come down, never below what is minted.
    function capSupply(uint32 newMax) external onlyCreator {
        if (newMax >= maxSupply || newMax < totalSupply) revert BadParams();
        maxSupply = newMax;
        emit SupplyCapped(newMax);
    }

    function setBaseURI(string calldata uri) external onlyCreator {
        if (frozen) revert IsFrozen();
        baseURI = uri;
        emit BaseURISet(uri);
        if (totalSupply > 0) emit BatchMetadataUpdate(1, totalSupply);
    }

    /// @notice Collection page details (description, images, links, allowlist files). Display only.
    function setContractURI(string calldata uri) external onlyCreator {
        contractURI = uri;
        emit ContractURISet(uri);
    }

    function freeze() external onlyCreator {
        frozen = true;
        emit Frozen();
    }

    function lowerRoyalty(uint16 bps) external onlyCreator {
        if (bps >= royaltyBps) revert BadParams();
        royaltyBps = bps;
        _setDefaultRoyalty(payout, bps);
    }

    /// @notice Hand the collection (and its future income and royalties) to someone else.
    function setCreator(address creator_, address payout_) external onlyCreator {
        if (creator_ == address(0) || payout_ == address(0)) revert BadParams();
        creator = creator_;
        payout = payout_;
        _setDefaultRoyalty(payout_, royaltyBps);
        emit CreatorSet(creator_, payout_);
    }

    /// @notice Pick the block whose hash will become the seed. Again only if that hash expired.
    function commitSeed() external onlyCreator {
        if (renderer == address(0) || seed != 0) revert BadParams();
        if (seedBlock != 0 && block.number <= uint256(seedBlock) + 256) revert BadParams();
        seedBlock = uint64(block.number + 5);
        emit SeedCommitted(seedBlock);
    }

    function revealSeed() external {
        if (seedBlock == 0 || seed != 0 || block.number <= seedBlock) revert BadParams();
        bytes32 h = blockhash(seedBlock);
        if (h == bytes32(0)) revert BadParams(); // expired: the creator commits again
        seed = uint256(keccak256(abi.encode(h, address(this))));
        emit SeedRevealed(seed);
        if (totalSupply > 0) emit BatchMetadataUpdate(1, maxSupply);
    }

    // ---- views ----------------------------------------------------------------------------------

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        if (renderer != address(0)) return IInsaRenderer(renderer).tokenURI(address(this), id, seed);
        bytes memory b = bytes(baseURI);
        if (b.length > 0 && b[b.length - 1] == "/") return string.concat(baseURI, id.toString(), ".json");
        return baseURI;
    }

    function supportsInterface(bytes4 id) public view override(ERC721, ERC2981) returns (bool) {
        return id == 0x49064906 || super.supportsInterface(id); // ERC-4906 metadata updates
    }

    // ---- internals ------------------------------------------------------------------------------

    function _check(Phase memory p) internal pure {
        if (p.end != 0 && p.end <= p.start) revert BadParams();
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
