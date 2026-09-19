import { Component, Input, OnInit, ElementRef, ViewChild, AfterViewInit, OnDestroy } from '@angular/core';
import Two from 'two.js';

interface PricePoint {
  timestamp: number;
  price: number;
}

@Component({
    selector: 'app-mini-chart',
    template: `<div #chartContainer class="mini-chart-container"></div>`,
    styleUrls: ['./mini-chart.component.scss'],
    standalone: false
})
export class MiniChartComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chartContainer', { static: true }) chartContainer!: ElementRef;
  @Input() priceHistory: PricePoint[] = [];
  @Input() width: number = 120;
  @Input() height: number = 50;
  @Input() isPositive: boolean = true;

  private two?: Two;

  ngOnInit(): void {}

  ngAfterViewInit(): void {
    this.createChart();
  }

  ngOnDestroy(): void {
    if (this.two) {
      this.two.clear();
    }
  }

  private createChart(): void {
    if (!this.priceHistory || this.priceHistory.length === 0) return;

    // Initialize Two.js
    this.two = new Two({
      width: this.width,
      height: this.height,
      type: Two.Types.svg
    }).appendTo(this.chartContainer.nativeElement);

    // Calculate min/max for scaling
    const prices = this.priceHistory.map(p => p.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice;

    // Create path points
    const points: any[] = [];
    const padding = 2;

    this.priceHistory.forEach((point, index) => {
      const x = (index / (this.priceHistory.length - 1)) * (this.width - padding * 2) + padding;
      const y = this.height - padding - ((point.price - minPrice) / priceRange) * (this.height - padding * 2);
      points.push(new Two.Anchor(x, y));
    });

    // Create the line path
    const path = new Two.Path(points, false, false);
    path.stroke = this.isPositive ? '#10b981' : '#ef4444'; // Green for positive, red for negative
    path.linewidth = 1.5;
    path.fill = 'transparent';
    path.cap = 'round';
    path.join = 'round';

    // Create gradient fill area
    const fillPoints = [...points];
    fillPoints.push(new Two.Anchor(this.width - padding, this.height - padding));
    fillPoints.push(new Two.Anchor(padding, this.height - padding));

    const fillPath = new Two.Path(fillPoints, false, true);
    fillPath.fill = this.isPositive ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
    fillPath.stroke = 'transparent';

    // Add to scene
    this.two.add(fillPath);
    this.two.add(path);

    // Render
    this.two.update();
  }
}