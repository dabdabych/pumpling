use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
};
use switchboard_on_demand::on_demand::accounts::randomness::RandomnessAccountData;

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

/// Phase 2 (waiting before VRF) = 5 mins by default
pub const PHASE2_DEFAULT_WAIT_SECONDS: i64 = 5 * 60; // 300

/// Maximum allowed lottery duration (7 days)
pub const MAX_LOTTERY_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60;


#[cfg(feature = "devnet")]
pub const SWITCHBOARD_ON_DEMAND_PROGRAM_ID: Pubkey = pubkey!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
#[cfg(feature = "mainnet")]
pub const SWITCHBOARD_ON_DEMAND_PROGRAM_ID: Pubkey =  pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

#[cfg(feature = "devnet")]
pub const MAX_RANDOMNESS_AGE_SLOTS: u64 = 64;
#[cfg(feature = "mainnet")]
pub const MAX_RANDOMNESS_AGE_SLOTS: u64 = 256;
pub const MAX_VRF_RETRIES: u8 = 2;

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
        l.vrf_ready_ts = 0;
        l.vrf_seed = [0u8; 32];
        l.vrf_called = false;
        l.vrf_randomness_account = Pubkey::default();
        l.vrf_phase2_slot = 0;
        l.vrf_retry_count = 0;
        l.vrf_request_seed_slot = 0;
        l.vrf_request_seed_slothash = [0u8; 32];
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
        wait_seconds: Option<i64>,
    ) -> Result<()> {
        let l = &mut ctx.accounts.lottery;
        let now = Clock::get()?.unix_timestamp;

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
        let randomness_account = ctx.accounts.randomness_account_data.key();
        require!(
            randomness_account != Pubkey::default(),
            LotteryError::InvalidRandomnessAccount
        );
        require_keys_eq!(
            *ctx.accounts.randomness_account_data.owner,
            SWITCHBOARD_ON_DEMAND_PROGRAM_ID,
            LotteryError::InvalidRandomnessAccountOwner
        );

        let randomness_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_account_data.data.borrow(),
        )
        .map_err(|_| LotteryError::InvalidRandomnessAccountData)?;
        require!(
            randomness_data.reveal_slot == 0,
            LotteryError::RandomnessAccountAlreadyResolved
        );

        let wait = wait_seconds.unwrap_or(PHASE2_DEFAULT_WAIT_SECONDS);
        require!(wait > 0, LotteryError::InvalidPhase2Wait);

        let vrf_ready_ts = now.checked_add(wait).ok_or(LotteryError::Overflow)?;

        l.weights_hash = weights_hash;
        l.vrf_ready_ts = vrf_ready_ts;
        l.vrf_randomness_account = randomness_account;
        l.vrf_phase2_slot = Clock::get()?.slot;
        l.vrf_retry_count = 0;
        l.vrf_request_seed_slot = 0;
        l.vrf_request_seed_slothash = [0u8; 32];
        l.status = LotteryStatus::PendingVrf;

        emit!(Phase2Started {
            lottery: l.key(),
            weights_hash,
            randomness_account,
            vrf_ready_ts,
            phase2_slot: l.vrf_phase2_slot,
            retry_count: l.vrf_retry_count,
        });

        emit!(PhaseChanged {
            lottery: l.key(),
            status: l.status,
        });

        Ok(())
    }

    pub fn bind_vrf_request(ctx: Context<StartSecondPhase>) -> Result<()> {
        let l = &mut ctx.accounts.lottery;
        let clock = Clock::get()?;

        require!(l.status == LotteryStatus::PendingVrf, LotteryError::WrongPhase);
        require!(!l.vrf_called, LotteryError::VrfAlreadyCalled);
        require_keys_eq!(
            ctx.accounts.randomness_account_data.key(),
            l.vrf_randomness_account,
            LotteryError::RandomnessAccountMismatch
        );
        require_keys_eq!(
            *ctx.accounts.randomness_account_data.owner,
            SWITCHBOARD_ON_DEMAND_PROGRAM_ID,
            LotteryError::InvalidRandomnessAccountOwner
        );
        require!(
            l.vrf_request_seed_slot == 0,
            LotteryError::VrfRequestAlreadyBound
        );

        let randomness_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_account_data.data.borrow(),
        )
        .map_err(|_| LotteryError::InvalidRandomnessAccountData)?;

        require!(
            randomness_data.seed_slot > l.vrf_phase2_slot,
            LotteryError::RandomnessTooOld
        );
        require!(
            randomness_data.seed_slot <= clock.slot,
            LotteryError::RandomnessNotResolved
        );
        require!(
            randomness_data.reveal_slot == 0,
            LotteryError::RandomnessAccountAlreadyResolved
        );

        l.vrf_request_seed_slot = randomness_data.seed_slot;
        l.vrf_request_seed_slothash = randomness_data.seed_slothash;

        emit!(VrfBinded {
            lottery: l.key(),
            randomness_account: l.vrf_randomness_account,
            seed_slot: l.vrf_request_seed_slot,
            seed_slothash: l.vrf_request_seed_slothash,
        });

        Ok(())
    }

    // -----------------------
    // PHASE 3: VRF SEED
    // -----------------------
    pub fn fulfill_randomness(ctx: Context<FulfillRandomness>) -> Result<()> {
        let l = &mut ctx.accounts.lottery;
        let clock = Clock::get()?;

        require!(l.status == LotteryStatus::PendingVrf, LotteryError::WrongPhase);
        require!(clock.unix_timestamp >= l.vrf_ready_ts, LotteryError::VrfNotReady);
        require!(!l.vrf_called, LotteryError::VrfAlreadyCalled);
        require_keys_eq!(
            ctx.accounts.randomness_account_data.key(),
            l.vrf_randomness_account,
            LotteryError::RandomnessAccountMismatch
        );

        require_keys_eq!(
            *ctx.accounts.randomness_account_data.owner,
            SWITCHBOARD_ON_DEMAND_PROGRAM_ID,
            LotteryError::InvalidRandomnessAccountOwner
        );

        let randomness_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_account_data.data.borrow(),
        )
        .map_err(|_| LotteryError::InvalidRandomnessAccountData)?;

        require!(
            l.vrf_request_seed_slot > 0,
            LotteryError::VrfRequestNotBound
        );
        require!(
            randomness_data.seed_slot == l.vrf_request_seed_slot,
            LotteryError::RandomnessRequestMismatch
        );
        require!(
            randomness_data.seed_slothash == l.vrf_request_seed_slothash,
            LotteryError::RandomnessRequestMismatch
        );
        require!(
            randomness_data.reveal_slot <= clock.slot,
            LotteryError::RandomnessNotResolved
        );
        require!(
            randomness_data.reveal_slot >= randomness_data.seed_slot,
            LotteryError::RandomnessNotResolved
        );
        require!(
            clock.slot.saturating_sub(randomness_data.reveal_slot) <= MAX_RANDOMNESS_AGE_SLOTS,
            LotteryError::RandomnessTooStale
        );

        let seed = randomness_data.value;

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

    pub fn retry_randomness(
        ctx: Context<StartSecondPhase>,
        wait_seconds: Option<i64>,
    ) -> Result<()> {
        let l = &mut ctx.accounts.lottery;
        let clock = Clock::get()?;

        require!(l.status == LotteryStatus::PendingVrf, LotteryError::WrongPhase);
        require!(!l.vrf_called, LotteryError::VrfAlreadyCalled);
        require!(l.vrf_retry_count < MAX_VRF_RETRIES, LotteryError::VrfRetryLimitReached);
        require!(clock.unix_timestamp >= l.vrf_ready_ts, LotteryError::VrfRetryTooEarly);

        let new_randomness_account = ctx.accounts.randomness_account_data.key();
        require!(
            new_randomness_account != l.vrf_randomness_account,
            LotteryError::SameRandomnessAccount
        );
        require_keys_eq!(
            *ctx.accounts.randomness_account_data.owner,
            SWITCHBOARD_ON_DEMAND_PROGRAM_ID,
            LotteryError::InvalidRandomnessAccountOwner
        );

        let randomness_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_account_data.data.borrow(),
        )
        .map_err(|_| LotteryError::InvalidRandomnessAccountData)?;
        require!(
            randomness_data.reveal_slot == 0,
            LotteryError::RandomnessAccountAlreadyResolved
        );

        l.vrf_randomness_account = new_randomness_account;
        l.vrf_phase2_slot = clock.slot;
        l.vrf_retry_count = l.vrf_retry_count.checked_add(1).ok_or(LotteryError::Overflow)?;
        l.vrf_request_seed_slot = 0;
        l.vrf_request_seed_slothash = [0u8; 32];

        emit!(VrfRetryScheduled {
            lottery: l.key(),
            randomness_account: new_randomness_account,
            phase2_slot: l.vrf_phase2_slot,
            retry_count: l.vrf_retry_count,
        });

        Ok(())
    }

    pub fn emergency_fulfill_randomness(
        ctx: Context<AdminOnly>,
        seed: [u8; 32],
    ) -> Result<()> {
        let l = &mut ctx.accounts.lottery;
        let clock = Clock::get()?;

        require!(l.status == LotteryStatus::PendingVrf, LotteryError::WrongPhase);
        require!(!l.vrf_called, LotteryError::VrfAlreadyCalled);
        require!(
            l.vrf_retry_count >= MAX_VRF_RETRIES,
            LotteryError::VrfRetriesNotExhausted
        );
        require!(seed != [0u8; 32], LotteryError::InvalidVrfSeed);

        l.vrf_seed = seed;
        l.vrf_called = true;
        l.status = LotteryStatus::ReadyToDraw;

        emit!(EmergencySeedUsed {
            lottery: l.key(),
            seed,
            retry_count: l.vrf_retry_count,
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
    pub vrf_ready_ts: i64,
    pub vrf_seed: [u8; 32],
    pub vrf_called: bool,
    pub vrf_randomness_account: Pubkey,
    pub vrf_phase2_slot: u64,
    pub vrf_retry_count: u8,
    pub vrf_request_seed_slot: u64,
    pub vrf_request_seed_slothash: [u8; 32],

    /// sha256 of the canonical VRF used for this lottery. Set once in
    /// initialize, immutable thereafter. Verified off-chain by users.
    pub vrf_algorithm_hash: [u8; 32],
}

impl Lottery {
    pub const SPACE: usize =
        8 +
        32 +
        8 + 8 +
        2 +
        32 +
        32 +
        8 + 8 +
        8 +
        1 +
        1 +
        8 +
        16 +
        32 +
        8 +
        32 +
        1 +
        32 +
        8 +
        1 +
        8 +
        32 +
        32;
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
    pub admin: Signer<'info>,

    /// CHECK: Switchboard randomness account; parsed and validated in the handler.
    pub randomness_account_data: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct FulfillRandomness<'info> {
    #[account(mut)]
    pub lottery: Account<'info, Lottery>,

    /// CHECK: Switchboard randomness account; parsed and validated in the handler.
    pub randomness_account_data: AccountInfo<'info>,
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
    pub randomness_account: Pubkey,
    pub vrf_ready_ts: i64,
    pub phase2_slot: u64,
    pub retry_count: u8,
}

#[event]
pub struct VrfRetryScheduled {
    pub lottery: Pubkey,
    pub randomness_account: Pubkey,
    pub phase2_slot: u64,
    pub retry_count: u8,
}

#[event]
pub struct EmergencySeedUsed {
    pub lottery: Pubkey,
    pub seed: [u8; 32],
    pub retry_count: u8,
    pub ts: i64,
}

#[event]
pub struct VrfFulfilled {
    pub lottery: Pubkey,
    pub seed: [u8; 32],
}

#[event]
pub struct VrfBinded {
    pub lottery: Pubkey,
    pub randomness_account: Pubkey,
    pub seed_slot: u64,
    pub seed_slothash: [u8; 32],
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
    #[msg("Invalid wait duration for second phase")]
    InvalidPhase2Wait,
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
    #[msg("Invalid randomness account")]
    InvalidRandomnessAccount,
    #[msg("Randomness account does not match lottery state")]
    RandomnessAccountMismatch,
    #[msg("Failed to parse randomness account")]
    InvalidRandomnessAccountData,
    #[msg("Randomness is not resolved")]
    RandomnessNotResolved,
    #[msg("Randomness account owner is invalid")]
    InvalidRandomnessAccountOwner,
    #[msg("Randomness account already has a revealed value")]
    RandomnessAccountAlreadyResolved,
    #[msg("Randomness account uses data from before phase 2")]
    RandomnessTooOld,
    #[msg("Randomness result is older than the allowed freshness window")]
    RandomnessTooStale,
    #[msg("VRF retry limit reached")]
    VrfRetryLimitReached,
    #[msg("VRF retry can only be called after vrf_ready_ts")]
    VrfRetryTooEarly,
    #[msg("Retry must use a new randomness account")]
    SameRandomnessAccount,
    #[msg("Emergency seed is allowed only after max VRF retries")]
    VrfRetriesNotExhausted,
    #[msg("VRF request metadata is not bound yet")]
    VrfRequestNotBound,
    #[msg("VRF request metadata is already bound")]
    VrfRequestAlreadyBound,
    #[msg("Randomness data does not match the bound request metadata")]
    RandomnessRequestMismatch,
    #[msg("Invalid VRF algorithm hash (zero value)")]
    InvalidVrfAlgorithmHash,
}
