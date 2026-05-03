// SPDX-License-Identifier: MIT
//
// RareBlock Certificate — Hardhat test suite
//
// Run with:
//   cd chain
//   npm install
//   npx hardhat test
//

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RareBlockCertificate", function () {
  const CONTRACT_NAME = "RareBlockCertificate";
  const BASE_URI      = "ipfs://collection/";
  const CONTRACT_URI  = "ipfs://collection-meta.json";
  const ROYALTY_BPS   = 250; // 2.5%

  async function deployFixture() {
    const [admin, minter, metadataMgr, royaltyReceiver, alice, bob, mallory] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory(CONTRACT_NAME);
    const c = await Factory.deploy(
      admin.address,
      minter.address,
      metadataMgr.address,
      royaltyReceiver.address,
      ROYALTY_BPS,
      BASE_URI,
      CONTRACT_URI
    );
    await c.waitForDeployment();

    return { c, admin, minter, metadataMgr, royaltyReceiver, alice, bob, mallory };
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Deployment
  // ─────────────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets name, symbol, contractURI", async function () {
      const { c } = await deployFixture();
      expect(await c.name()).to.equal("RareBlock Certificate");
      expect(await c.symbol()).to.equal("RBC");
      expect(await c.contractURI()).to.equal(CONTRACT_URI);
    });

    it("grants the correct roles", async function () {
      const { c, admin, minter, metadataMgr } = await deployFixture();
      const ADMIN_ROLE   = await c.DEFAULT_ADMIN_ROLE();
      const MINTER_ROLE  = await c.MINTER_ROLE();
      const META_ROLE    = await c.METADATA_ROLE();
      const PAUSER_ROLE  = await c.PAUSER_ROLE();

      expect(await c.hasRole(ADMIN_ROLE,  admin.address)).to.be.true;
      expect(await c.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
      expect(await c.hasRole(MINTER_ROLE, minter.address)).to.be.true;
      expect(await c.hasRole(META_ROLE,   metadataMgr.address)).to.be.true;
    });

    it("supports the right interfaces (1155, 2981, AccessControl)", async function () {
      const { c } = await deployFixture();
      // ERC-1155
      expect(await c.supportsInterface("0xd9b67a26")).to.be.true;
      // ERC-2981
      expect(await c.supportsInterface("0x2a55205a")).to.be.true;
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Minting
  // ─────────────────────────────────────────────────────────────────────
  describe("mintNewProduct", function () {
    const tokenId    = 100001n;
    const maxSupply  = 100n;
    const initialQty = 30n;
    const serial     = "RB-2026-000042";
    const uri        = "ipfs://Qm.../meta.json";
    const pdfHash    = ethers.id("dummy-pdf-content");

    it("mints to the recipient and stores all metadata fields", async function () {
      const { c, minter, alice } = await deployFixture();

      await expect(
        c.connect(minter).mintNewProduct(
          alice.address, tokenId, initialQty, maxSupply, serial, uri, pdfHash
        )
      )
        .to.emit(c, "CertificateMinted")
        .withArgs(tokenId, alice.address, initialQty, serial, pdfHash, uri);

      expect(await c.balanceOf(alice.address, tokenId)).to.equal(initialQty);
      expect(await c.totalSupply(tokenId)).to.equal(initialQty);
      expect(await c.maxSupplyOf(tokenId)).to.equal(maxSupply);
      expect(await c.uri(tokenId)).to.equal(uri);
      expect(await c.pdfHashOf(tokenId)).to.equal(pdfHash);
      expect(await c.serialOf(tokenId)).to.equal(serial);
      expect(await c.tokenIdBySerial(serial)).to.equal(tokenId);
    });

    it("reverts if a non-minter tries to mint", async function () {
      const { c, mallory, alice } = await deployFixture();
      await expect(
        c.connect(mallory).mintNewProduct(
          alice.address, tokenId, initialQty, maxSupply, serial, uri, pdfHash
        )
      ).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    });

    it("reverts on double-mint of the same tokenId", async function () {
      const { c, minter, alice } = await deployFixture();
      await c.connect(minter).mintNewProduct(
        alice.address, tokenId, initialQty, maxSupply, serial, uri, pdfHash
      );
      await expect(
        c.connect(minter).mintNewProduct(
          alice.address, tokenId, 1n, maxSupply, "RB-X", uri, pdfHash
        )
      ).to.be.revertedWithCustomError(c, "AlreadyMinted");
    });

    it("reverts on empty serial / empty URI", async function () {
      const { c, minter, alice } = await deployFixture();
      await expect(
        c.connect(minter).mintNewProduct(
          alice.address, tokenId, initialQty, maxSupply, "", uri, pdfHash
        )
      ).to.be.revertedWithCustomError(c, "EmptySerial");

      await expect(
        c.connect(minter).mintNewProduct(
          alice.address, tokenId + 1n, initialQty, maxSupply, "RB-OK", "", pdfHash
        )
      ).to.be.revertedWithCustomError(c, "EmptyURI");
    });

    it("reverts when qty > maxSupply at first mint", async function () {
      const { c, minter, alice } = await deployFixture();
      await expect(
        c.connect(minter).mintNewProduct(
          alice.address, tokenId, 200n, maxSupply, serial, uri, pdfHash
        )
      ).to.be.revertedWith("bad qty");
    });
  });

  describe("mintAdditional", function () {
    const tokenId   = 200002n;
    const maxSupply = 100n;
    const serial    = "RB-2026-000099";
    const uri       = "ipfs://Qm.../meta2.json";
    const pdfHash   = ethers.id("pdf2");

    it("mints additional shares up to max supply", async function () {
      const { c, minter, alice, bob } = await deployFixture();
      await c.connect(minter).mintNewProduct(
        alice.address, tokenId, 30n, maxSupply, serial, uri, pdfHash
      );
      await c.connect(minter).mintAdditional(bob.address, tokenId, 50n);
      expect(await c.totalSupply(tokenId)).to.equal(80n);
      expect(await c.balanceOf(bob.address, tokenId)).to.equal(50n);
    });

    it("reverts when exceeding max supply", async function () {
      const { c, minter, alice } = await deployFixture();
      await c.connect(minter).mintNewProduct(
        alice.address, tokenId, 30n, maxSupply, serial, uri, pdfHash
      );
      await expect(
        c.connect(minter).mintAdditional(alice.address, tokenId, 71n)
      ).to.be.revertedWithCustomError(c, "MaxSupplyExceeded");
    });

    it("reverts on unknown token", async function () {
      const { c, minter, alice } = await deployFixture();
      await expect(
        c.connect(minter).mintAdditional(alice.address, 999999n, 1n)
      ).to.be.revertedWithCustomError(c, "UnknownToken");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Custodial transfer
  // ─────────────────────────────────────────────────────────────────────
  describe("custodialTransfer", function () {
    it("transfers shares between custodial wallets", async function () {
      const { c, minter, alice, bob } = await deployFixture();
      const tokenId = 300003n;
      await c.connect(minter).mintNewProduct(
        alice.address, tokenId, 50n, 100n, "RB-T-1", "ipfs://t1", ethers.id("p")
      );

      const reasonHash = ethers.id("inv_orders:abc-uuid");
      await expect(
        c.connect(minter).custodialTransfer(
          alice.address, bob.address, tokenId, 20n, reasonHash
        )
      )
        .to.emit(c, "CustodialTransfer")
        .withArgs(tokenId, alice.address, bob.address, 20n, reasonHash);

      expect(await c.balanceOf(alice.address, tokenId)).to.equal(30n);
      expect(await c.balanceOf(bob.address,   tokenId)).to.equal(20n);
    });

    it("non-minter cannot trigger custodial transfer", async function () {
      const { c, minter, mallory, alice, bob } = await deployFixture();
      const tokenId = 300004n;
      await c.connect(minter).mintNewProduct(
        alice.address, tokenId, 50n, 100n, "RB-T-2", "ipfs://t2", ethers.id("p2")
      );
      await expect(
        c.connect(mallory).custodialTransfer(
          alice.address, bob.address, tokenId, 5n, ethers.id("r")
        )
      ).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Metadata
  // ─────────────────────────────────────────────────────────────────────
  describe("metadata management", function () {
    it("can update URI until frozen", async function () {
      const { c, minter, metadataMgr, alice } = await deployFixture();
      const tokenId = 400004n;
      await c.connect(minter).mintNewProduct(
        alice.address, tokenId, 1n, 1n, "RB-M-1", "ipfs://v1", ethers.id("p")
      );

      await expect(c.connect(metadataMgr).setTokenURI(tokenId, "ipfs://v2"))
        .to.emit(c, "MetadataUpdated").withArgs(tokenId, "ipfs://v2");
      expect(await c.uri(tokenId)).to.equal("ipfs://v2");

      await c.connect(metadataMgr).freezeMetadata(tokenId);
      await expect(
        c.connect(metadataMgr).setTokenURI(tokenId, "ipfs://v3")
      ).to.be.revertedWithCustomError(c, "MetadataIsFrozen");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Pause
  // ─────────────────────────────────────────────────────────────────────
  describe("pausable", function () {
    it("blocks transfers when paused, resumes when unpaused", async function () {
      const { c, admin, minter, alice, bob } = await deployFixture();
      const tokenId = 500005n;
      await c.connect(minter).mintNewProduct(
        alice.address, tokenId, 50n, 100n, "RB-P-1", "ipfs://p1", ethers.id("p")
      );

      await c.connect(admin).pause();
      await expect(
        c.connect(minter).custodialTransfer(
          alice.address, bob.address, tokenId, 1n, ethers.id("r")
        )
      ).to.be.revertedWithCustomError(c, "EnforcedPause");

      await c.connect(admin).unpause();
      await c.connect(minter).custodialTransfer(
        alice.address, bob.address, tokenId, 1n, ethers.id("r")
      );
      expect(await c.balanceOf(bob.address, tokenId)).to.equal(1n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Royalty (ERC-2981)
  // ─────────────────────────────────────────────────────────────────────
  describe("royalties", function () {
    it("returns the configured default royalty", async function () {
      const { c, royaltyReceiver } = await deployFixture();
      const salePrice = ethers.parseEther("1");
      const [recv, amount] = await c.royaltyInfo(0, salePrice);
      expect(recv).to.equal(royaltyReceiver.address);
      expect(amount).to.equal((salePrice * BigInt(ROYALTY_BPS)) / 10_000n);
    });

    it("admin can update default royalty", async function () {
      const { c, admin, alice } = await deployFixture();
      await c.connect(admin).setDefaultRoyalty(alice.address, 500n);
      const [recv, amount] = await c.royaltyInfo(0, 10_000n);
      expect(recv).to.equal(alice.address);
      expect(amount).to.equal(500n); // 5%
    });
  });
});
