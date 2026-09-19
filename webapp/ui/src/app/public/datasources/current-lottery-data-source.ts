import {CollectionViewer, DataSource} from "@angular/cdk/collections";
import {BehaviorSubject, catchError, finalize, Observable, of} from "rxjs";
import {Api} from "../../api-client/api";
import {getCurrentLotteryLotteryCurrentGet} from "../../api-client/fn/lottery/get-current-lottery-lottery-current-get";
import {LotteryEntryResponse} from "../../api-client/models/lottery-entry-response";
import {LotteryListResponse} from "../../api-client/models/lottery-list-response";
import {StrictHttpResponse} from "../../api-client/strict-http-response";

export class CurrentLotteryDataSource implements DataSource<LotteryEntryResponse> {

  private lotteryEntriesSubject = new BehaviorSubject<LotteryEntryResponse[]>([]);
  private loadingSubject = new BehaviorSubject<boolean>(false);
  private hasActiveLotterySubject = new BehaviorSubject<boolean>(false);
  private readonly realOnly: boolean;

  public loading$ = this.loadingSubject.asObservable();
  public lotteryEntries$ = this.lotteryEntriesSubject.asObservable();
  public hasActiveLottery$ = this.hasActiveLotterySubject.asObservable();

  constructor(private api: Api, options?: { realOnly?: boolean }) {
    this.realOnly = options?.realOnly ?? false;
  }

  connect(_: CollectionViewer): Observable<LotteryEntryResponse[]> {
    return this.lotteryEntriesSubject.asObservable();
  }

  disconnect(_: CollectionViewer): void {
    this.lotteryEntriesSubject.complete();
    this.loadingSubject.complete();
  }

  loadLotteryEntries() {
    this.loadingSubject.next(true);

    this.api.invoke$Response(getCurrentLotteryLotteryCurrentGet, {})
      .pipe(
        catchError((error) => {
          console.error('Error loading lottery data:', error);
          this.hasActiveLotterySubject.next(false);
          const fallback: StrictHttpResponse<LotteryListResponse> = {
            body: { entries: [], has_active_lottery: false }
          } as StrictHttpResponse<LotteryListResponse>;
          return of(fallback);
        }),
        finalize(() => this.loadingSubject.next(false))
      ).subscribe((response) => {
        const body: LotteryListResponse = (response.body as LotteryListResponse) || { entries: [], has_active_lottery: false };
        const entries = body.entries || [];
        const filteredEntries = this.realOnly
          ? entries.filter((entry) => (entry.bet_count || 0) > 0)
          : entries;
        this.lotteryEntriesSubject.next(filteredEntries);
        this.hasActiveLotterySubject.next(!!body.has_active_lottery);
      });
  }

  refresh() {
    this.loadLotteryEntries();
  }
}
