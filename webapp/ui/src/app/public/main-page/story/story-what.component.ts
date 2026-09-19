import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild } from '@angular/core';

/**
 * "What is it?" — a thought experiment in three beats: a post promising to buy,
 * a paid caller's post, and the pumpling pool card. The beats are animated by the
 * story timeline on the main page through `data-what-*` attributes; here there is
 * only the markup and the live timer on the pool card.
 */
@Component({
  selector: 'app-story-what',
  standalone: true,
  templateUrl: './story-what.component.html',
  styleUrls: ['./story-what.component.scss']
})
export class StoryWhatComponent implements AfterViewInit, OnDestroy {
  @ViewChild('timer') timerRef?: ElementRef<HTMLElement>;

  private intervalId = 0;
  private secondsLeft = 59 * 60 + 12;

  constructor(private readonly zone: NgZone) {}

  ngAfterViewInit(): void {
    // The timer is decorative and ticks outside Angular: it does not need change
    // detection over the whole page every second.
    this.zone.runOutsideAngular(() => {
      this.intervalId = window.setInterval(() => {
        this.secondsLeft = this.secondsLeft > 0 ? this.secondsLeft - 1 : 59 * 60 + 59;
        const minutes = Math.floor(this.secondsLeft / 60);
        const seconds = this.secondsLeft % 60;
        if (this.timerRef) {
          this.timerRef.nativeElement.textContent = `00:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
      }, 1000);
    });
  }

  ngOnDestroy(): void {
    window.clearInterval(this.intervalId);
  }
}
