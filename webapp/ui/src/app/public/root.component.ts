import {Component, OnInit, ViewEncapsulation} from '@angular/core';

@Component({
    selector: 'app-root',
    templateUrl: './root.component.html',
    styleUrls: ['./root.component.scss'],
    encapsulation: ViewEncapsulation.None,
    standalone: false
})
export class RootComponent implements OnInit {

  constructor() {

  }

  ngOnInit(){
  }
}
