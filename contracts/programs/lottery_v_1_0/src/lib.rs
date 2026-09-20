use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
};
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::sysvar::slot_hashes;
use orao_solana_vrf::program::OraoVrf;
use orao_solana_vrf::state::{NetworkState, RandomnessAccountData};
use orao_solana_vrf::{CONFIG_ACCOUNT_SEED, RANDOMNESS_ACCOUNT_SEED};

#[cfg(all(feature = "devnet", feature = "mainnet"))]
compile_error!("Enable only one network feature: 'devnet' or 'mainnet'.");
#[cfg(not(any(feature = "devnet", feature = "mainnet")))]
compile_error!("Select network feature: 'devnet' or 'mainnet'.");

#[cfg(feature = "devnet")]
declare_id!("4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH");

#[cfg(feature = "mainnet")]
declare_id!("4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH");

// --- Default constants ---
pub const MIN_AMOUNT_LAMPORTS_DEFAULT: u64 = 50_000_000;          // 0.05 SOL
pub const MAX_AMOUNT_LAMPORTS_DEFAULT: u64 = 250 * 1_000_000_000; // 250 SOL

/// How long the round waits for ORAO before the admin is allowed to draw it
/// with a seed of their own.
///
/// Measured on devnet on 2026-09-20 over three requests: 1.5s, 1.5s and 11.8s.
/// Two minutes is ten times the worst of those, so a healthy oracle always
/// answers first and only a real outage ever reaches this path.
///
/// It is not longer for a product reason. A round sitting in PendingVrf is a
/// promise to buy that has not been kept yet, and the coin behind it is being
/// watched while that lasts. An hour of that is worse than the thing this
/// delay guards against.
///
/// The delay is not what keeps the admin honest anyway. The program reads the
/// request account and refuses the moment randomness is there, so the wait only
/// gives ORAO its fair chance; it cannot be used to shop for a better result at
/// any length.
pub const EMERGENCY_FULFILL_DELAY_SECONDS: i64 = 120;

/// Maximum allowed lottery duration (7 days)
pub const MAX_LOTTERY_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60;


/// ORAO VRF. The same program on devnet and mainnet, so unlike the oracle it
/// replaced this one needs no per-network constant and cannot be built for the
/// wrong one.
pub const ORAO_VRF_PROGRAM_ID: Pubkey = pubkey!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

/// Domain tag mixed into the request seed so it can never collide with a seed
/// derived by some other program for some other purpose.
pub const VRF_FORCE_DOMAIN: &[u8] = b"pumpling-vrf-force-v1";

/// Domain tag for folding ORAO's 64 bytes down to the 32 the round stores.
pub const VRF_SEED_DOMAIN: &[u8] = b"pumpling-vrf-seed-v1";

/// How far back the slot whose hash seeds the request may be.
///
/// The sysvar keeps 512 slots, about three and a half minutes. A quarter of
/// that leaves a client plenty of room to build and land the transaction while
/// keeping the hash firmly on this side of the round closing.
pub const MAX_SEED_SLOT_AGE_SLOTS: u64 = 128;

/// The request seed for a round.
///
/// Derived, never supplied. Anyone can recompute it from the round's address,
/// the weights commitment and the slot hash the round was closed against, which
/// is what makes the choice of randomness account checkable from outside.
pub fn derive_vrf_force(
    lottery: &Pubkey,
    weights_hash: &[u8; 32],
    slot_hash: &[u8; 32],
) -> [u8; 32] {
    hashv(&[VRF_FORCE_DOMAIN, lottery.as_ref(), weights_hash, slot_hash]).to_bytes()
}

/// The hash of one recent slot, looked up in the sysvar.
///
/// The caller names the slot instead of the program taking the newest one, and
/// it has to be that way round: the seed is derived from this hash, the request
/// account's address is derived from the seed, and the address has to be in the
/// transaction before it runs. Nobody can predict which slot a transaction will
/// land in, so the newest hash is not something a client can compute ahead.
///
/// Naming it does not hand anything over. The window is short and every hash in
/// it is already fixed by the chain, so the choice is between values nobody can
/// steer. What matters is that none of them exist before the round closes.
///
/// The sysvar is far too large to deserialize, so the entries are read by hand:
/// an 8-byte vector length, then pairs of an 8-byte slot and its 32-byte hash,
/// sorted newest first. Sorted, so this is a binary search rather than a walk
/// through five hundred entries.
fn slot_hash_at(slot_hashes: &AccountInfo, slot: u64, clock_slot: u64) -> Result<[u8; 32]> {
    require_keys_eq!(
        *slot_hashes.key,
        slot_hashes::ID,
        LotteryError::InvalidSlotHashesSysvar
    );
    require!(slot < clock_slot, LotteryError::SeedSlotNotFound);
    require!(
        clock_slot.saturating_sub(slot) <= MAX_SEED_SLOT_AGE_SLOTS,
        LotteryError::SeedSlotTooOld
    );

    let data = slot_hashes.try_borrow_data()?;
    require!(data.len() >= 8, LotteryError::InvalidSlotHashesSysvar);
    let count = u64::from_le_bytes(
        data[0..8]
            .try_into()
            .map_err(|_| LotteryError::InvalidSlotHashesSysvar)?,
    ) as usize;
    require!(
        data.len() >= 8usize.saturating_add(count.saturating_mul(40)),
        LotteryError::InvalidSlotHashesSysvar
    );

    let (mut lo, mut hi) = (0usize, count);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let offset = 8 + mid * 40;
        let entry_slot = u64::from_le_bytes(
            data[offset..offset + 8]
                .try_into()
                .map_err(|_| LotteryError::InvalidSlotHashesSysvar)?,
        );
        if entry_slot == slot {
            let mut hash = [0u8; 32];
            hash.copy_from_slice(&data[offset + 8..offset + 40]);
            return Ok(hash);
        } else if entry_slot > slot {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    Err(LotteryError::SeedSlotNotFound.into())
}

/// Reads an ORAO randomness request, checking it is really one of theirs.
///
/// The owner check is the important line: without it any account laid out to
/// look like a fulfilled request would be taken at face value.
fn read_vrf_request(request: &AccountInfo) -> Result<RandomnessAccountData> {
    require_keys_eq!(
        *request.owner,
        ORAO_VRF_PROGRAM_ID,
        LotteryError::InvalidRandomnessAccountOwner
    );
    let data = request.try_borrow_data()?;
    RandomnessAccountData::try_deserialize(&mut &data[..])
        .map_err(|_| LotteryError::InvalidRandomnessAccountData.into())
}

/// Who to tell about a hole in this program.
///
/// Written into an ELF section of the binary, so it travels with the deployed
/// code rather than living somewhere that can quietly stop matching it.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Pumpling",
    project_url: "https://pumpling.xyz",
    contacts: "email:pumpling.xyz@gmail.com,link:https://github.com/dabdabych/pumpling/security",
    policy: "https://github.com/dabdabych/pumpling/blob/main/SECURITY.md",
    preferred_languages: "en,ru",
    source_code: "https://github.com/dabdabych/pumpling",
    auditors: "None"
}

#[program]
pub mod lottery {
    use super::*;

    // -----------------------
    // PHASE 1: LOTTERY INITIALIZATION
    // -----------------------
    pub fn initialize(
        ctx: Context<InitializeLottery>,
        _lottery_id: u64,
        start_ts: i64,
        end_ts: i64,
        fee_bps: u16,
        min_amount: Option<u64>,
        max_amount: Option<u64>,
        max_total: u64,
        vrf_algorithm_hash: [u8; 32],
    ) -> Result<()> {
        // basic time validation
        require!(start_ts > 0, LotteryError::InvalidTimeRange);
        require!(end_ts > start_ts, LotteryError::InvalidTimeRange);

        require!(
            vrf_algorithm_hash != [0u8; 32],
            LotteryError::InvalidVrfAlgorithmHash
        );

        let duration = end_ts
            .checked_sub(start_ts)
            .ok_or(LotteryError::InvalidTimeRange)?;
        require!(
            duration <= MAX_LOTTERY_DURATION_SECONDS,
            LotteryError::DurationTooLong
        );

        require!(fee_bps <= 500, LotteryError::FeeTooHigh);
        let vault_info = ctx.accounts.vault.to_account_info();

        // The vault PDA has not been created yet
        if vault_info.lamports() == 0 {
            let space: u64 = 0;

            let rent = Rent::get()?;
            let lamports = rent.minimum_balance(space as usize);

            let create_ix = system_instruction::create_account(
                &ctx.accounts.admin.key(),
                &vault_info.key(),
                lamports,
                space,
                &ctx.accounts.system_program.key(), // owner = System Program
            );

            let vault_bump = ctx.bumps.vault;
            let lottery_key = ctx.accounts.lottery.key();

            let signer_seeds: &[&[u8]] = &[
                b"vault",
                lottery_key.as_ref(),
                &[vault_bump],
            ];

            invoke_signed(
                &create_ix,
                &[
                    ctx.accounts.admin.to_account_info(),
                    vault_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[signer_seeds],
            )?;
        }

        require_keys_eq!(
            *ctx.accounts.vault.to_account_info().owner,
            ctx.accounts.system_program.key(),
            LotteryError::InvalidVaultOwner
        );

        require!(
            ctx.accounts.vault.to_account_info().data_is_empty(),
            LotteryError::InvalidVaultData
        );


        let l = &mut ctx.accounts.lottery;

        l.admin = ctx.accounts.admin.key();
        l.start_ts = start_ts;
        l.end_ts = end_ts;
        l.fee_bps = fee_bps;

        // wallets
        l.wallet_fee = ctx.accounts.wallet_fee.key();
        l.wallet_keeper = ctx.accounts.wallet_keeper.key();

        require!(
            l.wallet_fee != l.wallet_keeper,
            LotteryError::WalletsMustBeDifferent
        );

        l.min_amount = min_amount.unwrap_or(MIN_AMOUNT_LAMPORTS_DEFAULT);
        l.max_amount = max_amount.unwrap_or(MAX_AMOUNT_LAMPORTS_DEFAULT);

        require!(
            l.min_amount > 0 && l.min_amount <= l.max_amount,
            LotteryError::InvalidAmountBounds
        );
        require!(
            max_total >= l.min_amount,
            LotteryError::InvalidTotalLimit
        );

        l.status = LotteryStatus::Open;
        l.paused = false;

        l.deposits_count = 0;
        l.total_deposited = 0;
        l.max_total = max_total;

        // VRF phase2/3 default fields
        l.weights_hash = [0u8; 32];
        l.vrf_requested_ts = 0;
        l.vrf_seed = [0u8; 32];
        l.vrf_called = false;
        l.vrf_request = Pubkey::default();
        l.vrf_force = [0u8; 32];
        l.vrf_seed_slot = 0;
        l.vrf_algorithm_hash = vrf_algorithm_hash;

        emit!(LotteryInitialized {
            lottery: l.key(),
            admin: l.admin,
            start_ts,
            end_ts,
            min_amount: l.min_amount,
            max_amount: l.max_amount,
            max_total,
            vrf_algorithm_hash,
        });

        Ok(())
    }

    // -----------------------
    // PHASE 1: DEPOSIT SOL
    // -----------------------
    pub fn deposit_sol(
        ctx: Context<DepositSol>,
        mint_arg: Pubkey,
        amount: u64,
    ) -> Result<()> {
        let l = &mut ctx.accounts.lottery;
        let clock = Clock::get()?;

        require!(!l.paused, LotteryError::Paused);
        require!(l.status == LotteryStatus::Open, LotteryError::NotOpen);
        require!(clock.unix_timestamp >= l.start_ts, LotteryError::NotStarted);
        require!(clock.unix_timestamp <= l.end_ts, LotteryError::Ended);

        require!(
            amount >= l.min_amount && amount <= l.max_amount,
            LotteryError::InvalidAmount
        );

        require_keys_eq!(mint_arg, ctx.accounts.mint.key(), LotteryError::MintKeyMismatch);

        // transfer SOL -> vault
        let ix = system_instruction::transfer(
            &ctx.accounts.payer.key(),
            &ctx.accounts.vault.key(),
            amount,
        );

        invoke(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // update counters
        let new_total = l.total_deposited
            .checked_add(amount as u128)
            .ok_or(LotteryError::Overflow)?;
        require!(
            new_total <= l.max_total as u128,
            LotteryError::TotalLimitExceeded
        );
        l.deposits_count = l.deposits_count.checked_add(1).ok_or(LotteryError::Overflow)?;
        l.total_deposited = new_total;

        emit!(Deposit {
            lottery: l.key(),
            user: ctx.accounts.payer.key(),
            mint: mint_arg,
            amount,
            ts: clock.unix_timestamp,
        });

        Ok(())
    }

    // -----------------------
    // PHASE 2: HASH COMMIT
    // -----------------------
    pub fn start_second_phase(
        ctx: Context<StartSecondPhase>,
        weights_hash: [u8; 32],
        seed_slot: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        // Read before the mutable borrow: the seed is derived from the round's
        // own address and the sysvar, and both are needed while `lottery` is
        // still only borrowed immutably.
        let lottery_key = ctx.accounts.lottery.key();
        let slot_hash = slot_hash_at(&ctx.accounts.recent_slothashes, seed_slot, clock.slot)?;

        let l = &mut ctx.accounts.lottery;

        require!(l.status == LotteryStatus::Open, LotteryError::WrongPhase);
        require!(
            now >= l.end_ts
                || l.total_deposited == l.max_total as u128
                || (l.max_total as u128)
                    .saturating_sub(l.total_deposited)
                    <= 2 * l.min_amount as u128,
            LotteryError::NotEndedYet
        );
        require!(l.weights_hash == [0u8; 32], LotteryError::WeightsHashAlreadySet);
        require!(
            weights_hash != [0u8; 32],
            LotteryError::InvalidWeightsHash
        );
        // The request seed. The program derives it and never takes it as an
        // argument, and that is the whole point.
        //
        // With ORAO the randomness account is a PDA of the seed, so whoever
        // picks the seed picks which of many possible results the round gets:
        // request, look, dislike, request again. Deriving it here leaves
        // exactly one valid request address per round, so there is nothing to
        // choose between and no second draw to reach for.
        //
        // The slot hash is in there for a different reason. The value is ORAO's
        // signature over the seed, and ORAO can compute that for any seed at
        // any time. A seed anyone could work out in advance would let the
        // fulfillers know the outcome while deposits were still open. Mixing in
        // a hash that does not exist until this transaction lands, after
        // deposits have closed, takes that away.
        let force = derive_vrf_force(&lottery_key, &weights_hash, &slot_hash);

        // The request account must be the one that seed points at. ORAO would
        // reject a mismatch anyway, since it creates the account at that PDA,
        // but failing here names the reason instead of surfacing a seeds error
        // from somebody else's program.
        let (expected_request, _bump) = Pubkey::find_program_address(
            &[RANDOMNESS_ACCOUNT_SEED, &force],
            &ORAO_VRF_PROGRAM_ID,
        );
        require_keys_eq!(
            ctx.accounts.vrf_request.key(),
            expected_request,
            LotteryError::RandomnessAccountMismatch
        );

        l.weights_hash = weights_hash;
        l.vrf_force = force;
        l.vrf_seed_slot = seed_slot;
        l.vrf_request = ctx.accounts.vrf_request.key();
        l.vrf_requested_ts = now;
        l.status = LotteryStatus::PendingVrf;

        // Ask ORAO. This is a CPI rather than a separate instruction in the
        // same transaction so that the seed cannot be swapped on the way.
        let cpi_accounts = orao_solana_vrf::cpi::accounts::RequestV2 {
            payer: ctx.accounts.admin.to_account_info(),
            network_state: ctx.accounts.vrf_network_state.to_account_info(),
            treasury: ctx.accounts.vrf_treasury.to_account_info(),
            request: ctx.accounts.vrf_request.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        orao_solana_vrf::cpi::request_v2(
            CpiContext::new(ctx.accounts.vrf_program.to_account_info(), cpi_accounts),
            force,
        )?;

        emit!(Phase2Started {
            lottery: lottery_key,
            weights_hash,
            randomness_account: ctx.accounts.vrf_request.key(),
            force,
            seed_slot,
            requested_ts: now,
            requested_slot: clock.slot,
        });

        emit!(PhaseChanged {
            lottery: l.key(),
            status: l.status,
        });

        Ok(())
    }

    // -----------------------
    // PHASE 3: VRF SEED
    // -----------------------

    /// Takes the randomness ORAO produced for this round and writes it in.
    ///
    /// Permissionless on purpose: the result is already fixed by the time this
    /// runs, so anybody may push the round forward and nobody has to wait for
    /// us to do it.
    pub fn fulfill_randomness(ctx: Context<FulfillRandomness>) -> Result<()> {
        let request_key = ctx.accounts.vrf_request.key();
        let request = read_vrf_request(&ctx.accounts.vrf_request)?;
        let request_seed = *request.seed();
        // Copied out now, unwrapped last: a round in the wrong phase should say
        // so rather than complain that randomness has not arrived.
        let fulfilled = request.fulfilled_randomness().copied();

        let l = &mut ctx.accounts.lottery;

        require!(l.status == LotteryStatus::PendingVrf, LotteryError::WrongPhase);
        require!(!l.vrf_called, LotteryError::VrfAlreadyCalled);
        require_keys_eq!(
            request_key,
            l.vrf_request,
            LotteryError::RandomnessAccountMismatch
        );

        // The account is a PDA of the seed, so this can only fail if the round
        // was pointed at somebody else's request. Checked anyway: the seed is
        // what the whole draw hangs on.
        require!(
            request_seed == l.vrf_force,
            LotteryError::RandomnessRequestMismatch
        );

        let randomness = fulfilled.ok_or(LotteryError::RandomnessNotResolved)?;

        // ORAO returns 64 bytes and the round carries 32. We hash rather than
        // truncate so every byte it produced has a say in the result.
        let seed = hashv(&[VRF_SEED_DOMAIN, &randomness]).to_bytes();
        require!(seed != [0u8; 32], LotteryError::InvalidVrfSeed);

        l.vrf_seed = seed;
        l.vrf_called = true;
        l.status = LotteryStatus::ReadyToDraw;

        emit!(VrfFulfilled {
            lottery: l.key(),
            seed,
        });

        emit!(PhaseChanged {
            lottery: l.key(),
            status: l.status,
        });

        Ok(())
    }

    /// The way out if ORAO itself stops answering.
    ///
    /// It cannot be used to dislike a result. The program reads the request
    /// account and refuses the moment randomness is there, so the only state
    /// this instruction accepts is one an outsider can check: the wait has gone
    /// by and the request is still empty.
    pub fn emergency_fulfill_randomness(
        ctx: Context<EmergencyFulfillRandomness>,
        seed: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let request_key = ctx.accounts.vrf_request.key();
        let request = read_vrf_request(&ctx.accounts.vrf_request)?;
        let still_pending = request.fulfilled_randomness().is_none();
        let request_seed = *request.seed();

        let l = &mut ctx.accounts.lottery;

        require!(l.status == LotteryStatus::PendingVrf, LotteryError::WrongPhase);
        require!(!l.vrf_called, LotteryError::VrfAlreadyCalled);
        require_keys_eq!(
            request_key,
            l.vrf_request,
            LotteryError::RandomnessAccountMismatch
        );
        require!(
            request_seed == l.vrf_force,
            LotteryError::RandomnessRequestMismatch
        );
        require!(still_pending, LotteryError::RandomnessAlreadyResolved);
        require!(
            clock.unix_timestamp
                >= l
                    .vrf_requested_ts
                    .checked_add(EMERGENCY_FULFILL_DELAY_SECONDS)
                    .ok_or(LotteryError::Overflow)?,
            LotteryError::VrfNotReady
        );
        require!(seed != [0u8; 32], LotteryError::InvalidVrfSeed);

        l.vrf_seed = seed;
        l.vrf_called = true;
        l.status = LotteryStatus::ReadyToDraw;

        emit!(EmergencySeedUsed {
            lottery: l.key(),
            seed,
            requested_ts: l.vrf_requested_ts,
            ts: clock.unix_timestamp,
        });

        emit!(PhaseChanged {
            lottery: l.key(),
            status: l.status,
        });

        Ok(())
    }



    // -----------------------
    // PHASE 4: FUND DISTRIBUTION
    // -----------------------
    pub fn start_purchases_phase(ctx: Context<StartPurchasesPhase>) -> Result<()> {
        let l = &mut ctx.accounts.lottery;

        require!(l.status == LotteryStatus::ReadyToDraw, LotteryError::WrongPhase);

        let total = l.total_deposited;
        let vault = &ctx.accounts.vault;
        let system_program = &ctx.accounts.system_program;

        if total == 0 {
            l.status = LotteryStatus::ProceedingPurchases;

            emit!(PurchasesPhaseStarted {
                lottery: l.key(),
                fee_amount: 0,
                meme_amount: 0,
            });

            emit!(PhaseChanged { lottery: l.key(), status: l.status });
            return Ok(());
        }

        // compute split (total == 0 already handled above)
        let fee_u128 = total
            .checked_mul(l.fee_bps as u128)
            .ok_or(LotteryError::Overflow)?
            / 10_000;

        let keeper_u128 = total
            .checked_sub(fee_u128)
            .ok_or(LotteryError::Overflow)?;

        

        let fee_amount: u64 = fee_u128.try_into().map_err(|_| LotteryError::Overflow)?;
        let keeper_amount: u64 = keeper_u128.try_into().map_err(|_| LotteryError::Overflow)?;

        // ensure vault balance
        require!(
            total <= u64::MAX as u128,
            LotteryError::Overflow
        );
        // ensure vault balance (safe u128 → u64 conversion)
        let total_u64: u64 = total.try_into().map_err(|_| LotteryError::Overflow)?;

        require!(
            vault.to_account_info().lamports() >= total_u64,
            LotteryError::InsufficientVaultBalance
        );

        let vault_bump = ctx.bumps.vault;
        let lottery_key = l.key();
        let signer_seeds: &[&[u8]] = &[
            b"vault",
            lottery_key.as_ref(),
            &[vault_bump],
        ];

        // transfer fee
        if fee_amount > 0 {
            let ix = system_instruction::transfer(
                &vault.key(),
                &ctx.accounts.wallet_fee.key(),
                fee_amount,
            );
            invoke_signed(
                &ix,
                &[
                    vault.to_account_info(),
                    ctx.accounts.wallet_fee.to_account_info(),
                    system_program.to_account_info(),
                ],
                &[signer_seeds],
            )?;
        }

        // transfer keeper amount
        if keeper_amount > 0 {
            let ix = system_instruction::transfer(
                &vault.key(),
                &ctx.accounts.wallet_keeper.key(),
                keeper_amount,
            );
            invoke_signed(
                &ix,
                &[
                    vault.to_account_info(),
                    ctx.accounts.wallet_keeper.to_account_info(),
                    system_program.to_account_info(),
                ],
                &[signer_seeds],
            )?;
        }

        // reset counters
        l.total_deposited = 0;
        l.deposits_count = 0;

        l.status = LotteryStatus::ProceedingPurchases;

        emit!(PurchasesPhaseStarted {
            lottery: l.key(),
            fee_amount,
            meme_amount: keeper_amount,
        });

        emit!(PhaseChanged {
            lottery: l.key(),
            status: l.status,
        });

        Ok(())
    }

    // -----------------------
    // Pause / Unpause
    // -----------------------
    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        let l = &mut ctx.accounts.lottery;

        require!(!l.paused, LotteryError::AlreadyPaused);

        l.paused = true;

        emit!(PauseStatusChanged {
            lottery: l.key(),
            paused: true,
        });

        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        let l = &mut ctx.accounts.lottery;

        require!(l.paused, LotteryError::NotPaused);

        l.paused = false;

        emit!(PauseStatusChanged {
            lottery: l.key(),
            paused: false,
        });

        Ok(())
    }

    // -----------------------
    // Update max_amount
    // -----------------------
    pub fn update_max_amount(ctx: Context<AdminOnly>, new_max: u64) -> Result<()> {
        let l = &mut ctx.accounts.lottery;

        require!(new_max >= l.min_amount, LotteryError::InvalidAmountBounds);

        l.max_amount = new_max;

        emit!(LimitsUpdated {
            lottery: l.key(),
            min_amount: l.min_amount,
            max_amount: l.max_amount,
        });

        Ok(())
    }

    // -----------------------
    // CLOSE LOTTERY (vault closes too). All the remaining lamports would been sent
    // to admin pubkey, which is fixed in the rules
    // -----------------------
    pub fn close_lottery(ctx: Context<CloseLottery>) -> Result<()> {
        let l = &mut ctx.accounts.lottery;

        let no_deposits = l.deposits_count == 0 && l.total_deposited == 0;
        if !no_deposits {
            require!(
                l.status == LotteryStatus::ProceedingPurchases,
                LotteryError::NotInPurchasesPhase
            );
        }

        let vault = &ctx.accounts.vault;
        let admin = &ctx.accounts.admin;

        let system_program = &ctx.accounts.system_program;

        let lamports = vault.to_account_info().lamports();

        if lamports > 0 {
            let bump = ctx.bumps.vault;
            let lottery_key = l.key();
            let signer_seeds: &[&[u8]] = &[
                b"vault",
                lottery_key.as_ref(),
                &[bump],
            ];

            let ix = system_instruction::transfer(&vault.key(), &admin.key(), lamports);

            invoke_signed(
                &ix,
                &[
                    vault.to_account_info(),
                    admin.to_account_info(),
                    system_program.to_account_info(),
                ],
                &[signer_seeds],
            )?;
        }

        l.status = LotteryStatus::Closed;

        emit!(PhaseChanged {
            lottery: l.key(),
            status: l.status,
        });

        Ok(())
    }

}

// ========= STATE =========

#[account]
pub struct Lottery {
    // base params
    pub admin: Pubkey,
    pub start_ts: i64,
    pub end_ts: i64,
    pub fee_bps: u16,

    // wallets
    pub wallet_fee: Pubkey,
    pub wallet_keeper: Pubkey,

    // limits
    pub min_amount: u64,
    pub max_amount: u64,
    pub max_total: u64,

    // status flags
    pub status: LotteryStatus,
    pub paused: bool,

    // counters
    pub deposits_count: u64,
    pub total_deposited: u128,

    // phase 2 + phase 3 VRF fields
    pub weights_hash: [u8; 32],
    /// When the randomness was asked for. The emergency path counts from here.
    pub vrf_requested_ts: i64,
    pub vrf_seed: [u8; 32],
    pub vrf_called: bool,
    /// The ORAO request account this round is bound to. A PDA of `vrf_force`,
    /// stored so the binding is readable without recomputing anything.
    pub vrf_request: Pubkey,
    /// The request seed the program derived. Kept on chain so a verifier can
    /// recompute it and confirm the round could not have shopped for another.
    pub vrf_force: [u8; 32],
    /// The slot whose hash went into `vrf_force`. Without it the derivation
    /// cannot be reproduced, so it is part of the proof, not bookkeeping.
    pub vrf_seed_slot: u64,

    /// sha256 of the canonical VRF used for this lottery. Set once in
    /// initialize, immutable thereafter. Verified off-chain by users.
    pub vrf_algorithm_hash: [u8; 32],
}

impl Lottery {
    /// Field by field, so a change to the struct that forgets this line is
    /// obvious rather than a truncated account three rounds later.
    pub const SPACE: usize =
        8 +   // anchor discriminator
        32 +  // admin
        8 +   // start_ts
        8 +   // end_ts
        2 +   // fee_bps
        32 +  // wallet_fee
        32 +  // wallet_keeper
        8 +   // min_amount
        8 +   // max_amount
        8 +   // max_total
        1 +   // status
        1 +   // paused
        8 +   // deposits_count
        16 +  // total_deposited
        32 +  // weights_hash
        8 +   // vrf_requested_ts
        32 +  // vrf_seed
        1 +   // vrf_called
        32 +  // vrf_request
        32 +  // vrf_force
        8 +   // vrf_seed_slot
        32;   // vrf_algorithm_hash
}

// ========= ENUM =========

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum LotteryStatus {
    Open = 0,
    PendingVrf = 1,
    ReadyToDraw = 2,
    ProceedingPurchases = 3,
    Closed = 4,
}

// ========= CONTEXTS =========

#[derive(Accounts)]
#[instruction(lottery_id: u64)]
pub struct InitializeLottery<'info> {
    #[account(
        init,
        payer = admin,
        space = Lottery::SPACE,
        seeds = [b"lottery", admin.key().as_ref(), &lottery_id.to_le_bytes()],
        bump,
    )]
    pub lottery: Account<'info, Lottery>,

    /// CHECK: System-owned PDA vault, created manually via invoke_signed
    #[account(
        mut,
        seeds = [b"vault", lottery.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// Commission wallet
    #[account(mut)]
    pub wallet_fee: SystemAccount<'info>,

    /// Keeper wallet (for off-chain purchases & distributions)
    #[account(mut)]
    pub wallet_keeper: SystemAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub lottery: Account<'info, Lottery>,

    #[account(
        mut,
        seeds = [b"vault", lottery.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK:
    /// We only verify that this account's key matches the mint_pubkey argument.
    /// No account data is accessed, so this is safe.
    pub mint: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, has_one = admin)]
    pub lottery: Account<'info, Lottery>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct StartSecondPhase<'info> {
    #[account(mut, has_one = admin)]
    pub lottery: Account<'info, Lottery>,
    /// Pays the ORAO fee and the request account's rent, and is the `client`
    /// ORAO records, so the rent that comes back on fulfilment comes back here.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The request account ORAO will create.
    ///
    /// Its address is a PDA of the seed the handler derives, and the handler
    /// checks it against that derivation before the CPI. The check lives there
    /// rather than in a seeds constraint because the seed depends on a sysvar
    /// read, and a constraint that cannot fail cleanly is worse than an
    /// explicit one that can.
    ///
    /// CHECK: address is checked against the derived PDA in the handler.
    #[account(mut)]
    pub vrf_request: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [CONFIG_ACCOUNT_SEED],
        bump,
        seeds::program = ORAO_VRF_PROGRAM_ID,
    )]
    pub vrf_network_state: Account<'info, NetworkState>,

    /// CHECK: ORAO checks it against its own configuration inside the CPI.
    #[account(mut)]
    pub vrf_treasury: AccountInfo<'info>,

    #[account(address = ORAO_VRF_PROGRAM_ID)]
    pub vrf_program: Program<'info, OraoVrf>,

    /// CHECK: the address is checked against the sysvar id when it is read.
    #[account(address = slot_hashes::ID)]
    pub recent_slothashes: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillRandomness<'info> {
    #[account(mut)]
    pub lottery: Account<'info, Lottery>,

    /// CHECK: owner and seed are checked in the handler against the round.
    #[account(address = lottery.vrf_request)]
    pub vrf_request: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct EmergencyFulfillRandomness<'info> {
    #[account(mut, has_one = admin)]
    pub lottery: Account<'info, Lottery>,
    pub admin: Signer<'info>,

    /// The request must be produced for inspection: the handler refuses once
    /// ORAO has answered, and it cannot tell without reading it.
    ///
    /// CHECK: owner and seed are checked in the handler against the round.
    #[account(address = lottery.vrf_request)]
    pub vrf_request: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct StartPurchasesPhase<'info> {
    #[account(mut, has_one = admin)]
    pub lottery: Account<'info, Lottery>,

    #[account(
        mut,
        seeds = [b"vault", lottery.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut, address = lottery.wallet_fee)]
    pub wallet_fee: SystemAccount<'info>,

    #[account(mut, address = lottery.wallet_keeper)]
    pub wallet_keeper: SystemAccount<'info>,

    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseLottery<'info> {
    #[account(
        mut,
        has_one = admin,
        close = admin
    )]
    pub lottery: Account<'info, Lottery>,

    #[account(
        mut,
        seeds = [b"vault", lottery.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}



// ========= EVENTS =========

#[event]
pub struct LotteryInitialized {
    pub lottery: Pubkey,
    pub admin: Pubkey,
    pub start_ts: i64,
    pub end_ts: i64,
    pub min_amount: u64,
    pub max_amount: u64,
    pub max_total: u64,
    pub vrf_algorithm_hash: [u8; 32],
}

#[event]
pub struct Deposit {
    pub lottery: Pubkey,
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct PhaseChanged {
    pub lottery: Pubkey,
    pub status: LotteryStatus,
}

#[event]
pub struct LimitsUpdated {
    pub lottery: Pubkey,
    pub min_amount: u64,
    pub max_amount: u64,
}

#[event]
pub struct Phase2Started {
    pub lottery: Pubkey,
    pub weights_hash: [u8; 32],
    /// The ORAO request account, a PDA of `force`.
    pub randomness_account: Pubkey,
    /// The derived request seed. Published so the derivation can be rechecked
    /// without reading the round account.
    pub force: [u8; 32],
    /// The slot whose hash seeded `force`.
    pub seed_slot: u64,
    pub requested_ts: i64,
    pub requested_slot: u64,
}

#[event]
pub struct EmergencySeedUsed {
    pub lottery: Pubkey,
    pub seed: [u8; 32],
    /// When the round asked ORAO, so the silence before this is measurable.
    pub requested_ts: i64,
    pub ts: i64,
}

#[event]
pub struct VrfFulfilled {
    pub lottery: Pubkey,
    pub seed: [u8; 32],
}

#[event]
pub struct PurchasesPhaseStarted {
    pub lottery: Pubkey,
    pub fee_amount: u64,
    pub meme_amount: u64,
}

#[event]
pub struct PauseStatusChanged {
    pub lottery: Pubkey,
    pub paused: bool,
}

// ========= ERRORS =========

#[error_code]
pub enum LotteryError {
    #[msg("Invalid time range")]
    InvalidTimeRange,
    #[msg("Fee wallet and keeper wallet must be different")]
    WalletsMustBeDifferent,
    #[msg("Fee is too high")]
    FeeTooHigh,
    #[msg("Invalid min/max amount bounds")]
    InvalidAmountBounds,
    #[msg("Invalid total limit")]
    InvalidTotalLimit,
    #[msg("Lottery is paused")]
    Paused,
    #[msg("Lottery is not open")]
    NotOpen,
    #[msg("Lottery not started yet")]
    NotStarted,
    #[msg("Lottery ended")]
    Ended,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Total limit exceeded")]
    TotalLimitExceeded,
    #[msg("Overflow")]
    Overflow,
    #[msg("Mint key mismatch")]
    MintKeyMismatch,

    #[msg("Wrong phase for this action")]
    WrongPhase,
    #[msg("Weights hash already set for this lottery")]
    WeightsHashAlreadySet,
    #[msg("Invalid weights hash (zero value)")]
    InvalidWeightsHash,
    #[msg("Entry period has not ended yet")]
    NotEndedYet,
    #[msg("VRF is not ready yet")]
    VrfNotReady,
    #[msg("VRF already called")]
    VrfAlreadyCalled,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
    #[msg("Invalid VRF seed (zero)")]
    InvalidVrfSeed,
    #[msg("Lottery duration is too long")]
    DurationTooLong,
    #[msg("Lottery is already paused")]
    AlreadyPaused,
    #[msg("Lottery is not paused")]
    NotPaused,
    #[msg("Lottery is not in purchases phase")]
    NotInPurchasesPhase,
    #[msg("Vault must be owned by the System Program")]
    InvalidVaultOwner,
    #[msg("Vault must have zero data")]
    InvalidVaultData,
    #[msg("Randomness account does not match lottery state")]
    RandomnessAccountMismatch,
    #[msg("Failed to parse randomness account")]
    InvalidRandomnessAccountData,
    #[msg("Randomness is not resolved")]
    RandomnessNotResolved,
    #[msg("Randomness account owner is invalid")]
    InvalidRandomnessAccountOwner,
    #[msg("Randomness data does not match the bound request metadata")]
    RandomnessRequestMismatch,
    #[msg("Randomness has already been produced for this round")]
    RandomnessAlreadyResolved,
    #[msg("Recent slot hashes sysvar is missing or malformed")]
    InvalidSlotHashesSysvar,
    #[msg("Seed slot is not present in the slot hashes sysvar")]
    SeedSlotNotFound,
    #[msg("Seed slot is too far in the past")]
    SeedSlotTooOld,
    #[msg("Invalid VRF algorithm hash (zero value)")]
    InvalidVrfAlgorithmHash,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    /// The same round always asks for the same seed. If this ever stopped
    /// holding, a round could be pointed at a second request account.
    #[test]
    fn force_is_deterministic() {
        let a = derive_vrf_force(&pk(1), &[2u8; 32], &[3u8; 32]);
        let b = derive_vrf_force(&pk(1), &[2u8; 32], &[3u8; 32]);
        assert_eq!(a, b);
    }

    /// Every input has to matter. A field that does not change the seed is a
    /// field somebody can vary for free.
    #[test]
    fn every_input_changes_the_force() {
        let base = derive_vrf_force(&pk(1), &[2u8; 32], &[3u8; 32]);
        assert_ne!(base, derive_vrf_force(&pk(9), &[2u8; 32], &[3u8; 32]));
        assert_ne!(base, derive_vrf_force(&pk(1), &[9u8; 32], &[3u8; 32]));
        assert_ne!(base, derive_vrf_force(&pk(1), &[2u8; 32], &[9u8; 32]));
    }

    /// The domain tag is not decoration: without it the seed would be a plain
    /// hash of three public values that another program could land on too.
    #[test]
    fn force_is_domain_separated() {
        let lottery = pk(1);
        let weights = [2u8; 32];
        let slot_hash = [3u8; 32];
        let undomained = hashv(&[lottery.as_ref(), &weights, &slot_hash]).to_bytes();
        assert_ne!(derive_vrf_force(&lottery, &weights, &slot_hash), undomained);
    }

    /// ORAO hands back 64 bytes, the round stores 32. Folding has to keep all
    /// of them in play, so a change to any byte has to move the result.
    #[test]
    fn folding_uses_every_byte_of_the_randomness() {
        let randomness = [7u8; 64];
        let base = hashv(&[VRF_SEED_DOMAIN, &randomness]).to_bytes();
        for index in 0..64 {
            let mut altered = randomness;
            altered[index] ^= 0x01;
            assert_ne!(
                base,
                hashv(&[VRF_SEED_DOMAIN, &altered]).to_bytes(),
                "byte {index} had no effect on the seed"
            );
        }
    }

    /// The two domains must never collide, or a randomness value could be
    /// mistaken for a request seed.
    #[test]
    fn the_two_domains_differ() {
        assert_ne!(VRF_FORCE_DOMAIN, VRF_SEED_DOMAIN);
    }

    /// The account has to be big enough for what the struct now holds. Anchor
    /// would otherwise truncate silently at `init`.
    #[test]
    fn space_matches_the_struct() {
        // 8 discriminator + borsh body, all fixed-size fields.
        let body = 32 + 8 + 8 + 2 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 8 + 16
            + 32 + 8 + 32 + 1 + 32 + 32 + 8 + 32;
        assert_eq!(Lottery::SPACE, 8 + body);
    }
}

#[cfg(test)]
mod cross_language_tests {
    use super::*;
    use std::str::FromStr;

    fn hex(bytes: [u8; 32]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The worker has to derive the same seed as the program, or it will offer
    /// a request account the program refuses. The two implementations live in
    /// different languages and different repositories, so they are pinned to
    /// the same vectors instead of to each other.
    ///
    /// The twin of this test is `workers/tests/test_orao_vrf.py`. If one of
    /// them is ever edited alone, the pair stops agreeing and both should fail.
    #[test]
    fn force_matches_the_worker() {
        let lottery = Pubkey::from_str("4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH").unwrap();
        let force = derive_vrf_force(&lottery, &[2u8; 32], &[3u8; 32]);
        assert_eq!(
            hex(force),
            "1b62c4004550937dd435457f0d0a0a9771996ccaf083f452aa0c58a5832e5c52"
        );
    }

    /// The worker holds the same number so it does not send a transaction the
    /// program is going to refuse. Two minutes, measured rather than guessed.
    #[test]
    fn the_emergency_delay_matches_the_worker() {
        assert_eq!(EMERGENCY_FULFILL_DELAY_SECONDS, 120);
    }

    #[test]
    fn folding_matches_the_worker() {
        let seed = hashv(&[VRF_SEED_DOMAIN, &[7u8; 64]]).to_bytes();
        assert_eq!(
            hex(seed),
            "58d6e85496a4c2bd8ea9ae6bf61658708c533c5491633ecf9fcf8725fd921601"
        );
    }
}
