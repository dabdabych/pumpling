import {Component, OnInit, ViewChild} from '@angular/core';
import {MatPaginator} from "@angular/material/paginator";
import {MatSort} from "@angular/material/sort";
import {tap} from "rxjs/operators";
import {SmartContractEventsDataSource} from "./smart-contract-events-data-source";
import {SmartContractEventsService} from "../../shared/smart-contract-events.service";

@Component({
    selector: 'app-smart-contract-events',
    templateUrl: './smart-contract-events.component.html',
    styleUrls: ['./smart-contract-events.component.scss'],
    standalone: false
})
export class SmartContractEventsComponent implements OnInit {
  @ViewChild(MatSort, {static: true}) sort: MatSort;
  @ViewChild(MatPaginator, {static: true}) paginator: MatPaginator;

  dataSource: SmartContractEventsDataSource;
  displayedColumns = ['id', 'event_name', 'signature', 'data', 'created_at'];

  constructor(private eventsService: SmartContractEventsService) {
    this.dataSource = new SmartContractEventsDataSource(eventsService);
  }

  ngOnInit(): void {
    this.dataSource.load(0, 10);
  }

  ngAfterViewInit(): void {
    this.paginator.page
      .pipe(tap(() => this.loadPage()))
      .subscribe();
  }

  loadPage(): void {
    this.dataSource.load(this.paginator.pageIndex, this.paginator.pageSize);
  }

  refresh(): void {
    this.loadPage();
  }
}
