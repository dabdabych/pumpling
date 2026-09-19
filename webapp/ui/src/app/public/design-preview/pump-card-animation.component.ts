import { ChangeDetectionStrategy, Component } from '@angular/core';

interface PumpCandle {
  readonly x: number;
  readonly yHigh: number;
  readonly yLow: number;
  readonly bodyY: number;
  readonly bodyHeight: number;
  readonly isBull: boolean;
  readonly hasWick: boolean;
  readonly delayMs: number;
}

const CANDLE_MOVES = [8, -7, 11, 6, -12, -8, 10, 13, 8, 9, 7, 10];
const CANDLE_RANGES = [13, 11, 15, 12, 16, 13, 14, 17, 12, 14, 15, 16];
const CHART_WIDTH = 360;
const CHART_HEIGHT = 132;
const TOP_PADDING = 12;
const BOTTOM_PADDING = 14;
const BODY_WIDTH = 18;
const CANDLE_Y_OFFSETS = [0, 0, 0, 0, 18, 0, 0, 0, 0, 0, 0, 0];
const CANDLES_WITHOUT_WICKS = new Set([1, 3, 8, 10]);

type CandleModel = {
  open: number;
  high: number;
  low: number;
  close: number;
};

function buildCandles(): CandleModel[] {
  let open = 92;

  return CANDLE_MOVES.map((move, index) => {
    const close = open + move;
    const range = CANDLE_RANGES[index];
    const high = Math.max(open, close) + range * 0.58;
    const low = Math.min(open, close) - range * 0.42;
    const candle = { open, high, low, close };

    open = close;

    return candle;
  });
}

function scalePrice(price: number, min: number, max: number): number {
  const usableHeight = CHART_HEIGHT - TOP_PADDING - BOTTOM_PADDING;
  return TOP_PADDING + ((max - price) / (max - min)) * usableHeight;
}

const candleModels = buildCandles();
const minPrice = Math.min(...candleModels.map((candle) => candle.low));
const maxPrice = Math.max(...candleModels.map((candle) => candle.high));
const candleGap = CHART_WIDTH / candleModels.length;

const PUMP_CANDLES: PumpCandle[] = candleModels.map((candle, index) => {
  const x = candleGap * index + candleGap / 2;
  const yOffset = CANDLE_Y_OFFSETS[index];
  const yHigh = scalePrice(candle.high, minPrice, maxPrice) + yOffset;
  const yLow = scalePrice(candle.low, minPrice, maxPrice) + yOffset;
  const yOpen = scalePrice(candle.open, minPrice, maxPrice) + yOffset;
  const yClose = scalePrice(candle.close, minPrice, maxPrice) + yOffset;
  const bodyY = Math.min(yOpen, yClose);
  const bodyHeight = Math.max(4, Math.abs(yClose - yOpen));

  return {
    x,
    yHigh,
    yLow,
    bodyY,
    bodyHeight,
    isBull: candle.close >= candle.open,
    hasWick: !CANDLES_WITHOUT_WICKS.has(index),
    delayMs: index * 300
  };
});

const PRICE_LINE_PATH = candleModels
  .map((candle, index) => {
    const x = candleGap * index + candleGap / 2;
    const y = scalePrice(candle.close, minPrice, maxPrice) + CANDLE_Y_OFFSETS[index];
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  })
  .join(' ');

@Component({
  selector: 'app-pump-card-animation',
  templateUrl: './pump-card-animation.component.html',
  styleUrls: ['./pump-card-animation.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class PumpCardAnimationComponent {
  readonly chartWidth = CHART_WIDTH;
  readonly chartHeight = CHART_HEIGHT;
  readonly bodyWidth = BODY_WIDTH;
  readonly candles = PUMP_CANDLES;
  readonly priceLinePath = PRICE_LINE_PATH;
}
