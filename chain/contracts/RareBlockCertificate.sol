// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * ╔════════════════════════════════════════════════════════════════════╗
 * ║            RareBlock Certificate — ERC-1155 Production            ║
 * ║                                                                    ║
 * ║  Each token id represents a unique RareBlock product (a physical  ║
 * ║  collectible held in custody). The balance held by an address     ║
 * ║  represents the number of fractional shares of that product.     ║
 * ║                                                                    ║
 * ║  Designed for Base mainnet (chainId 8453) / Base Sepolia (84532). ║
 * ║                                                                    ║
 * ║  Security model:                                                   ║
 * ║    DEFAULT_ADMIN_ROLE  — multisig (Gnosis Safe). Pause, role mgmt. ║
 * ║    MINTER_ROLE         — server hot wallet. Can mint & transfer.   ║
 * ║    METADATA_ROLE       — server. Can update token URIs (rare).     ║
 * ║                                                                    ║
 * ║  Custodial transfer pattern:                                       ║
 * ║    All user wallets are custodial → server signs transfers on      ║
 * ║    behalf of users via custodialTransfer(). This is by design;     ║
 * ║    secondary sales are settled in the RareBlock app, the on-chain  ║
 * ║    transfer just mirrors the result.                               ║
 * ╚════════════════════════════════════════════════════════════════════╝
 */

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Pausable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Pausable.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {ERC1155Burnable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract RareBlockCertificate is
    ERC1155,
    ERC1155Pausable,
    ERC1155Supply,
    ERC1155Burnable,
    AccessControl,
    ERC2981
{
    using Strings for uint256;

    // ─── Roles ─────────────────────────────────────────────────────────
    bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
    bytes32 public constant METADATA_ROLE = keccak256("METADATA_ROLE");
    bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");

    // ─── Storage ───────────────────────────────────────────────────────
    string  public name;     // "RareBlock Certificate"
    string  public symbol;   // "RBC"
    string  public contractURI;        // collection-level metadata (OpenSea)

    // tokenId → metadata URI (ipfs://Qm...)
    mapping(uint256 => string)  private _tokenURIs;
    // tokenId → SHA-256 hash of the matching PDF certificate (immutable proof)
    mapping(uint256 => bytes32) public  pdfHashOf;
    // tokenId → max supply locked at first mint (prevents inflation attacks)
    mapping(uint256 => uint256) public  maxSupplyOf;
    // tokenId → human-readable serial (e.g. "RB-2026-000042"). Set once.
    mapping(uint256 => string)  public  serialOf;
    // serial → tokenId (reverse lookup, used by the public verify page)
    mapping(string  => uint256) public  tokenIdBySerial;
    // tokenId → frozen flag. Once frozen, metadata URI cannot change.
    mapping(uint256 => bool)    public  metadataFrozen;

    // ─── Events ────────────────────────────────────────────────────────
    event CertificateMinted(
        uint256 indexed tokenId,
        address indexed to,
        uint256 qty,
        string  serial,
        bytes32 pdfHash,
        string  metadataURI
    );
    event CustodialTransfer(
        uint256 indexed tokenId,
        address indexed from,
        address indexed to,
        uint256 qty,
        bytes32 reasonHash
    );
    event MetadataUpdated(uint256 indexed tokenId, string newURI);
    event MetadataFrozen(uint256 indexed tokenId);
    event ContractURIUpdated(string newURI);

    // ─── Errors ────────────────────────────────────────────────────────
    error AlreadyMinted();
    error UnknownToken();
    error MetadataIsFrozen();
    error MaxSupplyExceeded();
    error SerialAlreadyUsed();
    error EmptySerial();
    error EmptyURI();

    // ─── Constructor ───────────────────────────────────────────────────
    /// @param admin       Gnosis Safe (or owner EOA) — gets DEFAULT_ADMIN + PAUSER.
    /// @param minter      Hot wallet that mints/transfers from the server.
    /// @param metadataMgr Wallet allowed to update non-frozen metadata.
    /// @param royaltyReceiver Address that receives ERC-2981 royalties.
    /// @param royaltyBps  Royalty in basis points (e.g. 250 = 2.5%).
    /// @param baseURI_    Fallback ipfs:// gateway base; per-token URI overrides this.
    /// @param contractURI_ Collection metadata URI.
    constructor(
        address admin,
        address minter,
        address metadataMgr,
        address royaltyReceiver,
        uint96  royaltyBps,
        string memory baseURI_,
        string memory contractURI_
    ) ERC1155(baseURI_) {
        require(admin != address(0), "admin=0");
        require(minter != address(0), "minter=0");
        require(royaltyReceiver != address(0), "royalty=0");

        name        = "RareBlock Certificate";
        symbol      = "RBC";
        contractURI = contractURI_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE,        admin);
        _grantRole(MINTER_ROLE,        minter);
        _grantRole(METADATA_ROLE,      metadataMgr);

        _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Minting
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Initialize a new product (token id) and mint its first share.
    /// @dev    `tokenId` should mirror inv_products.id mapping (uint256
    ///         derived from the UUID, server-generated, deterministic).
    /// @param  to          Custodial wallet of the first owner.
    /// @param  tokenId     Unique product id.
    /// @param  qty         Initial quantity to mint to `to`.
    /// @param  maxSupply   Upper cap of the supply for this product (locked
    ///                     forever after this call). For "full" products = 1.
    /// @param  serial      Human-readable certificate serial.
    /// @param  metadataURI ipfs://Qm... URI to the JSON metadata.
    /// @param  pdfHash     SHA-256 of the PDF certificate (32 bytes).
    function mintNewProduct(
        address to,
        uint256 tokenId,
        uint256 qty,
        uint256 maxSupply,
        string  calldata serial,
        string  calldata metadataURI,
        bytes32 pdfHash
    ) external onlyRole(MINTER_ROLE) {
        if (maxSupplyOf[tokenId] != 0) revert AlreadyMinted();
        if (bytes(serial).length == 0) revert EmptySerial();
        if (bytes(metadataURI).length == 0) revert EmptyURI();
        if (tokenIdBySerial[serial] != 0 || _serialMatches(serial, 0))
            revert SerialAlreadyUsed();
        require(qty > 0 && qty <= maxSupply, "bad qty");

        maxSupplyOf[tokenId]    = maxSupply;
        _tokenURIs[tokenId]     = metadataURI;
        pdfHashOf[tokenId]      = pdfHash;
        serialOf[tokenId]       = serial;
        tokenIdBySerial[serial] = tokenId;

        _mint(to, tokenId, qty, "");
        emit CertificateMinted(tokenId, to, qty, serial, pdfHash, metadataURI);
    }

    /// @notice Mint additional shares of an already-initialized product.
    /// @dev    Used when fractional sales happen over time (slot-by-slot).
    function mintAdditional(
        address to,
        uint256 tokenId,
        uint256 qty
    ) external onlyRole(MINTER_ROLE) {
        if (maxSupplyOf[tokenId] == 0) revert UnknownToken();
        if (totalSupply(tokenId) + qty > maxSupplyOf[tokenId])
            revert MaxSupplyExceeded();
        _mint(to, tokenId, qty, "");
        emit CertificateMinted(
            tokenId, to, qty, serialOf[tokenId], pdfHashOf[tokenId], _tokenURIs[tokenId]
        );
    }

    // Edge case helper: makes sure tokenId 0 isn't accidentally accepted as
    // a "missing" tokenIdBySerial entry. We disallow tokenId == 0 for products.
    function _serialMatches(string calldata s, uint256 t) private view returns (bool) {
        return tokenIdBySerial[s] == t && t == 0 && bytes(serialOf[0]).length > 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Custodial transfer (secondary market settlement)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Move shares between two custodial wallets.
    /// @dev    Called by the server after a secondary sale settles in app.
    ///         `reasonHash` should be keccak256 of the off-chain order id
    ///         (e.g. inv_orders.id) for audit trail.
    function custodialTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 qty,
        bytes32 reasonHash
    ) external onlyRole(MINTER_ROLE) {
        _safeTransferFrom(from, to, tokenId, qty, "");
        emit CustodialTransfer(tokenId, from, to, qty, reasonHash);
    }

    /// @notice Batch version for liquidation events.
    function custodialTransferBatch(
        address from,
        address to,
        uint256[] calldata tokenIds,
        uint256[] calldata quantities,
        bytes32 reasonHash
    ) external onlyRole(MINTER_ROLE) {
        _safeBatchTransferFrom(from, to, tokenIds, quantities, "");
        for (uint256 i; i < tokenIds.length; ++i) {
            emit CustodialTransfer(tokenIds[i], from, to, quantities[i], reasonHash);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Metadata
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Per-token URI (overrides ERC-1155 default {id} substitution).
    function uri(uint256 tokenId) public view override returns (string memory) {
        if (maxSupplyOf[tokenId] == 0) revert UnknownToken();
        return _tokenURIs[tokenId];
    }

    /// @notice Update metadata URI. Only possible if not frozen.
    function setTokenURI(uint256 tokenId, string calldata newURI)
        external
        onlyRole(METADATA_ROLE)
    {
        if (maxSupplyOf[tokenId] == 0) revert UnknownToken();
        if (metadataFrozen[tokenId])   revert MetadataIsFrozen();
        if (bytes(newURI).length == 0) revert EmptyURI();
        _tokenURIs[tokenId] = newURI;
        emit MetadataUpdated(tokenId, newURI);
    }

    /// @notice Permanently lock a token's metadata. One-way.
    function freezeMetadata(uint256 tokenId) external onlyRole(METADATA_ROLE) {
        if (maxSupplyOf[tokenId] == 0) revert UnknownToken();
        metadataFrozen[tokenId] = true;
        emit MetadataFrozen(tokenId);
    }

    function setContractURI(string calldata newURI) external onlyRole(METADATA_ROLE) {
        contractURI = newURI;
        emit ContractURIUpdated(newURI);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Royalties (ERC-2981)
    // ═══════════════════════════════════════════════════════════════════

    function setDefaultRoyalty(address receiver, uint96 bps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setDefaultRoyalty(receiver, bps);
    }

    function setTokenRoyalty(uint256 tokenId, address receiver, uint96 bps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setTokenRoyalty(tokenId, receiver, bps);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Pause
    // ═══════════════════════════════════════════════════════════════════

    function pause()   external onlyRole(PAUSER_ROLE) { _pause();   }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ═══════════════════════════════════════════════════════════════════
    //  Required overrides (multiple-inheritance solidity boilerplate)
    // ═══════════════════════════════════════════════════════════════════

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155, ERC1155Pausable, ERC1155Supply) {
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 iid)
        public
        view
        override(ERC1155, AccessControl, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(iid);
    }
}
