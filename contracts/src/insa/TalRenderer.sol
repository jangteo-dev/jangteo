// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IInsaRenderer} from "./InsaDrop.sol";
import {TalArt} from "./TalArt.sol";

/// @title TalRenderer — draws 탈 Tal tokens on-chain: every picture and trait comes from this code
///        and the collection's reveal seed, with no server or IPFS behind it.
contract TalRenderer is IInsaRenderer {
    using Strings for uint256;

    TalArt public immutable art;


    constructor(TalArt art_) {
        art = art_;
    }

    function tokenURI(address, uint256 id, uint256 seed) external view returns (string memory) {
        string memory name = string.concat("Tal #", id.toString());
        string memory about =
            "Tal are the carved wooden masks of Korean mask dance: the aristocrat, the bride, the trickster, the old woman, the goblin. 1,000 of them, drawn entirely on-chain on GIWA. By Jangteo.";
        if (seed == 0) {
            return _json(string.concat('{"name":"', name, '","description":"', about, '","image":"', _img(art.unrevealed()), '","attributes":[{"trait_type":"Status","value":"Unrevealed"}]}'));
        }
        uint8[6] memory t = art.traits(seed, id);
        return _json(string.concat('{"name":"', name, '","description":"', about, '","image":"', _img(art.svg(t)), '","attributes":', _attrs(t), "}"));
    }

    function _attrs(uint8[6] memory t) internal view returns (string memory s) {
        s = "[";
        for (uint256 k; k < 6; ++k) {
            s = string.concat(s, k == 0 ? "" : ",", '{"trait_type":"', _kind(k), '","value":"', art.traitName(k, t[k]), '"}');
        }
        s = string.concat(s, "]");
    }

    function _kind(uint256 k) internal pure returns (string memory) {
        if (k == 0) return "Backdrop";
        if (k == 1) return "Palette";
        if (k == 2) return "Wood";
        if (k == 3) return "Mask";
        if (k == 4) return "Headwear";
        return "Charm";
    }

    function _img(string memory svg) internal pure returns (string memory) {
        return string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(svg)));
    }

    function _json(string memory j) internal pure returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(j)));
    }
}
