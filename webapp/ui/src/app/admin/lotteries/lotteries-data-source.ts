import {CollectionViewer, DataSource} from "@angular/cdk/collections";
import {BehaviorSubject, catchError, finalize, Observable, of} from "rxjs";
import { Api } from "../../api-client/api";
import { getAllLotteriesLotteryAllGet } from "../../api-client/fn/lottery/get-all-lotteries-lottery-all-get";
import { PagedLotteryResponse } from "../../api-client/models/paged-lottery-response";
import { LotteryResponse } from "../../api-client/models/lottery-response";

export class LotteriesDataSource implements DataSource<LotteryResponse> {

  private lotteriesSubject = new BehaviorSubject<LotteryResponse[]>([]);
  private loadingSubject = new BehaviorSubject<boolean>(false);

  public loading$ = this.loadingSubject.asObservable();
  public lotteries$ = this.lotteriesSubject.asObservable();

  public totalCount: number = 0;

  constructor(private api: Api) {}

  connect(_: CollectionViewer): Observable<LotteryResponse[]> {
    return this.lotteriesSubject.asObservable();
  }

  disconnect(_: CollectionViewer): void {
    this.lotteriesSubject.complete();
    this.loadingSubject.complete();
  }

  loadLotteries(pageIndex: number = 0, pageSize: number = 10) {
    this.loadingSubject.next(true);

    this.api.invoke(getAllLotteriesLotteryAllGet, { page_index: pageIndex, page_size: pageSize })
      .pipe(
        catchError(() => of({items: [], total_count: 0} as PagedLotteryResponse)),
        finalize(() => this.loadingSubject.next(false))
      ).subscribe((data: PagedLotteryResponse) => {
      this.lotteriesSubject.next(data.items);
      this.totalCount = data.total_count;
    });
  }
}
