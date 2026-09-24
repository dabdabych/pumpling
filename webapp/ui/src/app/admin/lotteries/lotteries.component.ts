import { Component, OnInit, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Api } from "../../api-client/api";
import { closeLotteryLotteryLotteryIdClosePost } from "../../api-client/fn/lottery/close-lottery-lottery-lottery-id-close-post";
import { LotteryResponse } from "../../api-client/models/lottery-response";
import { MatSort } from "@angular/material/sort";
import { MatPaginator } from "@angular/material/paginator";
import { LotteriesDataSource } from "./lotteries-data-source";
import { finalize, tap } from "rxjs/operators";
import { Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import { Buffer } from 'buffer';
import lotteryIdl from '../../idl/lottery_v_1_0.json';
import { CloseLotteryConfirm, SystemDialog } from "../../shared/system-dialog";
import { isWalletFlowInterruption, WalletService } from '../../shared/wallet.service';
import { DEVNET_ADMIN_WALLETS, isAllowedAdminWallet } from '../../shared/admin-wallets';
import { environment } from '../../../environments/environment';

interface UserDeposit {
  walletAddress: string;
  amount: number;
  timestamp: number;
  signature: string;
}

// One cycle. The `pumpfun` one was retired; a deployment that ran it keeps
// its row, which this screen no longer lists.
type CycleLotteryType = 'dex';

interface LotteryCycleControl {
  lottery_type: CycleLotteryType;
  enabled: boolean;
  stop_requested_at?: string | null;
  updated_at?: string | null;
}

@Component({
    selector: 'app-lotteries',
    templateUrl: './lotteries.component.html',
    styleUrls: ['./lotteries.component.scss'],
    standalone: false
})
export class LotteriesComponent implements OnInit {
  @ViewChild(MatSort, {static: true}) sort: MatSort;
  @ViewChild(MatPaginator, {static: true}) paginator: MatPaginator;

  dataSource: LotteriesDataSource;
  displayedColumns = ['id', 'name', 'lottery_type', 'status', 'created_at', 'end_date', 'action'];

  // Solana deposits tracking
  contractAddress = 'CkAyTJ2MUkK8VZpkzY4ztwR5ius98kaHtf8o2VSWeMvo';
  deposits: UserDeposit[] = [];
  isLoadingDeposits = false;
  depositsError: string | null = null;
  totalDeposited = 0;
  readonly cycleTypes: CycleLotteryType[] = ['dex'];
  cycleControls: Record<CycleLotteryType, LotteryCycleControl | null> = {
    dex: null,
  };
  cycleActionInFlight: Record<CycleLotteryType, boolean> = {
    dex: false,
  };
  cycleError: string | null = null;
  private closingIds = new Set<number>();
  private lotteryProgramId = new PublicKey('4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH');
  private adminPubkey = new PublicKey(DEVNET_ADMIN_WALLETS[0]);

  constructor(
    private api: Api,
    private http: HttpClient,
    private router: Router,
    private systemDialog: SystemDialog,
    private walletService: WalletService
  ) {
    this.dataSource = new LotteriesDataSource(api);
  }

  ngOnInit(): void {
  }

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.loadLotteriesPage();
      this.loadContractDeposits();
      this.loadCycleControls();
    });

    this.paginator.page
      .pipe(
        tap(() => this.loadLotteriesPage())
      )
      .subscribe();
  }

  loadLotteriesPage(): void {
    this.dataSource.loadLotteries(
      this.paginator.pageIndex,
      this.paginator.pageSize
    );
  }

  refresh(): void {
    this.loadLotteriesPage();
    this.loadCycleControls();
  }

  loadCycleControls(): void {
    this.cycleError = null;
    this.http.get<{ items: LotteryCycleControl[] }>(`${environment.apiUrl}/lottery/cycles`, { withCredentials: true })
      .subscribe({
        next: (payload) => {
          for (const item of payload.items || []) {
            if (item.lottery_type === 'dex') {
              this.cycleControls[item.lottery_type] = item;
            }
          }
        },
        error: (error) => {
          this.cycleError = this.extractErrorMessage(error);
        },
      });
  }

  getCycleLabel(lotteryType: CycleLotteryType): string {
    return lotteryType.toUpperCase();
  }

  isCycleEnabled(lotteryType: CycleLotteryType): boolean {
    return this.cycleControls[lotteryType]?.enabled !== false;
  }

  isCycleBusy(lotteryType: CycleLotteryType): boolean {
    return this.cycleActionInFlight[lotteryType];
  }

  async stopCycle(lotteryType: CycleLotteryType): Promise<void> {
    const label = this.getCycleLabel(lotteryType);
    const confirmed = await this.systemDialog.confirm(
      `Stop ${label} cycle? The current lottery will remain active, but no next ${label} lottery will auto-start.`,
      CloseLotteryConfirm
    );
    if (!confirmed) {
      return;
    }
    this.updateCycle(lotteryType, false);
  }

  resumeCycle(lotteryType: CycleLotteryType): void {
    this.updateCycle(lotteryType, true);
  }

  private updateCycle(lotteryType: CycleLotteryType, enabled: boolean): void {
    const action = enabled ? 'resume' : 'stop';
    this.cycleError = null;
    this.cycleActionInFlight[lotteryType] = true;
    this.http.post<LotteryCycleControl>(
      `${environment.apiUrl}/lottery/cycles/${lotteryType}/${action}`,
      {},
      { withCredentials: true }
    ).pipe(
      finalize(() => {
        this.cycleActionInFlight[lotteryType] = false;
      })
    ).subscribe({
      next: (control) => {
        this.cycleControls[lotteryType] = control;
      },
      error: (error) => {
        this.cycleError = this.extractErrorMessage(error);
      },
    });
  }

  viewDetails(lottery: LotteryResponse): void {
    this.router.navigate(['/admin/lotteries', lottery.id]);
  }

  async loadContractDeposits(): Promise<void> {
    this.setDepositsLoading(true);
    this.depositsError = null;

    try {
      // Connect to the configured Solana cluster.
      const connection = new Connection(environment.solanaRpcUrl, 'confirmed');

      // Get contract public key
      const contractPubkey = new PublicKey(this.contractAddress);

      // Get transaction signatures for this address
      const signatures = await connection.getSignaturesForAddress(contractPubkey, { limit: 100 });

      console.log(`Found ${signatures.length} transactions for contract`);

      const deposits: UserDeposit[] = [];

      // Fetch transaction details for each signature
      for (const signatureInfo of signatures) {
        try {
          const transaction = await connection.getTransaction(signatureInfo.signature, {
            maxSupportedTransactionVersion: 0
          });

          if (!transaction || !transaction.meta) continue;

          // Get the accounts involved - handle both legacy and versioned transactions
          let accountKeys: PublicKey[];
          const message = transaction.transaction.message;

          // Check if it's a versioned transaction
          if ('getAccountKeys' in message && typeof message.getAccountKeys === 'function') {
            // Versioned transaction - getAccountKeys returns an object with keySegments array
            const keys = message.getAccountKeys();
            accountKeys = Array.isArray(keys) ? keys : (keys.staticAccountKeys || keys.keySegments?.[0] || []);
          } else {
            // Legacy transaction - has accountKeys property directly
            accountKeys = (message as any).accountKeys || [];
          }

          if (!accountKeys || accountKeys.length === 0) continue;

          // Find transfers to our contract
          const preBalances = transaction.meta.preBalances;
          const postBalances = transaction.meta.postBalances;

          // Find the index of our contract address
          const contractIndex = accountKeys.findIndex(key =>
            key.toString() === this.contractAddress
          );

          if (contractIndex === -1) continue;

          // Check if there was a balance increase (deposit)
          const balanceChange = postBalances[contractIndex] - preBalances[contractIndex];

          if (balanceChange > 0) {
            // Find the sender (account with balance decrease)
            for (let i = 0; i < accountKeys.length; i++) {
              if (i !== contractIndex && preBalances[i] > postBalances[i]) {
                const senderChange = preBalances[i] - postBalances[i];

                deposits.push({
                  walletAddress: accountKeys[i].toString(),
                  amount: balanceChange / LAMPORTS_PER_SOL,
                  timestamp: signatureInfo.blockTime || 0,
                  signature: signatureInfo.signature
                });
                break;
              }
            }
          }
        } catch (error) {
          console.error('Error processing transaction:', error);
          // Continue to next transaction
        }
      }

      this.deposits = deposits.sort((a, b) => b.timestamp - a.timestamp);
      this.totalDeposited = deposits.reduce((sum, d) => sum + d.amount, 0);

      console.log('Loaded deposits:', this.deposits);
      console.log('Total deposited:', this.totalDeposited);

    } catch (error: any) {
      console.error('Error loading deposits:', error);
      this.depositsError = error.message || 'Failed to load deposits from blockchain';
    } finally {
      this.setDepositsLoading(false);
    }
  }

  private setDepositsLoading(value: boolean): void {
    setTimeout(() => {
      this.isLoadingDeposits = value;
    });
  }

  getShortAddress(address: string): string {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  }

  formatDate(timestamp: number): string {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp * 1000).toLocaleString();
  }

  viewTransactionOnExplorer(signature: string): void {
    window.open(
      `https://explorer.solana.com/tx/${signature}${environment.solanaExplorerQuery}`,
      '_blank'
    );
  }

  isClosing(lottery: LotteryResponse): boolean {
    return !!lottery.id && this.closingIds.has(lottery.id);
  }

  private isBackendOnlyClosable(lottery: LotteryResponse): boolean {
    return (lottery.status || '').toLowerCase() === 'id_generated';
  }

  async closeLottery(lottery: LotteryResponse): Promise<void> {
    if (!lottery.id) {
      return;
    }

    const backendOnlyClose = this.isBackendOnlyClosable(lottery);
    const confirmed = await this.systemDialog.confirm(
      backendOnlyClose
        ? `Close lottery "${lottery.name}"? This will close it in backend only (no on-chain call).`
        : `Close lottery "${lottery.name}"? This will finalize the lottery on-chain.`,
      CloseLotteryConfirm
    );

    if (!confirmed) {
      return;
    }

    this.closingIds.add(lottery.id);

    try {
      if (backendOnlyClose) {
        this.api.invoke(closeLotteryLotteryLotteryIdClosePost, { lottery_id: lottery.id })
          .pipe(finalize(() => this.closingIds.delete(lottery.id!)))
          .subscribe({
            next: () => {
              this.loadLotteriesPage();
              void this.systemDialog.info(`Lottery "${lottery.name}" has been closed successfully.`);
            },
            error: (error) => {
              void this.systemDialog.info(`Error: Failed to close lottery "${lottery.name}". ${this.extractErrorMessage(error)}`);
            }
          });
        return;
      }

      const walletAddress = await this.walletService.connect();
      if (!isAllowedAdminWallet(walletAddress)) {
        throw new Error('Only the admin wallet can close lotteries.');
      }
      const activeAdminPubkey = new PublicKey(walletAddress);

      const program = this.getLotteryProgram();
      if (!program) {
        throw new Error('Failed to initialize lottery program.');
      }

      const pdas = this.deriveLotteryPdas(lottery.id, activeAdminPubkey);
      if (!pdas) {
        throw new Error('Failed to derive lottery accounts.');
      }

      await program.methods
        .closeLottery()
        .accounts({
          lottery: pdas.lottery,
          vault: pdas.vault,
          admin: activeAdminPubkey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.api.invoke(closeLotteryLotteryLotteryIdClosePost, { lottery_id: lottery.id })
        .pipe(finalize(() => this.closingIds.delete(lottery.id!)))
        .subscribe({
          next: () => {
            this.loadLotteriesPage();
            void this.systemDialog.info(`Lottery "${lottery.name}" has been closed successfully.`);
          },
          error: (error) => {
            void this.systemDialog.info(`Error: Failed to close lottery "${lottery.name}". ${this.extractErrorMessage(error)}`);
          }
        });
    } catch (error) {
      if (isWalletFlowInterruption(error)) {
        this.closingIds.delete(lottery.id);
        return;
      }
      console.error('Close lottery error:', error);
      this.closingIds.delete(lottery.id);
      void this.systemDialog.info(`Error: Failed to close lottery "${lottery.name}". ${this.extractErrorMessage(error)}`);
    }
  }

  private extractErrorMessage(error: any): string {
    return (
      error?.error?.detail ||
      error?.error?.message ||
      error?.message ||
      'Unexpected error'
    );
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
}
