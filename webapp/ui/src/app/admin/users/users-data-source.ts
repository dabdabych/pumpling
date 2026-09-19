import {CollectionViewer, DataSource} from "@angular/cdk/collections";
import {BehaviorSubject, catchError, finalize, Observable, of} from "rxjs";
import { Api } from "../../api-client/api";
import { getAllUsersAuthUsersGet } from "../../api-client/fn/auth/get-all-users-auth-users-get";
import { PagedUserResponse } from "../../api-client/models/paged-user-response";
import { UserResponse } from "../../api-client/models/user-response";

export class UsersDataSource implements DataSource<UserResponse> {

  private usersSubject = new BehaviorSubject<UserResponse[]>([]);
  private loadingSubject = new BehaviorSubject<boolean>(false);

  public loading$ = this.loadingSubject.asObservable();
  public users$ = this.usersSubject.asObservable();

  public totalCount: number = 0;

  constructor(private api: Api) {}

  connect(_: CollectionViewer): Observable<UserResponse[]> {
    return this.usersSubject.asObservable();
  }

  disconnect(_: CollectionViewer): void {
    this.usersSubject.complete();
    this.loadingSubject.complete();
  }

  loadUsers(pageIndex: number = 0, pageSize: number = 10) {
    this.loadingSubject.next(true);

    this.api.invoke(getAllUsersAuthUsersGet, { page_index: pageIndex, page_size: pageSize })
      .pipe(
        catchError(() => of({items: [], total_count: 0} as PagedUserResponse)),
        finalize(() => this.loadingSubject.next(false))
      ).subscribe((data: PagedUserResponse) => {
      this.usersSubject.next(data.items);
      this.totalCount = data.total_count;
    });
  }
}
