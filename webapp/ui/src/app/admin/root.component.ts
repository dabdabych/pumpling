import {Component, OnInit, ViewEncapsulation} from '@angular/core';
import {Router} from "@angular/router";
import {Store} from "@ngrx/store";
import {IAppState} from "../store/state/app.state";
import {authSelector} from "../store/selectors/auth";
import {signOut} from "../store/actions/auth";
import {Observable} from "rxjs";
import {SignOutConfirm, SystemDialog} from "../shared/system-dialog";

@Component({
    selector: 'app-root',
    templateUrl: './root.component.html',
    styleUrls: ['./root.component.scss'],
    encapsulation: ViewEncapsulation.None,
    standalone: false
})
export class RootComponent implements OnInit {
  isAuth$: Observable<boolean>;

  constructor(private router:Router,
              private store: Store<IAppState>,
              private systemDialog: SystemDialog) {
    this.isAuth$ = this.store.select(authSelector);
  }

  ngOnInit(){
  }

  async logout() {
    const isOk = await this.systemDialog.confirm(`Are you sure you want to log out?`, SignOutConfirm);
    if (!isOk) { return; }

    localStorage.removeItem("jwt");
    this.store.dispatch(signOut())
    await this.router.navigate([""]);
  }
}
