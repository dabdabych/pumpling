/**
 * The draw, against the real ORAO on devnet.
 *
 * These run on devnet rather than a local validator on purpose: ORAO's
 * fulfillers are off-chain, so a cloned program on localnet would take the
 * request and never answer it. The only place the whole path exists is the
 * network itself.
 *
 * What is worth checking here is not that a round can be drawn. It is that it
 * can be drawn exactly once, from exactly one request, and that the way out for
 * a dead oracle cannot be turned into a second attempt.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Lottery } from "../target/types/lottery";
import { expect } from "chai";
import { createMint } from "@solana/spl-token";
import { createHash } from "crypto";

const { SystemProgram, Keypair, PublicKey, LAMPORTS_PER_SOL, SYSVAR_SLOT_HASHES_PUBKEY } =
  anchor.web3;
const BN = anchor.BN;

const ORAO_PROGRAM = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const ORAO_RANDOMNESS_SEED = Buffer.from("orao-vrf-randomness-request");
const ORAO_CONFIG_SEED = Buffer.from("orao-vrf-network-configuration");
const FORCE_DOMAIN = Buffer.from("pumpling-vrf-force-v1");
const SEED_DOMAIN = Buffer.from("pumpling-vrf-seed-v1");

/** Entry layout of the SlotHashes sysvar: 8-byte count, then slot + hash pairs. */
const SLOT_HASH_ENTRY = 40;

describe("draw with ORAO VRF", () => {
  const base = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(base.connection, base.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.lottery as Program<Lottery>;
  const connection = provider.connection;
  const wallet = provider.wallet;
  const admin = wallet.publicKey;

  const VRF_ALGORITHM_HASH = Array.from(Buffer.alloc(32, 222));
  let mint: anchor.web3.PublicKey;
  let oraoTreasury: anchor.web3.PublicKey;

  const oraoNetworkState = PublicKey.findProgramAddressSync(
    [ORAO_CONFIG_SEED],
    ORAO_PROGRAM
  )[0];

  const sha256 = (...parts: Buffer[]) =>
    createHash("sha256").update(Buffer.concat(parts)).digest();

  /** The same derivation the program does, written out separately on purpose. */
  const deriveForce = (lottery: anchor.web3.PublicKey, weightsHash: Buffer, slotHash: Buffer) =>
    sha256(FORCE_DOMAIN, lottery.toBuffer(), weightsHash, slotHash);

  const requestAddress = (force: Buffer) =>
    PublicKey.findProgramAddressSync([ORAO_RANDOMNESS_SEED, force], ORAO_PROGRAM)[0];

  /**
   * A slot and its hash, read from the same sysvar the program reads.
   *
   * `back` picks how far down the list to go. Entry 0 is the newest; a couple
   * of entries down is steadier while a transaction is being built.
   */
  async function slotHashEntry(back = 2): Promise<{ slot: anchor.BN; hash: Buffer }> {
    const info = await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, "confirmed");
    if (!info) throw new Error("slot hashes sysvar unavailable");
    const count = Number(info.data.readBigUInt64LE(0));
    if (count <= back) throw new Error(`sysvar has only ${count} entries`);
    const offset = 8 + back * SLOT_HASH_ENTRY;
    return {
      slot: new BN(info.data.readBigUInt64LE(offset).toString()),
      hash: info.data.subarray(offset + 8, offset + SLOT_HASH_ENTRY),
    };
  }

  async function waitUntilUnix(target: number, slackSeconds = 1) {
    for (;;) {
      const now = Math.floor(Date.now() / 1000);
      if (now >= target + slackSeconds) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** The ORAO request account once it holds randomness, or null while pending. */
  async function readFulfilled(request: anchor.web3.PublicKey): Promise<Buffer | null> {
    const info = await connection.getAccountInfo(request, "confirmed");
    if (!info) return null;
    // 8 discriminator, 1 enum tag, 32 client, 32 seed, then 64 randomness.
    if (info.data.length < 137 || info.data[8] !== 1) return null;
    return info.data.subarray(73, 137);
  }

  async function waitForFulfilment(request: anchor.web3.PublicKey, seconds = 90) {
    const until = Date.now() + seconds * 1000;
    for (;;) {
      const value = await readFulfilled(request);
      if (value) return value;
      if (Date.now() > until) throw new Error("ORAO did not fulfil in time");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /** Opens a round that closes almost immediately and takes one deposit. */
  async function openRound(depositSol = 0.06) {
    const id = new BN(Date.now());
    const lottery = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), admin.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
    const vault = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lottery.toBuffer()],
      program.programId
    )[0];

    const now = Math.floor(Date.now() / 1000);
    const startTs = new BN(now - 5);
    const endTs = new BN(now + 12);

    await program.methods
      .initialize(
        id,
        startTs,
        endTs,
        300,
        new BN(0.05 * LAMPORTS_PER_SOL),
        new BN(1 * LAMPORTS_PER_SOL),
        new BN(100 * LAMPORTS_PER_SOL),
        VRF_ALGORITHM_HASH as any
      )
      .accounts({
        lottery,
        vault,
        admin,
        walletFee: Keypair.generate().publicKey,
        walletKeeper: Keypair.generate().publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .depositSol(mint, new BN(depositSol * LAMPORTS_PER_SOL))
      .accounts({
        lottery,
        vault,
        payer: admin,
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await waitUntilUnix(endTs.toNumber(), 2);
    return { id, lottery, vault, endTs };
  }

  /** Closes the round's deposits and files the ORAO request. */
  async function startPhaseTwo(lottery: anchor.web3.PublicKey, weightsFill = 11) {
    const weightsHash = Buffer.alloc(32, weightsFill);
    const { slot, hash } = await slotHashEntry();
    const force = deriveForce(lottery, weightsHash, hash);
    const request = requestAddress(force);

    await program.methods
      .startSecondPhase(Array.from(weightsHash) as any, slot)
      .accounts({
        lottery,
        admin,
        vrfRequest: request,
        vrfNetworkState: oraoNetworkState,
        vrfTreasury: oraoTreasury,
        vrfProgram: ORAO_PROGRAM,
        recentSlothashes: SYSVAR_SLOT_HASHES_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { weightsHash, slot, slotHash: hash, force, request };
  }

  before(async function () {
    this.timeout(120000);
    const balance = await connection.getBalance(admin);
    expect(balance, "test wallet needs devnet SOL").to.be.greaterThan(0.5 * LAMPORTS_PER_SOL);

    const info = await connection.getAccountInfo(oraoNetworkState, "confirmed");
    expect(info, "ORAO network state must exist on this cluster").to.not.be.null;
    // NetworkConfiguration: authority, then treasury.
    oraoTreasury = new PublicKey(info!.data.subarray(40, 72));

    mint = await createMint(connection, (wallet as any).payer, admin, null, 9);
  });

  it("draws a round from ORAO and stores the folded seed", async function () {
    this.timeout(300000);
    const { lottery } = await openRound();
    const { force, request, slot, slotHash, weightsHash } = await startPhaseTwo(lottery);

    let account = await program.account.lottery.fetch(lottery);
    expect(Object.keys(account.status)[0]).to.equal("pendingVrf");
    expect(Buffer.from(account.vrfForce as any).equals(force), "force on chain").to.be.true;
    expect(account.vrfRequest.toBase58()).to.equal(request.toBase58());
    expect(account.vrfSeedSlot.toString()).to.equal(slot.toString());

    // The derivation is reproducible from published values alone, which is the
    // point: a verifier repeats it and sees there was only one request to make.
    expect(deriveForce(lottery, weightsHash, slotHash).equals(force)).to.be.true;
    expect(requestAddress(force).toBase58()).to.equal(request.toBase58());

    const randomness = await waitForFulfilment(request);

    await program.methods
      .fulfillRandomness()
      .accounts({ lottery, vrfRequest: request })
      .rpc();

    account = await program.account.lottery.fetch(lottery);
    expect(Object.keys(account.status)[0]).to.equal("readyToDraw");
    expect(account.vrfCalled).to.equal(true);

    const expected = sha256(SEED_DOMAIN, randomness);
    expect(
      Buffer.from(account.vrfSeed as any).equals(expected),
      "stored seed is the fold of all 64 bytes"
    ).to.be.true;
  });

  it("refuses a request account that is not the derived one", async function () {
    this.timeout(180000);
    const { lottery } = await openRound();
    const { slot } = await slotHashEntry();
    // A perfectly valid ORAO request address, just not this round's.
    const wrong = requestAddress(Buffer.alloc(32, 123));

    try {
      await program.methods
        .startSecondPhase(Array.from(Buffer.alloc(32, 11)) as any, slot)
        .accounts({
          lottery,
          admin,
          vrfRequest: wrong,
          vrfNetworkState: oraoNetworkState,
          vrfTreasury: oraoTreasury,
          vrfProgram: ORAO_PROGRAM,
          recentSlothashes: SYSVAR_SLOT_HASHES_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("a foreign request account was accepted");
    } catch (err: any) {
      expect(JSON.stringify(err)).to.contain("RandomnessAccountMismatch");
    }
  });

  it("refuses a slot hash from too far back", async function () {
    this.timeout(180000);
    const { lottery } = await openRound();
    const { slot } = await slotHashEntry();
    const stale = slot.sub(new BN(400)); // sysvar still holds it, the program will not take it

    try {
      await program.methods
        .startSecondPhase(Array.from(Buffer.alloc(32, 11)) as any, stale)
        .accounts({
          lottery,
          admin,
          vrfRequest: requestAddress(Buffer.alloc(32, 5)),
          vrfNetworkState: oraoNetworkState,
          vrfTreasury: oraoTreasury,
          vrfProgram: ORAO_PROGRAM,
          recentSlothashes: SYSVAR_SLOT_HASHES_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("a stale slot was accepted");
    } catch (err: any) {
      expect(JSON.stringify(err)).to.contain("SeedSlotTooOld");
    }
  });

  it("will not hand over a seed before ORAO has produced one", async function () {
    this.timeout(180000);
    const { lottery } = await openRound();
    const { request } = await startPhaseTwo(lottery);

    // Straight after the request, before the fulfillers answer.
    try {
      await program.methods
        .fulfillRandomness()
        .accounts({ lottery, vrfRequest: request })
        .rpc();
      expect.fail("an empty request was drawn from");
    } catch (err: any) {
      expect(JSON.stringify(err)).to.contain("RandomnessNotResolved");
    }
  });

  /**
   * The one that matters.
   *
   * The emergency path exists for an oracle that has stopped answering. If it
   * could also be used after an answer arrived, the admin would get a second
   * draw for the price of disliking the first.
   */
  it("refuses the emergency seed once ORAO has answered", async function () {
    this.timeout(300000);
    const { lottery } = await openRound();
    const { request } = await startPhaseTwo(lottery);
    await waitForFulfilment(request);

    const account = await program.account.lottery.fetch(lottery);
    expect(Object.keys(account.status)[0], "still pending, seed not taken yet").to.equal(
      "pendingVrf"
    );

    try {
      await program.methods
        .emergencyFulfillRandomness(Array.from(Buffer.alloc(32, 77)) as any)
        .accounts({ lottery, admin, vrfRequest: request })
        .rpc();
      expect.fail("the round was redrawn by hand after ORAO answered");
    } catch (err: any) {
      expect(JSON.stringify(err)).to.contain("RandomnessAlreadyResolved");
    }

    // And the real seed is still the one available.
    await program.methods
      .fulfillRandomness()
      .accounts({ lottery, vrfRequest: request })
      .rpc();
    const after = await program.account.lottery.fetch(lottery);
    expect(Buffer.from(after.vrfSeed as any).equals(Buffer.alloc(32, 77))).to.be.false;
  });

  it("draws once and only once", async function () {
    this.timeout(300000);
    const { lottery } = await openRound();
    const { request } = await startPhaseTwo(lottery);
    await waitForFulfilment(request);

    await program.methods
      .fulfillRandomness()
      .accounts({ lottery, vrfRequest: request })
      .rpc();

    try {
      await program.methods
        .fulfillRandomness()
        .accounts({ lottery, vrfRequest: request })
        .rpc();
      expect.fail("the round was drawn twice");
    } catch (err: any) {
      expect(JSON.stringify(err)).to.contain("WrongPhase");
    }
  });

  it("will not close deposits on someone else's round", async function () {
    this.timeout(180000);
    const { lottery } = await openRound();
    // No funding needed: the provider wallet still pays the fee, the outsider
    // only signs, and the round rejects them before anything is spent.
    const outsider = Keypair.generate();
    const { slot } = await slotHashEntry();
    try {
      await program.methods
        .startSecondPhase(Array.from(Buffer.alloc(32, 11)) as any, slot)
        .accounts({
          lottery,
          admin: outsider.publicKey,
          vrfRequest: requestAddress(Buffer.alloc(32, 6)),
          vrfNetworkState: oraoNetworkState,
          vrfTreasury: oraoTreasury,
          vrfProgram: ORAO_PROGRAM,
          recentSlothashes: SYSVAR_SLOT_HASHES_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .signers([outsider])
        .rpc();
      expect.fail("an outsider closed the round");
    } catch (err: any) {
      const text = JSON.stringify(err);
      expect(text.includes("ConstraintHasOne") || text.includes("has_one")).to.be.true;
    }
  });
});
