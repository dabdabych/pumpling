import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Lottery } from "../target/types/lottery";
import { expect } from "chai";
import { createMint } from "@solana/spl-token";
import { AnchorError } from "@coral-xyz/anchor";


const { SystemProgram, Keypair, PublicKey, LAMPORTS_PER_SOL } = anchor.web3;
const BN = anchor.BN;

describe("lottery_v_1_0", () => {
  const baseProvider = anchor.AnchorProvider.env();

  const provider = new anchor.AnchorProvider(
    baseProvider.connection,
    baseProvider.wallet,
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    }
  );

  anchor.setProvider(provider);



  const program = anchor.workspace.lottery as Program<Lottery>;

  if (!program) {
    throw new Error(
      `Program not found in anchor.workspace. Available keys: ${Object.keys(anchor.workspace).join(
        ", "
      )}`
    );
  }

  const connection = provider.connection;
  const wallet = provider.wallet;

  const TEST_VRF_HASH = Array.from(Buffer.alloc(32, 222)) as number[];
  const TEST_MAX_TOTAL = new BN("1000000000000"); // 1000 SOL — comfortably more than any test needs

  async function createTestMint(): Promise<PublicKey> {
    return await createMint(
      connection,
      wallet.payer,      // payer
      wallet.publicKey,  // mint authority
      null,              // freeze authority
      9                  // decimals
    );
  }



  // Devnet-safe: fund test accounts from provider wallet (no faucet usage).
  async function fund(pubkey: PublicKey, sol: number) {
    const ix = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: pubkey,
      lamports: Math.round(sol * LAMPORTS_PER_SOL),
    });

    const latest = await provider.connection.getLatestBlockhash("confirmed");

    const tx = new anchor.web3.Transaction({
      feePayer: wallet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(ix);

    await provider.sendAndConfirm(tx);
  }



  function toLEBytes8(n: BN): Buffer {
    return n.toArrayLike(Buffer, "le", 8);
  }

  async function getBalance(pubkey: PublicKey): Promise<BN> {
    const lamports = await connection.getBalance(pubkey);
    if (!Number.isFinite(lamports) || lamports < 0) {
      throw new Error(`Invalid lamports value from getBalance: ${lamports}`);
    }
    return new BN(lamports.toString());
  }

  function getStatusKey(status: any): string {
    return Object.keys(status)[0];
  }

  async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitUntilUnix(ts: number, bufferSeconds = 1) {
    while (true) {
      const now = Math.floor(Date.now() / 1000);
      if (now >= ts + bufferSeconds) return;
      await sleep(1000);
    }
  }

  // Timestamp-based IDs for devnet (state persists between runs)
  let _seq = 0;
  function uniqueLotteryId(): BN {
    _seq += 1;
    // Unix timestamp in ms + tiny sequence to avoid same-ms collisions in tests.
    return new BN((Date.now() + _seq).toString());
  }

  // TODO: requires Switchboard randomness account mock for localnet
  it.skip("runs full lottery lifecycle (init → deposit → phases → distribution → close)", async () => {
    const adminPubkey = wallet.publicKey;

    const walletFee = Keypair.generate();
    const walletKeeper = Keypair.generate();
    const user = Keypair.generate();

    // Minimal funding (devnet-safe)
    await fund(walletFee.publicKey, 0.05);
    await fund(walletKeeper.publicKey, 0.05);
    await fund(user.publicKey, 0.25);

    const lotteryId = uniqueLotteryId();
    const lotteryIdLe = toLEBytes8(lotteryId);

    const [lotteryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda.toBuffer()],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    const startTs = new BN(now - 10);
    // Devnet: give more time for confirmations/latency
    const endTs = new BN(now + 20);
    const feeBps = 250;

    const minAmount = new BN(10_000_000); // 0.01 SOL
    const maxAmount = new BN(1 * LAMPORTS_PER_SOL); // 1 SOL (enough for tests)

    // Initialize
    await program.methods
      .initialize(lotteryId, startTs, endTs, feeBps, minAmount, maxAmount, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    let lotteryAcc = await program.account.lottery.fetch(lotteryPda);

    expect(lotteryAcc.admin.toBase58()).to.equal(adminPubkey.toBase58());
    expect(lotteryAcc.startTs.toString()).to.equal(startTs.toString());
    expect(lotteryAcc.endTs.toString()).to.equal(endTs.toString());
    expect(lotteryAcc.feeBps).to.equal(feeBps);
    expect(lotteryAcc.walletFee.toBase58()).to.equal(walletFee.publicKey.toBase58());
    expect(lotteryAcc.walletKeeper.toBase58()).to.equal(walletKeeper.publicKey.toBase58());
    expect(lotteryAcc.minAmount.toString()).to.equal(minAmount.toString());
    expect(lotteryAcc.maxAmount.toString()).to.equal(maxAmount.toString());
    expect(getStatusKey(lotteryAcc.status)).to.equal("open");
    expect(lotteryAcc.paused).to.equal(false);
    expect(Array.from(lotteryAcc.vrfAlgorithmHash)).to.deep.equal(TEST_VRF_HASH);

    // record the vault's starting balance so rent is accounted for
    const vaultInitialBalance = await getBalance(vaultPda);

    // Deposits
    const mintPubkey = await createTestMint();
    const deposit1 = new BN(20_000_000);
    const deposit2 = new BN(30_000_000);
    const totalDeposits = deposit1.add(deposit2);

    await program.methods
      .depositSol(mintPubkey, deposit1)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        payer: user.publicKey,
        mint: mintPubkey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();


    await program.methods
      .depositSol(mintPubkey, deposit2)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        payer: user.publicKey,
        mint: mintPubkey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();


    lotteryAcc = await program.account.lottery.fetch(lotteryPda);
    expect(lotteryAcc.depositsCount.toNumber()).to.equal(2);
    expect(lotteryAcc.totalDeposited.toString()).to.equal(totalDeposits.toString());

    const vaultBalanceAfterDeposits = await getBalance(vaultPda);
    const vaultDeltaAfterDeposits = vaultBalanceAfterDeposits.sub(vaultInitialBalance);

    // Check that exactly the deposited amount was added to the vault (rent untouched)
    expect(vaultDeltaAfterDeposits.toString()).to.equal(totalDeposits.toString());

    // Wait for endTs (devnet-safe: poll)
    await waitUntilUnix(endTs.toNumber(), 2);

    // Phase 2
    const weightsHash = new Array<number>(32).fill(1);
    const waitSeconds = new BN(5);

    await program.methods
      .startSecondPhase(weightsHash as any, waitSeconds)
      .accounts({
        lottery: lotteryPda,
        admin: adminPubkey,
      })
      .rpc();


    lotteryAcc = await program.account.lottery.fetch(lotteryPda);
    expect(getStatusKey(lotteryAcc.status)).to.equal("pendingVrf");
    const vrfReadyTs = lotteryAcc.vrfReadyTs.toNumber();

    // Wait until VRF ready (poll)
    await waitUntilUnix(vrfReadyTs, 5);

    // Phase 3: fulfill randomness
    const seed = new Array<number>(32).fill(7);

    await program.methods
      .fulfillRandomness(seed as any)
      .accounts({
        lottery: lotteryPda,
        admin: adminPubkey,
      })
      .rpc();


    lotteryAcc = await program.account.lottery.fetch(lotteryPda);
    expect(getStatusKey(lotteryAcc.status)).to.equal("readyToDraw");
    expect(lotteryAcc.vrfCalled).to.equal(true);

    // Phase 4: distribution
    const lotteryBeforeDist = await program.account.lottery.fetch(lotteryPda);
    const totalBefore = new BN(lotteryBeforeDist.totalDeposited.toString());
    const feeBpsBn = new BN(lotteryBeforeDist.feeBps);

    const expectedFee = totalBefore.mul(feeBpsBn).div(new BN(10_000));
    const expectedKeeper = totalBefore.sub(expectedFee);

    const feeBefore = await getBalance(walletFee.publicKey);
    const keeperBefore = await getBalance(walletKeeper.publicKey);
    const vaultBefore = await getBalance(vaultPda);

    // Check the vault holds initial_rent + totalBefore
    const vaultDeltaBeforeDist = vaultBefore.sub(vaultInitialBalance);
    expect(vaultDeltaBeforeDist.toString()).to.equal(totalBefore.toString());

    // DEBUG: check the vault really is system-owned and has no data
    const vaultInfo = await connection.getAccountInfo(vaultPda);
    console.log("DEBUG vault owner:", vaultInfo?.owner.toBase58());
    console.log("DEBUG vault data len:", vaultInfo?.data.length);


    await program.methods
      .startPurchasesPhase()
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
      })
      .rpc();


    const feeAfter = await getBalance(walletFee.publicKey);
    const keeperAfter = await getBalance(walletKeeper.publicKey);

    const deltaFee = feeAfter.sub(feeBefore);
    const deltaKeeper = keeperAfter.sub(keeperBefore);

    expect(deltaFee.toString()).to.equal(expectedFee.toString());
    expect(deltaKeeper.toString()).to.equal(expectedKeeper.toString());

    // after distribution the program zeroes total_deposited, so that is what we check
    lotteryAcc = await program.account.lottery.fetch(lotteryPda);
    expect(getStatusKey(lotteryAcc.status)).to.equal("proceedingPurchases");
    expect(lotteryAcc.totalDeposited.toString()).to.equal("0");
    expect(lotteryAcc.depositsCount.toNumber()).to.equal(0);

    // Close lottery
    await program.methods
      .closeLottery()
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        admin: adminPubkey,
      })
      .rpc();


    let closed = false;
    try {
      await program.account.lottery.fetch(lotteryPda);
    } catch (_) {
      closed = true;
    }
    expect(closed).to.equal(true);
  });

  it("pauses and unpauses lottery, blocking and allowing deposits", async () => {
    const adminPubkey = wallet.publicKey;

    const walletFee = Keypair.generate();
    const walletKeeper = Keypair.generate();
    const user = Keypair.generate();

    await fund(walletFee.publicKey, 0.05);
    await fund(walletKeeper.publicKey, 0.05);
    await fund(user.publicKey, 0.2);

    const lotteryId = uniqueLotteryId();
    const lotteryIdLe = toLEBytes8(lotteryId);

    const [lotteryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda.toBuffer()],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    const startTs = new BN(now - 10);
    const endTs = new BN(now + 600);
    const feeBps = 100;

    await program.methods
      .initialize(lotteryId, startTs, endTs, feeBps, null, null, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();


    const mintPubkey = await createTestMint();
    const amount = new BN(60_000_000); // > MIN_AMOUNT_LAMPORTS_DEFAULT (0.05 SOL)

    // deposit ok before pause
    await program.methods
      .depositSol(mintPubkey, amount)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        payer: user.publicKey,
        mint: mintPubkey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();


    // pause
    await program.methods
      .pause()
      .accounts({
        lottery: lotteryPda,
        admin: adminPubkey,
      })
      .rpc();


    let failed = false;
    try {
      await program.methods
        .depositSol(mintPubkey, amount)
        .accounts({
          lottery: lotteryPda,
          vault: vaultPda,
          payer: user.publicKey,
          mint: mintPubkey,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

    } catch (e) {
      failed = true;
      const err = e as AnchorError;
      expect(err.error.errorCode.code).to.equal("Paused");
    }
    expect(failed).to.equal(true);

    // unpause
    await program.methods
      .unpause()
      .accounts({
        lottery: lotteryPda,
        admin: adminPubkey,
      })
      .rpc();


    // deposit again ok
    await program.methods
      .depositSol(mintPubkey, amount)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        payer: user.publicKey,
        mint: mintPubkey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

  });


  it("updates max amount and enforces new bounds", async () => {
    const adminPubkey = wallet.publicKey;

    const walletFee = Keypair.generate();
    const walletKeeper = Keypair.generate();
    const user = Keypair.generate();

    await fund(walletFee.publicKey, 0.05);
    await fund(walletKeeper.publicKey, 0.05);
    await fund(user.publicKey, 0.2);

    const lotteryId = uniqueLotteryId();
    const lotteryIdLe = toLEBytes8(lotteryId);

    const [lotteryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda.toBuffer()],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    const startTs = new BN(now - 10);
    const endTs = new BN(now + 600);
    const feeBps = 100;

    const minAmount = new BN(10_000_000);
    const maxAmount = new BN(1_000_000_000);

    await program.methods
      .initialize(lotteryId, startTs, endTs, feeBps, minAmount, maxAmount, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();


    const newMax = new BN(50_000_000);

    await program.methods
      .updateMaxAmount(newMax)
      .accounts({
        lottery: lotteryPda,
        admin: adminPubkey,
      })
      .rpc();


    let lotteryAcc = await program.account.lottery.fetch(lotteryPda);
    expect(lotteryAcc.maxAmount.toString()).to.equal(newMax.toString());

    const mintPubkey = await createTestMint();
    const okAmount = new BN(30_000_000);
    const badAmount = new BN(100_000_000);

    // ok deposit
    await program.methods
      .depositSol(mintPubkey, okAmount)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        payer: user.publicKey,
        mint: mintPubkey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();


    // failing deposit
    let failed = false;
    try {
      await program.methods
        .depositSol(mintPubkey, badAmount)
        .accounts({
          lottery: lotteryPda,
          vault: vaultPda,
          payer: user.publicKey,
          mint: mintPubkey,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

    } catch (e) {
      failed = true;
      const err = e as AnchorError;
      expect(err.error.errorCode.code).to.equal("InvalidAmount");
    }
    expect(failed).to.equal(true);
  });

  it("rejects depositSol before start_ts and after end_ts", async () => {
    const adminPubkey = wallet.publicKey;

    const walletFee = Keypair.generate();
    const walletKeeper = Keypair.generate();
    const user = Keypair.generate();

    await fund(walletFee.publicKey, 0.05);
    await fund(walletKeeper.publicKey, 0.05);
    await fund(user.publicKey, 0.2);

    const feeBps = 100;

    //
    // 1) depositSol BEFORE start_ts → the "Lottery not started yet" error
    //
    const lotteryId1 = uniqueLotteryId();
    const lotteryIdLe1 = toLEBytes8(lotteryId1);

    const [lotteryPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe1],
      program.programId
    );

    const [vaultPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda1.toBuffer()],
      program.programId
    );

    const now1 = Math.floor(Date.now() / 1000);
    const startTsFuture = new BN(now1 + 60); // not started yet
    const endTsFuture = new BN(now1 + 600);

    await program.methods
      .initialize(lotteryId1, startTsFuture, endTsFuture, feeBps, null, null, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda1,
        vault: vaultPda1,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();


    const mintPubkey1 = await createTestMint();
    const amount1 = new BN(20_000_000);

    let failedBeforeStart = false;
    try {
      await program.methods
        .depositSol(mintPubkey1, amount1)
        .accounts({
          lottery: lotteryPda1,
          vault: vaultPda1,
          payer: user.publicKey,
          mint: mintPubkey1,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

    } catch (e) {
      failedBeforeStart = true;
      const err = e as AnchorError;
      expect(err.error.errorCode.code).to.equal("NotStarted");
    }
    expect(failedBeforeStart).to.equal(true);

    //
    // 2) depositSol AFTER end_ts → the "Lottery ended" error
    //
    const lotteryId2 = uniqueLotteryId();
    const lotteryIdLe2 = toLEBytes8(lotteryId2);

    const [lotteryPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe2],
      program.programId
    );

    const [vaultPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda2.toBuffer()],
      program.programId
    );

    const now2 = Math.floor(Date.now() / 1000);
    const startTsPast = new BN(now2 - 200);
    const endTsPast = new BN(now2 - 100); // ended a good while ago

    await program.methods
      .initialize(lotteryId2, startTsPast, endTsPast, feeBps, null, null, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda2,
        vault: vaultPda2,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();


    const mintPubkey2 = await createTestMint();
    const amount2 = new BN(20_000_000);

    let failedAfterEnd = false;
    try {
      await program.methods
        .depositSol(mintPubkey2, amount2)
        .accounts({
          lottery: lotteryPda2,
          vault: vaultPda2,
          payer: user.publicKey,
          mint: mintPubkey2,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

    } catch (e) {
      failedAfterEnd = true;
      const err = e as AnchorError;
      expect(err.error.errorCode.code).to.equal("Ended");
    }
    expect(failedAfterEnd).to.equal(true);
  });

  it("rejects depositSol amounts outside min/max bounds", async () => {
    const adminPubkey = wallet.publicKey;

    const walletFee = Keypair.generate();
    const walletKeeper = Keypair.generate();
    const user = Keypair.generate();

    await fund(walletFee.publicKey, 0.05);
    await fund(walletKeeper.publicKey, 0.05);
    await fund(user.publicKey, 0.2);

    const lotteryId = uniqueLotteryId();
    const lotteryIdLe = toLEBytes8(lotteryId);

    const [lotteryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda.toBuffer()],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    const startTs = new BN(now - 10);
    const endTs = new BN(now + 600);
    const feeBps = 100;

    const minAmount = new BN(10_000_000);
    const maxAmount = new BN(50_000_000);

    await program.methods
      .initialize(lotteryId, startTs, endTs, feeBps, minAmount, maxAmount, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();


    const mintPubkey = await createTestMint();

    const belowMin = new BN(1_000_000);
    const aboveMax = new BN(60_000_000);

    // below min_amount
    let failedBelow = false;
    try {
      await program.methods
        .depositSol(mintPubkey, belowMin)
        .accounts({
          lottery: lotteryPda,
          vault: vaultPda,
          payer: user.publicKey,
          mint: mintPubkey,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

    } catch (e) {
      failedBelow = true;
      const err = e as AnchorError;
      expect(err.error.errorCode.code).to.equal("InvalidAmount");
    }
    expect(failedBelow).to.equal(true);

    // above max_amount
    let failedAbove = false;
    try {
      await program.methods
        .depositSol(mintPubkey, aboveMax)
        .accounts({
          lottery: lotteryPda,
          vault: vaultPda,
          payer: user.publicKey,
          mint: mintPubkey,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

    } catch (e) {
      failedAbove = true;
      const err = e as AnchorError;
      expect(err.error.errorCode.code).to.equal("InvalidAmount");
    }
    expect(failedAbove).to.equal(true);
  });

  it("rejects startSecondPhase before end_ts and fulfillRandomness in wrong phase / before vrf_ready_ts", async () => {
    const adminPubkey = wallet.publicKey;

    const walletFee = Keypair.generate();
    const walletKeeper = Keypair.generate();

    await fund(walletFee.publicKey, 0.05);
    await fund(walletKeeper.publicKey, 0.05);

    const feeBps = 100;

    //
    // 1) startSecondPhase before end_ts → "Entry period has not ended yet"
    //
    const lotteryId1 = uniqueLotteryId();
    const lotteryIdLe1 = toLEBytes8(lotteryId1);

    const [lotteryPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe1],
      program.programId
    );

    const [vaultPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda1.toBuffer()],
      program.programId
    );

    const now1 = Math.floor(Date.now() / 1000);
    const startTs1 = new BN(now1 - 10);
    const endTs1 = new BN(now1 + 600);

    await program.methods
      .initialize(lotteryId1, startTs1, endTs1, feeBps, null, null, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda1,
        vault: vaultPda1,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();


    const weightsHash1 = new Array<number>(32).fill(1);
    const waitSeconds1 = new BN(10);

    // dummy randomness account — handler hits the "Entry period has not ended yet"
    // check before any owner/parse validation on the randomness account
    const dummyRandomness1 = walletFee.publicKey;

    let failedPhase2Early = false;
    try {
      await program.methods
        .startSecondPhase(weightsHash1 as any, waitSeconds1)
        .accounts({
          lottery: lotteryPda1,
          admin: adminPubkey,
          randomnessAccountData: dummyRandomness1,
        })
        .rpc();

    } catch (e) {
      failedPhase2Early = true;
      const msg = (e as Error).toString();
      expect(msg).to.include("Entry period has not ended yet");
    }
    expect(failedPhase2Early).to.equal(true);

    //
    // 2) fulfillRandomness in the wrong phase (status = Open) → "Wrong phase for this action"
    //
    const lotteryId2 = uniqueLotteryId();
    const lotteryIdLe2 = toLEBytes8(lotteryId2);

    const [lotteryPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe2],
      program.programId
    );

    const [vaultPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda2.toBuffer()],
      program.programId
    );

    const now2 = Math.floor(Date.now() / 1000);
    const startTs2 = new BN(now2 - 10);
    const endTs2 = new BN(now2 + 20); // devnet-safe buffer

    await program.methods
      .initialize(lotteryId2, startTs2, endTs2, feeBps, null, null, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda2,
        vault: vaultPda2,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();


    // dummy randomness account — handler hits the "WrongPhase" check (status=Open)
    // before any randomness validation
    const dummyRandomness2 = walletFee.publicKey;

    let failedFulfillWrongPhase = false;
    try {
      await program.methods
        .fulfillRandomness()
        .accounts({
          lottery: lotteryPda2,
          randomnessAccountData: dummyRandomness2,
        })
        .rpc();

    } catch (e) {
      failedFulfillWrongPhase = true;
      const msg = (e as Error).toString();
      expect(msg).to.include("Wrong phase for this action");
    }
    expect(failedFulfillWrongPhase).to.equal(true);

    // TODO: 3) fulfillRandomness before vrf_ready_ts needs a real Switchboard
    // randomness account (startSecondPhase validates owner == Switchboard).
    // Skipped until a Switchboard mock exists.
  });

  // TODO: requires Switchboard randomness account mock for localnet
  it.skip("handles startPurchasesPhase correctly when totalDeposited == 0", async () => {
    const adminPubkey = wallet.publicKey;

    const walletFee = Keypair.generate();
    const walletKeeper = Keypair.generate();

    await fund(walletFee.publicKey, 0.05);
    await fund(walletKeeper.publicKey, 0.05);

    const lotteryId = uniqueLotteryId();
    const lotteryIdLe = toLEBytes8(lotteryId);

    const [lotteryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda.toBuffer()],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    const startTs = new BN(now - 200);
    const endTs = new BN(now - 10); // the round has already ended
    const feeBps = 100;

    await program.methods
      .initialize(lotteryId, startTs, endTs, feeBps, null, null, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();


    // NOT A SINGLE DEPOSIT → totalDeposited == 0
    const lotteryBefore = await program.account.lottery.fetch(lotteryPda);
    expect(lotteryBefore.totalDeposited.toString()).to.equal("0");

    const vaultBefore = await getBalance(vaultPda);
    const feeBefore = await getBalance(walletFee.publicKey);
    const keeperBefore = await getBalance(walletKeeper.publicKey);

    const weightsHash = new Array<number>(32).fill(3);
    const waitSeconds = new BN(1);

    await program.methods
      .startSecondPhase(weightsHash as any, waitSeconds)
      .accounts({
        lottery: lotteryPda,
        admin: adminPubkey,
      })
      .rpc();


    // wait for vrf_ready_ts to arrive (poll)
    const afterPhase2 = await program.account.lottery.fetch(lotteryPda);
    await waitUntilUnix(afterPhase2.vrfReadyTs.toNumber(), 1);

    const seed = new Array<number>(32).fill(5);

    await program.methods
      .fulfillRandomness(seed as any)
      .accounts({
        lottery: lotteryPda,
        admin: adminPubkey,
      })
      .rpc();


    const lotteryReady = await program.account.lottery.fetch(lotteryPda);
    expect(getStatusKey(lotteryReady.status)).to.equal("readyToDraw");
    expect(lotteryReady.totalDeposited.toString()).to.equal("0");

    await program.methods
      .startPurchasesPhase()
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
      })
      .rpc();


    const lotteryAfter = await program.account.lottery.fetch(lotteryPda);
    expect(getStatusKey(lotteryAfter.status)).to.equal("proceedingPurchases");
    expect(lotteryAfter.totalDeposited.toString()).to.equal("0");
    expect(lotteryAfter.depositsCount.toNumber()).to.equal(0);

    const vaultAfter = await getBalance(vaultPda);
    const feeAfter = await getBalance(walletFee.publicKey);
    const keeperAfter = await getBalance(walletKeeper.publicKey);

    // At total == 0 no lamports may move
    expect(vaultAfter.toString()).to.equal(vaultBefore.toString());
    expect(feeAfter.toString()).to.equal(feeBefore.toString());
    expect(keeperAfter.toString()).to.equal(keeperBefore.toString());
  });

  it("does not allow non-admin to call admin-only instructions", async () => {
    const adminPubkey = wallet.publicKey;

    const walletFee = Keypair.generate();
    const walletKeeper = Keypair.generate();
    const hacker = Keypair.generate();

    await fund(walletFee.publicKey, 0.05);
    await fund(walletKeeper.publicKey, 0.05);
    await fund(hacker.publicKey, 0.2);

    const lotteryId = uniqueLotteryId();
    const lotteryIdLe = toLEBytes8(lotteryId);

    const [lotteryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda.toBuffer()],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    const startTs = new BN(now - 10);
    const endTs = new BN(now + 600);
    const feeBps = 100;

    await program.methods
      .initialize(lotteryId, startTs, endTs, feeBps, null, null, TEST_MAX_TOTAL, TEST_VRF_HASH)
      .accounts({
        lottery: lotteryPda,
        vault: vaultPda,
        walletFee: walletFee.publicKey,
        walletKeeper: walletKeeper.publicKey,
        admin: adminPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    async function expectHasOneViolation(promise: Promise<any>) {
      let failed = false;
      try {
        await promise;
      } catch (e) {
        failed = true;
        const msg = (e as Error).toString();
        expect(
          msg.includes("ConstraintHasOne") ||
          msg.includes("has one") ||
          msg.includes("custom program error")
        ).to.equal(true);
      }
      expect(failed).to.equal(true);
    }


    const weightsHash = new Array<number>(32).fill(1);

    // a dummy randomness account — has_one=admin fails before it reaches the randomness
    const dummyRandomness = walletFee.publicKey;

    // startSecondPhase
    await expectHasOneViolation(
      program.methods
        .startSecondPhase(weightsHash as any, new BN(10))
        .accounts({
          lottery: lotteryPda,
          admin: hacker.publicKey,
          randomnessAccountData: dummyRandomness,
        })
        .signers([hacker])
        .rpc({ commitment: "confirmed" })
    );

    // fulfillRandomness is permissionless (no admin signer in Accounts), so we skip it

    // pause
    await expectHasOneViolation(
      program.methods
        .pause()
        .accounts({
          lottery: lotteryPda,
          admin: hacker.publicKey,
        })
        .signers([hacker])
        .rpc({ commitment: "confirmed" })
    );

    // unpause
    await expectHasOneViolation(
      program.methods
        .unpause()
        .accounts({
          lottery: lotteryPda,
          admin: hacker.publicKey,
        })
        .signers([hacker])
        .rpc({ commitment: "confirmed" })
    );

    // updateMaxAmount
    await expectHasOneViolation(
      program.methods
        .updateMaxAmount(new BN(100_000_000))
        .accounts({
          lottery: lotteryPda,
          admin: hacker.publicKey,
        })
        .signers([hacker])
        .rpc({ commitment: "confirmed" })
    );

    // startPurchasesPhase
    await expectHasOneViolation(
      program.methods
        .startPurchasesPhase()
        .accounts({
          lottery: lotteryPda,
          vault: vaultPda,
          walletFee: walletFee.publicKey,
          walletKeeper: walletKeeper.publicKey,
          admin: hacker.publicKey,
        })
        .signers([hacker])
        .rpc({ commitment: "confirmed" })
    );

    // closeLottery
    await expectHasOneViolation(
      program.methods
        .closeLottery()
        .accounts({
          lottery: lotteryPda,
          vault: vaultPda,
          admin: hacker.publicKey,
        })
        .signers([hacker])
        .rpc({ commitment: "confirmed" })
    );
  });

  it("rejects zero vrf_algorithm_hash on initialize", async () => {
    const adminPubkey = wallet.publicKey;

    const walletFee = Keypair.generate();
    const walletKeeper = Keypair.generate();

    const lotteryId = uniqueLotteryId();
    const lotteryIdLe = toLEBytes8(lotteryId);

    const [lotteryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), adminPubkey.toBuffer(), lotteryIdLe],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lotteryPda.toBuffer()],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    const startTs = new BN(now - 10);
    const endTs = new BN(now + 600);
    const feeBps = 100;

    const zeroHash = Array.from(Buffer.alloc(32, 0)) as number[];

    let failed = false;
    try {
      await program.methods
        .initialize(lotteryId, startTs, endTs, feeBps, null, null, TEST_MAX_TOTAL, zeroHash)
        .accounts({
          lottery: lotteryPda,
          vault: vaultPda,
          walletFee: walletFee.publicKey,
          walletKeeper: walletKeeper.publicKey,
          admin: adminPubkey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e) {
      failed = true;
      const err = e as AnchorError;
      expect(err.error.errorCode.code).to.equal("InvalidVrfAlgorithmHash");
    }
    expect(failed).to.equal(true);
  });
});
