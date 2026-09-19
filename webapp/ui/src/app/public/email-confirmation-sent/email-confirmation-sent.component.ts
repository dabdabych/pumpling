import {Component, OnInit} from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';

@Component({
  selector: 'app-email-confirmation-sent',
  templateUrl: './email-confirmation-sent.component.html',
  styleUrls: ['./email-confirmation-sent.component.scss'],
  standalone: false
})
export class EmailConfirmationSentComponent implements OnInit {
  email = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
  }

  ngOnInit(): void {
    this.email = this.route.snapshot.queryParamMap.get('email') || '';
  }

  async close(): Promise<void> {
    await this.router.navigate(['/']);
  }
}
