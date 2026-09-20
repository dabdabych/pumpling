import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { getLotteryByIdLotteryLotteryIdGet } from '../../api-client/fn/lottery/get-lottery-by-id-lottery-lottery-id-get';
import { phase2AccountsLotteryLotteryIdPhase2AccountsGet } from '../../api-client/fn/lottery/phase-2-accounts-lottery-lottery-id-phase-2-accounts-get';
import { markPhase2StartedLotteryLotteryIdPhase2StartedPost } from '../../api-client/fn/lottery/mark-phase-2-started-lottery-lottery-id-phase-2-started-post';
import { markVrfFulfilledLotteryLotteryIdVrfFulfilledPost } from '../../api-client/fn/lottery/mark-vrf-fulfilled-lottery-lottery-id-vrf-fulfilled-post';
import { markOffchainVrfLotteryLotteryIdOffchainVrfPost } from '../../api-client/fn/lottery/mark-offchain-vrf-lottery-lottery-id-offchain-vrf-post';
import { markProceedingPurchasesLotteryLotteryIdProceedingPurchasesPost } from '../../api-client/fn/lottery/mark-proceeding-purchases-lottery-lottery-id-proceeding-purchases-post';
import { runPurchasesPayloadPreviewLotteryLotteryIdRunPurchasesPayloadGet } from '../../api-client/fn/lottery/run-purchases-payload-preview-lottery-lottery-id-run-purchases-payload-get';
import { runPurchasesLotteryLotteryIdRunPurchasesPost } from '../../api-client/fn/lottery/run-purchases-lottery-lottery-id-run-purchases-post';
import { LotteryResponse } from '../../api-client/models/lottery-response';
import { RunPurchasesPayload } from '../../api-client/models/run-purchases-payload';
import { RunPurchasesResponse } from '../../api-client/models/run-purchases-response';
import { Api } from '../../api-client/api';
import { getLotteryBetsLotteryLotteryIdBetsGet } from '../../api-client/fn/lottery/get-lottery-bets-lottery-lottery-id-bets-get';
import { BetParticipationResponse } from '../../api-client/models/bet-participation-response';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import { Buffer } from 'buffer';
import lotteryIdl from '../../idl/lottery_v_1_0.json';
import { isWalletFlowInterruption, WalletService } from '../../shared/wallet.service';
import { finalize } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import { SystemDialog } from '../../shared/system-dialog';
import { DEVNET_ADMIN_WALLETS, isAllowedAdminWallet } from '../../shared/admin-wallets';
import { environment } from '../../../environments/environment';

@Component({
    selector: 'app-lottery-details',
    templateUrl: './lottery-details.component.html',
    styleUrls: ['./lottery-details.component.scss'],
    standalone: false
})
export class LotteryDetailsComponent implements OnInit, OnDestroy {
  private readonly fulfillVrfMinDelaySeconds = 60;
  private cooldownTickerId: number | null = null;
  lottery: LotteryResponse | null = null;
  isLoading = true;
  selectedPhaseIndex = 0;
  currentPhaseLabel = 'Open';
  bets: BetParticipationResponse[] = [];
  isLoadingBets = false;
  betsError: string | null = null;
  selectedWalletAddress: string | null = null;
  walletOptions: string[] = [];
  isStartingPhaseTwo = false;
  phaseTwoError: string | null = null;
  phaseTwoSuccess: string | null = null;
  isBindingVrfRequest = false;
  bindVrfError: string | null = null;
  bindVrfSuccess: string | null = null;
  isFulfillingVrf = false;
  vrfError: string | null = null;
  vrfSuccess: string | null = null;
  isRetryingRandomness = false;
  retryRandomnessError: string | null = null;
  retryRandomnessSuccess: string | null = null;
  isStartingDraw = false;
  drawError: string | null = null;
  drawSuccess: string | null = null;
  isVrfPreviewing = false;
  isRunningPurchases = false;
  purchasesError: string | null = null;
  purchasesSuccess: string | null = null;
  lotteryProgramId = new PublicKey('4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH');
  adminPubkey = new PublicKey(DEVNET_ADMIN_WALLETS[0]);

  phaseSteps = [
    {
      id: 'open',
      label: 'Open (Deposits)',
      description: 'Accepting bets and deposits from users.'
    },
    {
      id: 'pendingVrf',
      label: 'Pending VRF',
      description: 'Waiting for VRF to be ready.'
    },
    {
      id: 'readyToDraw',
      label: 'Ready to Draw',
      description: 'VRF ready. Admin can trigger draw.'
    },
    {
      id: 'proceedingPurchases',
      label: 'Proceeding Purchases',
      description: 'Purchases/settlements in progress.'
    },
    {
      id: 'closed',
      label: 'Closed',
      description: 'Lottery is closed.'
    }
  ];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: Api,
    private walletService: WalletService,
    private systemDialog: SystemDialog,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.loadLottery(parseInt(id, 10));
    } else {
      this.isLoading = false;
    }

    this.cooldownTickerId = window.setInterval(() => {
      this.ngZone.run(() => {
        this.cdr.detectChanges();
      });
    }, 1000);
  }

  ngOnDestroy(): void {
    if (this.cooldownTickerId !== null) {
      window.clearInterval(this.cooldownTickerId);
      this.cooldownTickerId = null;
    }
  }

  loadLottery(id: number): void {
    this.setLoading(true);
    this.api.invoke(getLotteryByIdLotteryLotteryIdGet, { lottery_id: id })
      .pipe(finalize(() => {
        this.setLoading(false);
      }))
      .subscribe({
        next: (lottery) => {
          this.lottery = lottery;
          this.selectedPhaseIndex = this.getPhaseIndexFromStatus(lottery.status);
          this.currentPhaseLabel = this.phaseSteps[this.selectedPhaseIndex]?.label ?? 'Open';
          this.loadBets(lottery.id);
        },
        error: () => {
          this.lottery = null;
        }
      });
  }

  goBack(): void {
    this.router.navigate(['/admin/lotteries']);
  }

  loadBets(lotteryId: number): void {
    this.setBetsLoading(true);
    this.betsError = null;
    this.api.invoke$Response(getLotteryBetsLotteryLotteryIdBetsGet, { lottery_id: lotteryId })
      .pipe(finalize(() => {
        this.setBetsLoading(false);
      }))
      .subscribe({
        next: (response) => {
          this.bets = response.body || [];
          this.walletOptions = Array.from(new Set(this.bets.map(bet => bet.wallet_address)));
          if (!this.selectedWalletAddress && this.walletOptions.length > 0) {
            this.selectedWalletAddress = this.walletOptions[0];
          }
        },
        error: () => {
          this.betsError = 'Failed to load bets';
        }
      });
  }

  private setLoading(value: boolean): void {
    this.ngZone.run(() => {
      this.isLoading = value;
      this.cdr.detectChanges();
    });
  }

  private setBetsLoading(value: boolean): void {
    this.ngZone.run(() => {
      this.isLoadingBets = value;
      this.cdr.detectChanges();
    });
  }

  async onStartPhaseTwo(): Promise<void> {
    this.ngZone.run(() => {
      this.phaseTwoError = null;
      this.phaseTwoSuccess = null;
    });

    if (this.isPhaseTwoStarted()) {
      this.phaseTwoError = 'Phase II has already been started.';
      return;
    }

    if (!this.lottery) {
      this.phaseTwoError = 'Lottery data is not loaded.';
      return;
    }

    const phaseTwoCooldownSeconds = this.getStartPhaseTwoCooldownRemainingSeconds();
    if (phaseTwoCooldownSeconds > 0) {
      this.phaseTwoError = `Deposit period is still active until End Date. Start Phase II will be available in ${phaseTwoCooldownSeconds} seconds.`;
      return;
    }

    let walletAddress: string;
    try {
      walletAddress = await this.walletService.connect();
    } catch (error: any) {
      if (isWalletFlowInterruption(error)) {
        return;
      }
      this.phaseTwoError = error?.message || 'Please install Phantom or Solflare wallet extension.';
      return;
    }

    if (!isAllowedAdminWallet(walletAddress)) {
      this.phaseTwoError = 'Only the admin wallet can start Phase II.';
      return;
    }
    const activeAdminPubkey = new PublicKey(walletAddress);

    const weightsHash = await this.buildWeightsHash();
    if (!weightsHash) {
      this.phaseTwoError = 'Failed to build weights hash.';
      return;
    }

    const waitSeconds = Math.floor(Math.random() * 101) + 4;
    const program = this.getLotteryProgram();
    if (!program) {
      this.phaseTwoError = 'Failed to initialize lottery program.';
      return;
    }

    const pdas = this.deriveLotteryPdas(this.lottery.id, activeAdminPubkey);
    if (!pdas) {
      this.phaseTwoError = 'Failed to derive lottery accounts.';
      return;
    }

    this.setPhaseTwoLoading(true);

    try {
      // The server works out the request seed and hands back the accounts. It
      // is deliberately not derived here: the program has that formula and so
      // does the worker, and a third copy in the browser would be a third
      // chance for the three to disagree.
      const prepared = await firstValueFrom(
        this.api.invoke(phase2AccountsLotteryLotteryIdPhase2AccountsGet, { lottery_id: this.lottery.id })
      );
      if (!prepared?.vrf_request) {
        throw new Error('Backend did not return the randomness request account.');
      }

      const tx = await program.methods
        .startSecondPhase(Array.from(Buffer.from(prepared.weights_hash, 'hex')), new BN(prepared.seed_slot))
        .accounts({
          lottery: pdas.lottery,
          admin: activeAdminPubkey,
          vrfRequest: new PublicKey(prepared.vrf_request),
          vrfNetworkState: new PublicKey(prepared.vrf_network_state),
          vrfTreasury: new PublicKey(prepared.vrf_treasury),
          vrfProgram: new PublicKey(prepared.vrf_program),
          recentSlothashes: new PublicKey(prepared.recent_slothashes),
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.ngZone.run(() => {
        if (this.lottery) {
          // Optimistic UI update: disable Start Phase II button immediately.
          this.lottery.status = 'phase2started' as any;
          this.selectedPhaseIndex = this.getPhaseIndexFromStatus(this.lottery.status);
          this.currentPhaseLabel = this.phaseSteps[this.selectedPhaseIndex]?.label ?? 'Open';
        }
        this.phaseTwoSuccess = `Phase II started. Tx: ${tx}`;
        this.cdr.detectChanges();
      });

      try {
        const updated = await firstValueFrom(this.api.invoke(markPhase2StartedLotteryLotteryIdPhase2StartedPost, { lottery_id: this.lottery.id }));
        this.ngZone.run(() => {
          if (this.lottery && updated) {
            this.lottery = updated;
            this.selectedPhaseIndex = this.getPhaseIndexFromStatus(updated.status);
            this.currentPhaseLabel = this.phaseSteps[this.selectedPhaseIndex]?.label ?? 'Open';
          }
          this.cdr.detectChanges();
        });
      } catch {
        this.ngZone.run(() => {
          this.phaseTwoError = 'Phase II started on-chain, but failed to update backend status.';
          this.cdr.detectChanges();
        });
      }
    } catch (error: any) {
      console.error('Start Phase II error:', error);
      this.ngZone.run(() => {
        this.phaseTwoError = error.message || 'Failed to start Phase II.';
      });
    } finally {
      this.setPhaseTwoLoading(false);
    }
  }

  async onFulfillVrf(): Promise<void> {
    if (this.isFulfillingVrf) {
      return;
    }

    this.ngZone.run(() => {
      this.vrfError = null;
      this.vrfSuccess = null;
    });

    if (this.lottery?.is_offchain_vrf) {
      this.vrfError = 'On-chain fulfill is disabled for offchain randomness mode.';
      return;
    }

    if (!this.isPhaseTwoStarted()) {
      this.vrfError = 'Phase II has not started yet.';
      return;
    }

    if (!this.lottery) {
      this.vrfError = 'Lottery data is not loaded.';
      return;
    }

    if (!this.lottery.randomness_account) {
      this.vrfError = 'randomness_account is missing on this lottery.';
      return;
    }

    const fulfillCooldownSeconds = this.getFulfillCooldownRemainingSeconds();
    if (fulfillCooldownSeconds > 0) {
      this.vrfError = `Fulfill randomness is not available yet. Try again in ${fulfillCooldownSeconds} seconds.`;
      return;
    }

    this.setVrfLoading(true);

    try {
      let walletAddress: string;
      try {
        walletAddress = await this.walletService.connect();
      } catch (error: any) {
        if (isWalletFlowInterruption(error)) {
          return;
        }
        this.vrfError = error?.message || 'Please install Phantom or Solflare wallet extension.';
        return;
      }

      if (!isAllowedAdminWallet(walletAddress)) {
        this.vrfError = 'Only the admin wallet can fulfill VRF.';
        return;
      }
      const activeAdminPubkey = new PublicKey(walletAddress);

      const program = this.getLotteryProgram();
      if (!program) {
        this.vrfError = 'Failed to initialize lottery program.';
        return;
      }

      const pdas = this.deriveLotteryPdas(this.lottery.id, activeAdminPubkey);
      if (!pdas) {
        this.vrfError = 'Failed to derive lottery accounts.';
        return;
      }

      // Nothing to reveal any more: ORAO writes the value into the request
      // account by itself, and this instruction only takes it. It needs no
      // admin signature either, so anyone could push the round along.
      const tx = await program.methods
        .fulfillRandomness()
        .accounts({
          lottery: pdas.lottery,
          vrfRequest: new PublicKey(this.lottery.randomness_account),
        })
        .rpc();

      try {
        const updated = await firstValueFrom(this.api.invoke(markVrfFulfilledLotteryLotteryIdVrfFulfilledPost, { lottery_id: this.lottery.id }));
        this.ngZone.run(() => {
          if (this.lottery) {
            this.lottery = updated || this.lottery;
            this.selectedPhaseIndex = this.getPhaseIndexFromStatus(this.lottery.status || '');
            this.currentPhaseLabel = this.phaseSteps[this.selectedPhaseIndex]?.label ?? 'Open';
          }
          this.vrfSuccess = `Randomness taken from ORAO. Tx: ${tx}`;
          this.cdr.detectChanges();
        });
      } catch {
        this.ngZone.run(() => {
          if (this.lottery) {
            this.lottery.status = 'vrf_fulfilled' as any;
            this.selectedPhaseIndex = this.getPhaseIndexFromStatus(this.lottery.status);
            this.currentPhaseLabel = this.phaseSteps[this.selectedPhaseIndex]?.label ?? 'Open';
          }
          this.vrfError = 'VRF fulfilled on-chain, but failed to update backend status.';
          this.vrfSuccess = `Randomness taken from ORAO. Tx: ${tx}`;
          this.cdr.detectChanges();
        });
      }
    } catch (error: any) {
      console.error('Fulfill VRF error:', error);
      this.ngZone.run(() => {
        this.vrfError = error.message || 'Failed to fulfill VRF.';
      });
    } finally {
      this.setVrfLoading(false);
    }
  }

  async onStartDraw(): Promise<void> {
    if (this.isStartingDraw) {
      return;
    }

    this.ngZone.run(() => {
      this.drawError = null;
      this.drawSuccess = null;
    });

    if (!this.canStartDraw()) {
      this.drawError = 'Lottery is not ready to draw.';
      return;
    }

    if (!this.lottery) {
      this.drawError = 'Lottery data is not loaded.';
      return;
    }

    this.setDrawLoading(true);

    try {
      let walletAddress: string;
      try {
        walletAddress = await this.walletService.connect();
      } catch (error: any) {
        if (isWalletFlowInterruption(error)) {
          return;
        }
        this.drawError = error?.message || 'Please install Phantom or Solflare wallet extension.';
        return;
      }

      if (!isAllowedAdminWallet(walletAddress)) {
        this.drawError = 'Only the admin wallet can start the draw.';
        return;
      }
      const activeAdminPubkey = new PublicKey(walletAddress);

      const program = this.getLotteryProgram();
      if (!program) {
        this.drawError = 'Failed to initialize lottery program.';
        return;
      }

      const pdas = this.deriveLotteryPdas(this.lottery.id, activeAdminPubkey);
      if (!pdas) {
        this.drawError = 'Failed to derive lottery accounts.';
        return;
      }

      const lotteryAccount = await (program.account as any).lottery.fetch(pdas.lottery) as any;
      const walletFee = lotteryAccount.walletFee ?? lotteryAccount.wallet_fee;
      const walletKeeper = lotteryAccount.walletKeeper ?? lotteryAccount.wallet_keeper;

      if (!walletFee || !walletKeeper) {
        this.drawError = 'Failed to load wallet addresses from on-chain lottery account.';
        return;
      }

      const tx = await program.methods
        .startPurchasesPhase()
        .accounts({
          lottery: pdas.lottery,
          vault: pdas.vault,
          walletFee,
          walletKeeper,
          admin: activeAdminPubkey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.ngZone.run(() => {
        if (this.lottery) {
          this.api.invoke(markProceedingPurchasesLotteryLotteryIdProceedingPurchasesPost, { lottery_id: this.lottery.id }).subscribe({
            next: (updated) => {
              this.lottery = updated;
              this.selectedPhaseIndex = this.getPhaseIndexFromStatus(updated.status);
              this.currentPhaseLabel = this.phaseSteps[this.selectedPhaseIndex]?.label ?? 'Open';
            },
            error: () => {
              this.drawError = 'Purchases phase started on-chain, but failed to update backend status.';
              this.lottery.status = 'proceeding_purchases' as any;
              this.selectedPhaseIndex = this.getPhaseIndexFromStatus(this.lottery.status);
              this.currentPhaseLabel = this.phaseSteps[this.selectedPhaseIndex]?.label ?? 'Open';
            }
          });
        }
        this.drawSuccess = `Purchases phase started. Tx: ${tx}`;
      });
    } catch (error: any) {
      console.error('Start draw error:', error);
      this.ngZone.run(() => {
        this.drawError = error.message || 'Failed to start draw.';
      });
    } finally {
      this.setDrawLoading(false);
    }
  }

  private setPhaseTwoLoading(value: boolean): void {
    this.ngZone.run(() => {
      this.isStartingPhaseTwo = value;
      this.cdr.detectChanges();
    });
  }

  private getLotteryProgram(): Program | null {
    try {
      const provider = this.walletService.getProvider();
      if (!provider) {
        return null;
      }

      const connection = new Connection(environment.solanaRpcUrl, 'confirmed');
      const anchorProvider = new AnchorProvider(connection, provider as any, {
        preflightCommitment: 'confirmed',
      });
      const idlWithAddress = { ...(lotteryIdl as any), address: this.lotteryProgramId.toBase58() };
      return new Program(idlWithAddress as any, anchorProvider);
    } catch (error) {
      console.error('Error creating lottery program instance:', error);
      return null;
    }
  }

  private deriveLotteryPdas(
    lotteryId: number,
    adminPubkey: PublicKey = this.adminPubkey,
  ): { lottery: PublicKey, vault: PublicKey } | null {
    try {
      if (!Number.isFinite(lotteryId)) {
        throw new Error('Invalid lotteryId for PDA derivation');
      }

      const encoder = new TextEncoder();
      const lotterySeed = new BN(lotteryId).toArrayLike(Buffer as any, 'le', 8);
      const adminSeed = adminPubkey.toBytes();

      const [lotteryPda] = PublicKey.findProgramAddressSync(
        [encoder.encode('lottery'), adminSeed, lotterySeed],
        this.lotteryProgramId
      );
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [encoder.encode('vault'), lotteryPda.toBytes()],
        this.lotteryProgramId
      );

      return { lottery: lotteryPda, vault: vaultPda };
    } catch (error) {
      console.error('Failed to derive lottery PDAs', error);
      return null;
    }
  }

  private async buildWeightsHash(): Promise<Uint8Array | null> {
    const bets = this.bets;
    if (!bets.length) {
      return null;
    }

    const totals = new Map<string, number>();
    for (const bet of bets) {
      const mint = bet.meme_coin_address;
      const amount = Number(bet.sol_amount);
      if (!Number.isFinite(amount)) {
        continue;
      }
      totals.set(mint, (totals.get(mint) || 0) + amount);
    }

    const roundedPairs = Array.from(totals.entries()).map(([mint, amount]) => {
      const rounded = Number(amount.toFixed(8));
      return { mint, amount: rounded };
    });

    roundedPairs.sort((a, b) => {
      if (b.amount !== a.amount) {
        return b.amount - a.amount;
      }
      return a.mint.localeCompare(b.mint);
    });

    const payload = roundedPairs.map(pair => [pair.mint, pair.amount]);
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    return new Uint8Array(hashBuffer);
  }

  private getPhaseIndexFromStatus(status: string): number {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'completed' || normalized === 'closed') {
      return this.phaseSteps.findIndex(step => step.id === 'closed');
    }
    if (normalized === 'created' || normalized === 'id_generated') {
      return this.phaseSteps.findIndex(step => step.id === 'open');
    }
    if (normalized === 'phase2started' || normalized === 'pending_vrf' || normalized === 'pendingvrf') {
      return this.phaseSteps.findIndex(step => step.id === 'bindVrf');
    }
    if (normalized === 'vrf_binded' || normalized === 'vrfbinded') {
      return this.phaseSteps.findIndex(step => step.id === 'pendingVrf');
    }
    if (normalized === 'ready_to_draw' || normalized === 'readytodraw' || normalized === 'vrf_fulfilled') {
      return this.phaseSteps.findIndex(step => step.id === 'readyToDraw');
    }
    if (normalized === 'proceeding_purchases' || normalized === 'proceedingpurchases') {
      return this.phaseSteps.findIndex(step => step.id === 'proceedingPurchases');
    }
    return 0;
  }

  isPhaseTwoStarted(): boolean {
    const normalized = (this.lottery?.status || '').toLowerCase();
    return normalized === 'phase2started'
      || normalized === 'pending_vrf'
      || normalized === 'pendingvrf'
      || normalized === 'vrf_binded'
      || normalized === 'vrfbinded';
  }

  canBindVrfRequest(): boolean {
    const normalized = (this.lottery?.status || '').toLowerCase();
    return normalized === 'phase2started'
      || normalized === 'pending_vrf'
      || normalized === 'pendingvrf';
  }

  getFulfillCooldownRemainingSeconds(): number {
    if (!this.lottery?.second_phase_started_at) {
      return 0;
    }

    // The new client returns the date as an ISO string — we convert it ourselves.
    const startedAt = new Date(this.lottery.second_phase_started_at);
    const startedAtMs = startedAt.getTime();
    if (!Number.isFinite(startedAtMs)) {
      return 0;
    }

    const elapsedSeconds = (Date.now() - startedAtMs) / 1000;
    const remaining = this.fulfillVrfMinDelaySeconds - elapsedSeconds;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  }

  canStartPhaseTwo(): boolean {
    const normalized = (this.lottery?.status || '').toLowerCase();
    return normalized === 'created' && this.getStartPhaseTwoCooldownRemainingSeconds() === 0;
  }

  getStartPhaseTwoCooldownRemainingSeconds(): number {
    if (!this.lottery?.end_date) {
      return 0;
    }

    const endDate = new Date(this.lottery.end_date);
    const endDateMs = endDate.getTime();
    if (!Number.isFinite(endDateMs)) {
      return 0;
    }

    const remaining = (endDateMs - Date.now()) / 1000;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  }

  canStartDraw(): boolean {
    const normalized = (this.lottery?.status || '').toLowerCase();
    return normalized === 'ready_to_draw' || normalized === 'readytodraw' || normalized === 'vrf_fulfilled';
  }

  canFulfillVrf(): boolean {
    const normalized = (this.lottery?.status || '').toLowerCase();
    const isPendingVrfPhase = normalized === 'vrf_binded'
      || normalized === 'vrfbinded'
      || normalized === 'pending_vrf'
      || normalized === 'pendingvrf';
    return isPendingVrfPhase && !this.lottery?.is_offchain_vrf && this.getFulfillCooldownRemainingSeconds() === 0;
  }

  canRunPurchasesActions(): boolean {
    const normalized = (this.lottery?.status || '').toLowerCase();
    return normalized === 'proceeding_purchases' || normalized === 'proceedingpurchases';
  }

  private setVrfLoading(value: boolean): void {
    this.ngZone.run(() => {
      this.isFulfillingVrf = value;
      this.cdr.detectChanges();
    });
  }

  private setBindVrfLoading(value: boolean): void {
    this.ngZone.run(() => {
      this.isBindingVrfRequest = value;
      this.cdr.detectChanges();
    });
  }

  private setDrawLoading(value: boolean): void {
    this.ngZone.run(() => {
      this.isStartingDraw = value;
      this.cdr.detectChanges();
    });
  }

  private setRetryRandomnessLoading(value: boolean): void {
    this.ngZone.run(() => {
      this.isRetryingRandomness = value;
      this.cdr.detectChanges();
    });
  }

  private setVrfPreviewLoading(value: boolean): void {
    this.ngZone.run(() => {
      this.isVrfPreviewing = value;
      this.cdr.detectChanges();
    });
  }

  private setRunPurchasesLoading(value: boolean): void {
    this.ngZone.run(() => {
      this.isRunningPurchases = value;
      this.cdr.detectChanges();
    });
  }

  onVrfPreview(): void {
    if (this.isVrfPreviewing || !this.lottery?.id) {
      return;
    }
    if (!this.canRunPurchasesActions()) {
      this.purchasesError = 'Display JSON is available only in proceeding_purchases status.';
      return;
    }

    this.setVrfPreviewLoading(true);
    this.api.invoke(runPurchasesPayloadPreviewLotteryLotteryIdRunPurchasesPayloadGet, { lottery_id: this.lottery.id })
      .pipe(finalize(() => {
        this.setVrfPreviewLoading(false);
      }))
      .subscribe({
        next: (result: RunPurchasesPayload) => {
          const executePayload = result;
          console.log('Run purchases execute payload preview:', executePayload);
          alert(JSON.stringify(executePayload, null, 2));
        },
        error: (error) => {
          console.error('Run purchases payload preview error:', error);
          alert('Failed to build execute payload preview. Check console for details.');
        }
      });
  }

  onRunPurchases(): void {
    if (this.isRunningPurchases || !this.lottery?.id) {
      return;
    }
    if (!this.canRunPurchasesActions()) {
      this.purchasesError = 'Run Purchases is available only in proceeding_purchases status.';
      return;
    }

    this.purchasesError = null;
    this.purchasesSuccess = null;
    this.setRunPurchasesLoading(true);

    this.api.invoke(runPurchasesLotteryLotteryIdRunPurchasesPost, { lottery_id: this.lottery.id })
      .pipe(finalize(() => {
        this.setRunPurchasesLoading(false);
      }))
      .subscribe({
        next: (result: RunPurchasesResponse) => {
          const payload = result?.payload;
          this.purchasesSuccess = `Purchases started in offchain API for lottery ${result?.lottery_id}.`;
          console.log('Run purchases response:', result);
          alert(JSON.stringify({
            lottery_id: result?.lottery_id,
            payload,
            offchain_response: result?.offchain_response,
          }, null, 2));
        },
        error: (error) => {
          console.error('Run purchases error:', error);
          this.purchasesError = error?.message || 'Failed to run purchases.';
        }
      });
  }

}
