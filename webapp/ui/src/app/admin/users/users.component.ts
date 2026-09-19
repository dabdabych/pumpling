import {Component, OnInit, ViewChild} from '@angular/core';
import { Api } from "../../api-client/api";
import { UserResponse } from "../../api-client/models/user-response";
import {MatSort} from "@angular/material/sort";
import {MatPaginator, PageEvent} from "@angular/material/paginator";
import {UsersDataSource} from "./users-data-source";
import {tap} from "rxjs/operators";

@Component({
    selector: 'app-users',
    templateUrl: './users.component.html',
    styleUrls: ['./users.component.scss'],
    standalone: false
})
export class UsersComponent implements OnInit {
  @ViewChild(MatSort, {static: true}) sort: MatSort;
  @ViewChild(MatPaginator, {static: true}) paginator: MatPaginator;

  dataSource: UsersDataSource;
  displayedColumns = ['id', 'username', 'email', 'role', 'action'];

  constructor(private api: Api) {
    this.dataSource = new UsersDataSource(api);
  }

  ngOnInit(): void {
    this.dataSource.loadUsers(0, 10);
  }

  ngAfterViewInit(): void {
    this.paginator.page
      .pipe(
        tap(() => this.loadUsersPage())
      )
      .subscribe();
  }

  loadUsersPage(): void {
    this.dataSource.loadUsers(
      this.paginator.pageIndex,
      this.paginator.pageSize
    );
  }

  refresh(): void {
    this.loadUsersPage();
  }
}
