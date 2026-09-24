import { ChangeDetectorRef, Component, NgZone, OnInit } from '@angular/core';
import { FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../../api-client/api';
import { createLotteryLotteryCreatePost } from '../../api-client/fn/lottery/create-lottery-lottery-create-post';
import { getAllLotteriesLotteryAllGet } from '../../api-client/fn/lottery/get-all-lotteries-lottery-all-get';
import { CreateLotteryRequest } from '../../api-client/models/create-lottery-request';
import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import lotteryIdl from '../../idl/lottery_v_1_0.json';
import { isWalletFlowInterruption, WalletService } from '../../shared/wallet.service';
import { DEVNET_ADMIN_WALLETS, isAllowedAdminWallet } from '../../shared/admin-wallets';
import { environment } from '../../../environments/environment';

interface AnchorWalletAdapter {
  publicKey: PublicKey;
  signTransaction: (transaction: any) => Promise<any>;
  signAllTransactions: (transactions: any[]) => Promise<any[]>;
}

@Component({
    selector: 'app-create-lottery',
    templateUrl: './create-lottery.component.html',
    styleUrls: ['./create-lottery.component.scss'],
    standalone: false
})
export class CreateLotteryComponent implements OnInit {
  lotteryForm: FormGroup;
  endDateControl = new FormControl<Date | null>(null);
  endTimeControl = new FormControl<Date | null>(null);
  isSubmitting = false;
  isInitializingLottery = false;
  isGeneratingLotteryId = false;
  generateError: string | null = null;
  initializeError: string | null = null;
  initializeErrorDetails: string | null = null;
  initializeSuccess: string | null = null;
  connectedWalletAddress: string | null = null;
  initializeDebug: string | null = null;
  createdLotteryId: number | null = null;
  openLotteryExists = false;
  openLotteryId: number | null = null;
  openLotteryStatus: string | null = null;
  openLotteryType: string | null = null;
  lotteryProgramId = new PublicKey('4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH');
  defaultAdminPubkey = new PublicKey(DEVNET_ADMIN_WALLETS[0]);
  feeWalletPubkey = new PublicKey('EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ');
  keeperWalletPubkey = new PublicKey('6iBJFCS4jMKD8xTj78axawb6r8UASRJaDBz6cKSXx1a9');
  constructor(
    private fb: FormBuilder,
    private api: Api,
    private router: Router,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
    private walletService: WalletService
  ) {
    this.lotteryForm = this.fb.group({
      name: ['', [Validators.required, Validators.minLength(3)]],
      lottery_type: ['dex', [Validators.required]],
      lottery_id: [''],
      wallet_fee: [this.feeWalletPubkey.toBase58()],
      wallet_keeper: [this.keeperWalletPubkey.toBase58()],
      // 111 SOL is the same cap as autostart uses in settings.py. It used to be
      // 200 here, so the form and autostart created rounds with different
      // maximums. The cap came down to fit the pump.fun bonding curve.
      max_total: [111, [Validators.required, Validators.min(0.01)]]
    });
  }

  ngOnInit(): void {
    const nameControl = this.lotteryForm.get('name');
    if (nameControl && !nameControl.value) {
      nameControl.setValue(this.buildDefaultLotteryName());
    }
    if (!this.endDateControl.value && !this.endTimeControl.value) {
      const defaultEnd = this.buildDefaultEndDate();
      this.endDateControl.setValue(defaultEnd);
      this.endTimeControl.setValue(defaultEnd);
    }
    this.endDateControl.valueChanges.subscribe((date) => {
      if (!date) {
        this.endTimeControl.setValue(null, { emitEvent: false });
      }
    });
    this.loadDraftLottery();
  }

  onSubmit(): void {
    if (this.lotteryForm.invalid) {
      return;
    }

    this.isSubmitting = true;

    const formValue = this.lotteryForm.value;
    const request: CreateLotteryRequest = {
      name: formValue.name,
      lottery_type: formValue.lottery_type,
      end_date: this.getEndDateValue()?.toISOString() ?? undefined,
      max_total: formValue.max_total ?? undefined
    };

    this.api.invoke(createLotteryLotteryCreatePost, { body: request }).subscribe({
      next: (response) => {
        this.isSubmitting = false;
        this.router.navigate(['/admin/lotteries']);
      },
      error: () => {
        // Error handling is done globally by ErrorInterceptor
        this.isSubmitting = false;
      }
    });
  }

  onCancel(): void {
    this.router.navigate(['/admin/lotteries']);
  }

  generateLotteryId(): void {
    if (this.isBlockedByOpenLottery()) {
      return;
    }
    if (this.hasGeneratedLotteryId()) {
      return;
    }
    this.generateError = null;
    const nameControl = this.lotteryForm.get('name');
    if (!nameControl || nameControl.invalid) {
      nameControl?.markAsTouched();
      this.generateError = 'Please provide a valid lottery name';
      return;
    }

    this.isGeneratingLotteryId = true;
    const formValue = this.lotteryForm.value;
    const request: CreateLotteryRequest = {
      name: formValue.name,
      lottery_type: formValue.lottery_type,
      end_date: this.getEndDateValue()?.toISOString() ?? undefined,
      max_total: formValue.max_total ?? undefined
    };

    this.api.invoke(createLotteryLotteryCreatePost, { body: request, allow_existing: true }).subscribe({
      next: (response) => {
        this.isGeneratingLotteryId = false;
        this.lotteryForm.get('lottery_id')?.setValue(response.id.toString());
      },
      error: (error) => {
        console.error('Failed to generate lottery timestamp id:', error);
        this.isGeneratingLotteryId = false;
        this.generateError = 'Failed to generate lottery timestamp id';
      }
    });
  }

  async initializeLottery(): Promise<void> {
    if (this.isInitializingLottery) {
      return;
    }
    this.initializeError = null;
    this.initializeErrorDetails = null;
    this.initializeSuccess = null;
    this.initializeDebug = null;
    this.isInitializingLottery = true;

    try {
      if (this.isBlockedByOpenLottery()) {
        this.initializeError = 'An open lottery already exists. You cannot create a new lottery.';
        return;
      }

      let walletAddress: string;
      try {
        walletAddress = await this.walletService.connect();
      } catch (error: any) {
        if (isWalletFlowInterruption(error)) {
          return;
        }
        this.initializeError = error?.message || 'Please connect a supported Solana wallet';
        return;
      }
      this.connectedWalletAddress = walletAddress;

      if (!isAllowedAdminWallet(walletAddress)) {
        this.initializeError = `Only admin can initialize lottery. Connected: ${walletAddress}`;
        return;
      }
      const activeAdminPubkey = new PublicKey(walletAddress);

      const program = this.getLotteryProgram();
      if (!program) {
        this.initializeError = this.initializeError || 'Failed to initialize lottery program';
        return;
      }

      const feeWalletRaw = this.lotteryForm.get('wallet_fee')?.value?.trim() || activeAdminPubkey.toBase58();
      const keeperWalletRaw = this.lotteryForm.get('wallet_keeper')?.value?.trim();
      if (!keeperWalletRaw) {
        this.initializeError = 'Please provide keeper wallet address';
        return;
      }

      let feeWallet: PublicKey;
      let keeperWallet: PublicKey;
      try {
        feeWallet = new PublicKey(feeWalletRaw);
        keeperWallet = new PublicKey(keeperWalletRaw);
      } catch (error) {
        console.error('Invalid lottery wallet address', error);
        this.initializeError = 'Invalid fee/keeper wallet address';
        return;
      }

      if (feeWallet.equals(keeperWallet)) {
        this.initializeError = 'Fee wallet and keeper wallet must be different';
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const lotteryIdRaw = this.lotteryForm.get('lottery_id')?.value?.toString().trim();
      if (!lotteryIdRaw) {
        this.initializeError = 'Please generate a lottery timestamp id first';
        return;
      }
      const lotteryId = Number(lotteryIdRaw);
      if (!Number.isFinite(lotteryId) || lotteryId <= 0) {
        this.initializeError = 'Invalid lottery timestamp id';
        return;
      }
      const startTs = now;
      const endDate = this.getEndDateValue();
      const endTs = endDate ? Math.floor(endDate.getTime() / 1000) : now + 3600;
      if (endTs <= startTs) {
        this.initializeError = 'End date must be after start date';
        return;
      }
      const feeBps = 300;
      const maxTotalRaw = this.lotteryForm.get('max_total')?.value;
      const maxTotalSol = Number(maxTotalRaw);
      if (!Number.isFinite(maxTotalSol) || maxTotalSol <= 0) {
        this.initializeError = 'Please provide a valid total limit (SOL)';
        return;
      }
      const maxTotalLamports = Math.floor(maxTotalSol * LAMPORTS_PER_SOL);
      const vrfAlgorithmHashBytes = this.getVrfAlgorithmHashBytesFromEnv();
      if (!vrfAlgorithmHashBytes) {
        return;
      }

      const pdas = this.deriveLotteryPdas(lotteryId, activeAdminPubkey);
      if (!pdas) {
        this.initializeError = 'Failed to derive lottery PDAs';
        return;
      }
      const connection = program.provider.connection;
      const existingLottery = await connection.getAccountInfo(pdas.lottery);
      if (existingLottery) {
        this.createdLotteryId = lotteryId;
        this.initializeSuccess = `Lottery already initialized. PDA: ${pdas.lottery.toBase58()}`;
        return;
      }

      this.initializeDebug = JSON.stringify({
        walletAddress,
        admin: activeAdminPubkey.toBase58(),
        lotteryId,
        startTs,
        endTs,
        maxTotalLamports,
        vrfAlgorithmHash: `0x${Buffer.from(vrfAlgorithmHashBytes).toString('hex')}`,
        lotteryPda: pdas.lottery.toBase58(),
        vaultPda: pdas.vault.toBase58(),
      });

      const tx = await program.methods
        .initialize(
          new BN(lotteryId),
          new BN(startTs),
          new BN(endTs),
          feeBps,
          null,
          null,
          new BN(maxTotalLamports),
          vrfAlgorithmHashBytes
        )
        .accounts({
          lottery: pdas.lottery,
          vault: pdas.vault,
          walletFee: feeWallet,
          walletKeeper: keeperWallet,
          admin: activeAdminPubkey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.createdLotteryId = lotteryId;
      this.initializeSuccess = `Lottery initialized! PDA: ${pdas.lottery.toBase58()}. Tx: ${tx}`;
    } catch (error: any) {
      console.error('Initialize lottery error:', error);
      const errorMessage =
        error?.transactionMessage || error?.message || 'Failed to initialize lottery';
      const errorDetails = this.formatInitializeErrorDetails(error);
      this.ngZone.run(() => {
        this.initializeError = errorMessage;
        this.initializeErrorDetails = errorDetails;
      });
    } finally {
      this.ngZone.run(() => {
        this.isInitializingLottery = false;
        this.cdr.detectChanges();
      });
    }
  }

  private loadDraftLottery(): void {
    this.api.invoke(getAllLotteriesLotteryAllGet, { page_index: 0, page_size: 100 }).subscribe({
      next: (response) => {
        const openStatuses = new Set(['id_generated', 'created']);
        const selectedType = (this.lotteryForm.get('lottery_type')?.value || 'dex').toString().toLowerCase();
        const openLottery = response.items?.find(
          (lottery) =>
            openStatuses.has((lottery.status || '').toLowerCase())
            && ((lottery.lottery_type || 'dex').toString().toLowerCase() === selectedType)
        );
        this.openLotteryExists = !!openLottery;
        this.openLotteryId = openLottery?.id ?? null;
        this.openLotteryStatus = openLottery?.status ?? null;
        this.openLotteryType = openLottery?.lottery_type ?? null;

        const draft = response.items?.find(
          (lottery) =>
            (lottery.status || '').toLowerCase() === 'id_generated'
            && ((lottery.lottery_type || 'dex').toString().toLowerCase() === selectedType)
        );
        if (!draft) {
          return;
        }

        this.lotteryForm.patchValue({
          name: draft.name,
          lottery_type: draft.lottery_type || selectedType,
          lottery_id: draft.id?.toString() ?? '',
          max_total: draft.max_total ?? this.lotteryForm.get('max_total')?.value
        });
        if (draft.end_date) {
          const endDate = new Date(draft.end_date);
          this.endDateControl.setValue(endDate);
          this.endTimeControl.setValue(endDate);
        }
      },
      error: (error) => {
        console.error('Failed to load draft lottery:', error);
      }
    });
  }

  goToCreatedLottery(): void {
    if (!this.createdLotteryId) {
      return;
    }
    this.router.navigate(['/admin/lotteries', this.createdLotteryId]);
  }

  private buildDefaultLotteryName(): string {
    const iso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    return `Lottery-${iso}`;
  }

  private buildDefaultEndDate(): Date {
    return new Date(Date.now() + 4 * 60 * 1000);
  }

  private getEndDateValue(): Date | null {
    const date = this.endDateControl.value;
    if (!date) {
      return null;
    }

    const time = this.endTimeControl.value;
    if (!time) {
      return date;
    }

    const merged = new Date(date);
    merged.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), time.getMilliseconds());
    return merged;
  }

  private formatInitializeErrorDetails(error: any): string | null {
    if (!error) {
      return null;
    }

    const logs = Array.isArray(error.transactionLogs)
      ? error.transactionLogs
      : Array.isArray(error?.logs) ? error.logs : null;
    const programErrorStack = Array.isArray(error?.programErrorStack)
      ? error.programErrorStack
      : null;

    const lines: string[] = [];
    if (logs && logs.length) {
      lines.push('Transaction logs:');
      lines.push(...logs);
    }
    if (programErrorStack && programErrorStack.length) {
      lines.push('Program error stack:');
      lines.push(...programErrorStack);
    }

    if (lines.length) {
      return lines.join('\n');
    }

    const fallback = this.safeStringifyError(error);
    return fallback ? `Error details:\n${fallback}` : null;
  }

  private safeStringifyError(error: any): string | null {
    try {
      const seen = new WeakSet();
      return JSON.stringify(
        error,
        (key, value) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
              return '[Circular]';
            }
            seen.add(value);
          }
          return value;
        },
        2
      );
    } catch (stringifyError) {
      return error?.toString ? error.toString() : null;
    }
  }

  private getVrfAlgorithmHashBytesFromEnv(): number[] | null {
    const raw = (environment.vrfAlgorithmHash || '').trim();
    if (!raw) {
      this.initializeError = 'VRF algorithm hash is missing. Set environment.vrfAlgorithmHash in UI sources.';
      return null;
    }

    const normalized = raw.startsWith('0x') || raw.startsWith('0X')
      ? raw.slice(2)
      : raw;

    if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
      this.initializeError = 'Invalid VRF algorithm hash format. Expected 32-byte hex (64 chars).';
      return null;
    }

    const bytes: number[] = [];
    for (let i = 0; i < normalized.length; i += 2) {
      bytes.push(parseInt(normalized.slice(i, i + 2), 16));
    }

    if (bytes.length !== 32 || bytes.every((value) => value === 0)) {
      this.initializeError = 'VRF algorithm hash must be a non-zero 32-byte hex value.';
      return null;
    }

    return bytes;
  }

  private getLotteryProgram(): Program | null {
    try {
      const provider = this.walletService.getProvider();
      if (!provider) {
        this.initializeErrorDetails = 'No Solana wallet provider is available after wallet connection.';
        return null;
      }

      const wallet = this.buildAnchorWallet(provider);
      const connection = new Connection(environment.solanaRpcUrl, 'confirmed');
      const anchorProvider = new AnchorProvider(connection, wallet as any, {
        preflightCommitment: 'confirmed',
      });
      const idlWithAddress = { ...(lotteryIdl as any), address: this.lotteryProgramId.toBase58() };
      return new Program(idlWithAddress as any, anchorProvider);
    } catch (error) {
      console.error('Error creating lottery program instance:', error);
      this.initializeErrorDetails = this.formatInitializeErrorDetails(error);
      return null;
    }
  }

  private buildAnchorWallet(provider: any): AnchorWalletAdapter {
    const publicKey = this.readProviderPublicKey(provider);
    if (!publicKey) {
      throw new Error('Connected wallet did not expose a public key.');
    }
    if (typeof provider.signTransaction !== 'function') {
      throw new Error('Connected wallet does not support transaction signing required by Anchor.');
    }

    return {
      publicKey,
      signTransaction: (transaction: any) => provider.signTransaction(transaction),
      signAllTransactions: async (transactions: any[]) => {
        if (typeof provider.signAllTransactions === 'function') {
          return provider.signAllTransactions(transactions);
        }

        const signedTransactions = [];
        for (const transaction of transactions) {
          signedTransactions.push(await provider.signTransaction(transaction));
        }
        return signedTransactions;
      },
    };
  }

  private readProviderPublicKey(provider: any): PublicKey | null {
    const publicKey = provider?.publicKey;
    if (!publicKey) {
      return null;
    }
    if (publicKey instanceof PublicKey) {
      return publicKey;
    }

    const address = publicKey.toBase58?.() || publicKey.toString?.();
    return address ? new PublicKey(address) : null;
  }

  private deriveLotteryPdas(
    lotteryId: number,
    adminPubkey: PublicKey = this.defaultAdminPubkey,
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

  hasGeneratedLotteryId(): boolean {
    const lotteryId = this.lotteryForm.get('lottery_id')?.value;
    return !!lotteryId?.toString().trim();
  }

  isBlockedByOpenLottery(): boolean {
    if (!this.openLotteryExists) {
      return false;
    }

    const currentLotteryIdRaw = this.lotteryForm.get('lottery_id')?.value;
    const currentLotteryId = Number(currentLotteryIdRaw);
    if (Number.isFinite(currentLotteryId) && this.openLotteryId === currentLotteryId) {
      return false;
    }

    return true;
  }

  onLotteryTypeChange(): void {
    this.lotteryForm.get('lottery_id')?.setValue('');
    this.createdLotteryId = null;
    this.generateError = null;
    this.initializeError = null;
    this.initializeSuccess = null;
    this.loadDraftLottery();
  }
}
