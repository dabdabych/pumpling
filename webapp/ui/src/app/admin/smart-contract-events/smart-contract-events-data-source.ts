import {CollectionViewer, DataSource} from "@angular/cdk/collections";
import {BehaviorSubject, Observable, catchError, finalize, of} from "rxjs";
import {PagedSmartContractEventResponse, SmartContractEvent, SmartContractEventsService} from "../../shared/smart-contract-events.service";

export class SmartContractEventsDataSource implements DataSource<SmartContractEvent> {
  private eventsSubject = new BehaviorSubject<SmartContractEvent[]>([]);
  private loadingSubject = new BehaviorSubject<boolean>(false);

  public loading$ = this.loadingSubject.asObservable();
  public totalCount = 0;

  constructor(private service: SmartContractEventsService) {}

  connect(_: CollectionViewer): Observable<SmartContractEvent[]> {
    return this.eventsSubject.asObservable();
  }

  disconnect(_: CollectionViewer): void {
    this.eventsSubject.complete();
    this.loadingSubject.complete();
  }

  load(pageIndex: number = 0, pageSize: number = 10) {
    this.loadingSubject.next(true);
    this.service.getEvents(pageIndex, pageSize)
      .pipe(
        catchError(() => of({items: [], total_count: 0} as PagedSmartContractEventResponse)),
        finalize(() => this.loadingSubject.next(false))
      )
      .subscribe(resp => {
        this.eventsSubject.next(resp.items);
        this.totalCount = resp.total_count;
      });
  }
}
