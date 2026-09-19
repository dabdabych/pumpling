import {APP_INITIALIZER, NgModule} from '@angular/core';
import {CommonModule} from '@angular/common';
import { HTTP_INTERCEPTORS, HttpClient, provideHttpClient, withInterceptorsFromDi } from "@angular/common/http";
import {environment} from "../../environments/environment";
import {TokenInterceptor} from "../token.interceptor";
import {NgrxBusyModule} from 'ngrx-busy';
import {MatIconModule} from "@angular/material/icon";
import {MatCardModule} from "@angular/material/card";
import {MatTableModule} from "@angular/material/table";
import {MatPaginatorModule} from "@angular/material/paginator";
import {MatSortModule} from "@angular/material/sort";
import {MatMenuModule} from "@angular/material/menu";
import {MatProgressBarModule} from "@angular/material/progress-bar";
import {MatDialogModule} from "@angular/material/dialog";
import {MatFormFieldModule} from "@angular/material/form-field";
import {MatInputModule} from "@angular/material/input";
import {MatButtonModule} from "@angular/material/button";
import {MatProgressSpinnerModule} from "@angular/material/progress-spinner";
import {MatTabsModule} from "@angular/material/tabs";
import {MatSelectModule} from "@angular/material/select";
import {MatDatepickerModule} from "@angular/material/datepicker";
import {MatNativeDateModule} from "@angular/material/core";
import {MatTimepickerModule} from "@angular/material/timepicker";
import {BusyInterceptor} from "./busy.interceptor";
import {SystemDialogModule} from "./system-dialog";
import {ErrorInterceptor} from "./error.interceptor";
import { PasswordValidatorDirective } from './directives/password-validator.directive';
import { MiniChartComponent } from './components/mini-chart/mini-chart.component';

export function initEnv() {
  return () => fetch('environment.json')
    .then(response => response.ok ? response.json() : Promise.reject())
    .then(body => Object.keys(body).forEach(key => environment[key] = body[key]))
    .catch(() => {
    });
}


const material = [
  MatIconModule,
  MatTableModule,
  MatSortModule,
  MatPaginatorModule,
  MatCardModule,
  MatMenuModule,
  MatDialogModule,
  MatProgressBarModule,
  MatFormFieldModule,
  MatInputModule,
  MatButtonModule,
  MatProgressSpinnerModule,
  MatTabsModule,
  MatSelectModule,
  MatDatepickerModule,
  MatNativeDateModule,
  MatTimepickerModule
];

const modules = [
  ...material,
];

@NgModule({ declarations: [
        MiniChartComponent
    ],
    exports: [...modules, NgrxBusyModule, PasswordValidatorDirective, MiniChartComponent], imports: [CommonModule,
        PasswordValidatorDirective,
        NgrxBusyModule,
        MatIconModule,
        MatCardModule,
        MatTableModule,
        MatPaginatorModule,
        MatProgressBarModule,
        MatDatepickerModule,
        MatNativeDateModule,
        MatTimepickerModule,
        SystemDialogModule], providers: [
        { provide: HTTP_INTERCEPTORS, useClass: BusyInterceptor, multi: true },
        { provide: HTTP_INTERCEPTORS, useClass: TokenInterceptor, multi: true },
        { provide: HTTP_INTERCEPTORS, useClass: ErrorInterceptor, multi: true },
        { provide: APP_INITIALIZER, useFactory: initEnv, deps: [HttpClient], multi: true },
        provideHttpClient(withInterceptorsFromDi())
    ] })
export class SharedModule { }
