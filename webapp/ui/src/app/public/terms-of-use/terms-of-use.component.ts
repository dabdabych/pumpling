import { Location } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';

@Component({
    selector: 'app-terms-of-use',
    templateUrl: './terms-of-use.component.html',
    styleUrls: ['./terms-of-use.component.scss'],
    standalone: false
})
export class TermsOfUseComponent implements OnInit {

  constructor(
    private readonly location: Location,
    private readonly router: Router
  ) { }

  ngOnInit(): void {
  }

  goBack(): void {
    if (window.history.length > 1) {
      this.location.back();
      return;
    }

    void this.router.navigateByUrl('/');
  }

}
