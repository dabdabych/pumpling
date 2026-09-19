import { PoolPhase, PoolSnapshot, formatSol } from '../pool-state';

/**
 * A card that can go into a post: what somebody did, behind which coin, and
 * what happens to that SOL now.
 *
 * Drawn on a canvas in the browser, with no server and no external service. The
 * image goes to a file or to the clipboard, from where it is pasted straight into
 * a post. The coin logo comes from somebody else's domain, so it is only drawn if
 * the server served it with CORS: otherwise the canvas is tainted and the image
 * cannot be exported. If it did not, we draw the initials, as in the coin list.
 *
 * The texts live in a separate pure function: they are checked by a test rather
 * than by eye on a picture.
 */

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 675;

export type ShareKind = 'commit' | 'coin' | 'pool';

export interface ShareCardData {
  kind: ShareKind;
  poolId: number | null;
  phase: PoolPhase;
  ticker: string;
  name: string;
  mint: string;
  logoUrl: string | null;
  /** How much the person committed, in SOL; only for their own card. */
  commitSol: number;
  /** How much stands behind the coin in total, in SOL. */
  coinSol: number;
  /** The coin's share of the pool, 0..1. */
  coinShare: number;
  poolSol: number;
  capSol: number;
  coins: number;
  closesAtMs: number | null;
}

export interface ShareHeadlinePart {
  text: string;
  /** The word on the purple plate — as in the titles on the site. */
  plate?: boolean;
}

export interface ShareCopy {
  headline: ShareHeadlinePart[];
  sub: string;
  stats: Array<{ label: string; value: string }>;
  /** The post text with no link: X adds the link itself. */
  post: string;
}

const SITE = 'pumpling.xyz';

const COLORS = {
  paper: '#FCFCFC',
  ink: '#020202',
  purple: '#AF8FFF',
  green: '#8FFFAF',
  muted: 'rgba(2, 2, 2, 0.66)'
};

/** Card data from the pool state. An empty `mint` means a card about the whole pool. */
export function shareCardData(snapshot: PoolSnapshot, options: { kind: ShareKind; mint?: string; commitSol?: number }): ShareCardData {
  const coin = options.mint ? snapshot.coins.find((item) => item.mint === options.mint) : undefined;
  return {
    kind: options.kind,
    poolId: snapshot.poolId,
    phase: snapshot.phase,
    ticker: coin?.ticker ?? '',
    name: coin?.name ?? '',
    mint: coin?.mint ?? '',
    logoUrl: coin?.logoUrl ?? null,
    commitSol: options.commitSol ?? 0,
    coinSol: coin?.sol ?? 0,
    coinShare: coin?.poolShare ?? 0,
    poolSol: snapshot.totalSol,
    capSol: snapshot.capSol,
    coins: snapshot.coins.length,
    closesAtMs: snapshot.closesAtMs
  };
}

/** What is written on the card and what goes into the post. */
export function shareCardCopy(data: ShareCardData): ShareCopy {
  const ticker = data.ticker ? `$${data.ticker}` : '';
  const commit = formatSol(data.commitSol);
  const behind = formatSol(data.coinSol);
  const pool = formatSol(data.poolSol);

  if (data.kind === 'commit' && ticker) {
    return {
      headline: [{ text: `${commit} SOL behind` }, { text: ticker, plate: true }],
      sub: 'Once SOL is in, nobody can take it back. When the pool closes, it goes into public buys.',
      stats: [
        { label: 'My commit', value: `${commit} SOL` },
        { label: `Behind ${ticker}`, value: `${behind} SOL` },
        { label: 'In the pool', value: `${pool} SOL` }
      ],
      post: `I put ${commit} SOL behind ${ticker} on pumpling. When the pool closes, that SOL goes into public on-chain buys. Nobody can cancel it.`
    };
  }

  if (data.kind === 'coin' && ticker) {
    return {
      headline: [{ text: ticker, plate: true }, { text: 'is in the pool' }],
      sub: `${behind} SOL stands behind it. When the pool closes, that SOL goes into public buys.`,
      stats: [
        { label: 'Behind it', value: `${behind} SOL` },
        { label: 'Share of pool', value: `${Math.round(data.coinShare * 100)}%` },
        { label: 'In the pool', value: `${pool} SOL` }
      ],
      post: `${ticker} is in the pumpling pool with ${behind} SOL behind it. When the pool closes, that SOL goes into public on-chain buys.`
    };
  }

  return {
    headline: [{ text: `${pool} SOL` }, { text: 'goes into buys' }],
    sub: 'Name any Solana memecoin and add SOL. When the pool closes, it goes into public buys.',
    stats: [
      { label: 'In the pool', value: `${pool} SOL` },
      { label: 'Cap', value: `${formatSol(data.capSol)} SOL` },
      { label: 'Coins', value: String(data.coins) }
    ],
    post: `${pool} SOL is in the pumpling pool right now, on its way into public on-chain buys of the coins people named.`
  };
}

/** The time line in the bottom bar: a picture has no timer, so an hour rather than a countdown. */
export function shareCardFooterNote(data: ShareCardData): string {
  switch (data.phase) {
    case 'open':
      return data.closesAtMs !== null ? `Closes ${utcTime(data.closesAtMs)} UTC` : 'Pool is open';
    case 'locked':
      return 'Pool locked · draw';
    case 'buying':
      return 'Buys running';
    case 'done':
      return 'Pool done';
    default:
      return 'Next pool soon';
  }
}

/** A link to the pool; with a coin, so its row is visible at once. */
export function shareCardLink(data: ShareCardData, origin: string): string {
  const base = `${origin.replace(/\/$/, '')}/pool`;
  return data.mint ? `${base}?coin=${data.mint}` : base;
}

export function shareCardFileName(data: ShareCardData): string {
  const coin = data.ticker ? data.ticker.toLowerCase().replace(/[^a-z0-9]/g, '') : 'pool';
  const pool = data.poolId !== null ? `-${data.poolId}` : '';
  return `pumpling-${coin}${pool}.png`;
}

/** Draw the card. The canvas size is set here too. */
export async function drawShareCard(canvas: HTMLCanvasElement, data: ShareCardData): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas is not available');
  }
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;

  await ensureFonts();
  const copy = shareCardCopy(data);
  const [mascot, logo] = await Promise.all([loadImage('assets/images/pumpling-mascot.png'), loadImage(data.logoUrl, true)]);

  ctx.clearRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  drawDots(ctx);

  // The card body with a purple shadow — like the blocks on the site.
  const frame = { x: 34, y: 30, w: SHARE_CARD_WIDTH - 82, h: SHARE_CARD_HEIGHT - 76 };
  ctx.fillStyle = COLORS.purple;
  ctx.fillRect(frame.x + 14, frame.y + 14, frame.w, frame.h);
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
  ctx.lineWidth = 6;
  ctx.strokeStyle = COLORS.ink;
  ctx.strokeRect(frame.x + 3, frame.y + 3, frame.w - 6, frame.h - 6);

  const padX = frame.x + 42;
  const headerBottom = frame.y + 104;
  ctx.beginPath();
  ctx.moveTo(frame.x, headerBottom);
  ctx.lineTo(frame.x + frame.w, headerBottom);
  ctx.lineWidth = 6;
  ctx.stroke();

  // The header: the mark, the name, the pool number.
  if (mascot) {
    ctx.drawImage(mascot, padX, frame.y + 24, 56, 56);
  }
  ctx.fillStyle = COLORS.ink;
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, 700, 34, '-0.02em');
  ctx.fillText('pumpling', padX + 72, frame.y + 70);

  const chip = data.poolId !== null ? `Pool #${data.poolId}` : 'pumpling pool';
  drawChip(ctx, chip.toUpperCase(), frame.x + frame.w - 42, frame.y + 52);

  // Below, everything is measured from the bars: the black bar at the bottom, a
  // row of numbers above it, and the rest of the space for the title and the
  // caption. The text column does not run into the right column with the coin
  // and the mascot.
  const stripH = 66;
  const stripY = frame.y + frame.h - stripH;
  const boxH = 104;
  const boxY = stripY - 30 - boxH;
  const contentTop = headerBottom + 34;
  const contentBottom = boxY - 26;
  const rightColumnW = data.ticker ? 300 : 320;
  const textWidth = frame.w - 84 - rightColumnW - 28;

  // The right column: the coin on top, the mascot under it.
  const rightX = frame.x + frame.w - 42 - rightColumnW;
  const rightBottom = stripY - 12;
  if (logo) {
    const badge = 132;
    drawCoinBadge(ctx, { x: rightX + rightColumnW - badge, y: contentTop + 6, size: badge, logo });
    if (mascot) {
      const size = 200;
      ctx.drawImage(mascot, rightX + rightColumnW - size, rightBottom - size, size, size);
    }
  } else if (mascot) {
    const size = 268;
    ctx.drawImage(mascot, rightX + rightColumnW - size, contentTop + (rightBottom - contentTop - size) / 2, size, size);
  }

  // The title: lines top to bottom, the second word may sit on a plate.
  const subSize = 26;
  const subLineHeight = 36;
  const headlineSize = fitHeadline(ctx, copy.headline, textWidth, contentBottom - contentTop - 2 * subLineHeight - 22);
  setFont(ctx, 500, subSize, '0');
  const subLines = clampLines(wrapText(ctx, copy.sub, textWidth), 2);
  const headlineHeight = copy.headline.length * headlineSize * 1.1;
  const blockHeight = headlineHeight + 18 + subLines.length * subLineHeight;
  let y = contentTop + Math.max(0, (contentBottom - contentTop - blockHeight) / 2) + headlineSize * 0.86;

  for (const part of copy.headline) {
    setFont(ctx, 700, headlineSize, '-0.02em');
    const text = part.text.toUpperCase();
    if (part.plate) {
      const width = ctx.measureText(text).width;
      const plateX = padX - 12;
      const plateY = y - headlineSize * 0.8;
      const plateH = headlineSize * 1.08;
      ctx.fillStyle = COLORS.purple;
      ctx.fillRect(plateX, plateY, width + 24, plateH);
      ctx.lineWidth = 5;
      ctx.strokeStyle = COLORS.ink;
      ctx.strokeRect(plateX + 2.5, plateY + 2.5, width + 19, plateH - 5);
    }
    ctx.fillStyle = COLORS.ink;
    ctx.fillText(text, padX, y);
    y += headlineSize * 1.1;
  }

  // The caption under the title.
  y += 12;
  setFont(ctx, 500, subSize, '0');
  ctx.fillStyle = COLORS.muted;
  for (const line of subLines) {
    ctx.fillText(line, padX, y);
    y += subLineHeight;
  }

  // The numbers in frames.
  const boxW = Math.floor((textWidth - 2 * 16) / 3);
  copy.stats.forEach((item, index) => {
    const x = padX + index * (boxW + 16);
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(x, boxY, boxW, boxH);
    ctx.lineWidth = 5;
    ctx.strokeStyle = COLORS.ink;
    ctx.strokeRect(x + 2.5, boxY + 2.5, boxW - 5, boxH - 5);
    setFont(ctx, 700, 17, '0.08em');
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(item.label.toUpperCase(), x + 18, boxY + 38);
    setFont(ctx, 700, 34, '-0.01em');
    ctx.fillStyle = COLORS.ink;
    ctx.fillText(fitOneLine(ctx, item.value, boxW - 36, 34), x + 18, boxY + 80);
  });

  // The black bar at the bottom: the site address and what the pool is doing.
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(frame.x, stripY, frame.w, stripH);
  setFont(ctx, 700, 26, '0.02em');
  ctx.fillStyle = COLORS.paper;
  ctx.fillText(SITE, padX, stripY + 43);
  setFont(ctx, 700, 20, '0.1em');
  ctx.fillStyle = COLORS.green;
  const note = shareCardFooterNote(data).toUpperCase();
  ctx.fillText(note, frame.x + frame.w - 42 - ctx.measureText(note).width, stripY + 42);
}

export async function shareCardBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    throw new Error('the card could not be turned into a file');
  }
  return blob;
}

// ------------------------------------------------------------------ drawing

function drawDots(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = 'rgba(2, 2, 2, 0.12)';
  for (let x = 16; x < SHARE_CARD_WIDTH; x += 24) {
    for (let y = 16; y < SHARE_CARD_HEIGHT; y += 24) {
      ctx.fillRect(x, y, 2, 2);
    }
  }
}

function drawChip(ctx: CanvasRenderingContext2D, text: string, rightX: number, centerY: number): void {
  setFont(ctx, 700, 20, '0.1em');
  const width = ctx.measureText(text).width + 36;
  const height = 46;
  const x = rightX - width;
  const y = centerY - height / 2;
  ctx.fillStyle = COLORS.green;
  ctx.fillRect(x, y, width, height);
  ctx.lineWidth = 5;
  ctx.strokeStyle = COLORS.ink;
  ctx.strokeRect(x + 2.5, y + 2.5, width - 5, height - 5);
  ctx.fillStyle = COLORS.ink;
  ctx.fillText(text, x + 18, y + 31);
}

function drawCoinBadge(
  ctx: CanvasRenderingContext2D,
  options: { x: number; y: number; size: number; logo: HTMLImageElement }
): void {
  const { x, y, size, logo } = options;
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(x, y, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 4, y + 4, size - 8, size - 8);
  ctx.clip();
  ctx.drawImage(logo, x + 4, y + 4, size - 8, size - 8);
  ctx.restore();
  ctx.lineWidth = 5;
  ctx.strokeStyle = COLORS.ink;
  ctx.strokeRect(x + 2.5, y + 2.5, size - 5, size - 5);
}

function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number, letterSpacing: string): void {
  ctx.font = `${weight} ${size}px Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  // letterSpacing is not available everywhere; without it the card is simply a little wider.
  if ('letterSpacing' in ctx) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = letterSpacing;
  }
}

function fitHeadline(ctx: CanvasRenderingContext2D, parts: ShareHeadlinePart[], maxWidth: number, maxHeight: number): number {
  let size = 84;
  while (size > 40) {
    setFont(ctx, 700, size, '-0.02em');
    const widest = Math.max(...parts.map((part) => ctx.measureText(part.text.toUpperCase()).width + (part.plate ? 24 : 0)));
    if (widest <= maxWidth && parts.length * size * 1.1 <= maxHeight) {
      return size;
    }
    size -= 2;
  }
  return size;
}

function fitOneLine(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let size = startSize;
  while (size > 20) {
    size -= 2;
    setFont(ctx, 700, size, '-0.01em');
    if (ctx.measureText(text).width <= maxWidth) {
      return text;
    }
  }
  return text;
}

/** More lines than fit — the last one ends with an ellipsis. */
function clampLines(lines: string[], max: number): string[] {
  if (lines.length <= max) {
    return lines;
  }
  const kept = lines.slice(0, max);
  kept[max - 1] = `${kept[max - 1].replace(/[.,;:]$/, '')}…`;
  return kept;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

async function ensureFonts(): Promise<void> {
  if (!('fonts' in document)) {
    return;
  }
  try {
    await Promise.all([
      document.fonts.load('700 86px Inter'),
      document.fonts.load('700 34px Inter'),
      document.fonts.load('500 28px Inter')
    ]);
  } catch {
    // Without Inter the card draws in a system font, which is better than nothing.
  }
}

function loadImage(src: string | null, crossOrigin = false): Promise<HTMLImageElement | null> {
  if (!src) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const image = new Image();
    if (crossOrigin) {
      // Without this a foreign image taints the canvas and the file can no longer be exported.
      image.crossOrigin = 'anonymous';
    }
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function utcTime(atMs: number): string {
  const date = new Date(atMs);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}
