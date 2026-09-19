/**
 * Data for the "How it works" scenes: the round's coins and the commit feed.
 *
 * It is all made up and kept apart from the component, because it is a script
 * rather than state: the animations run on it and it can be checked by a test.
 * The amounts are chosen so the pool on the first scene grows from 13 to 73 SOL
 * over exactly one pass of the feed, after which the cycle starts again with a
 * new pool number.
 */

export interface StoryCoin {
  ticker: string;
  fill: string;
  glyph: 'face' | 'toad' | 'bolt' | 'snack' | 'blob' | 'bear' | 'moon' | 'rush';
}

export const MOCHI: StoryCoin = { ticker: '$MOCHI', fill: '#FFB25F', glyph: 'face' };
export const TOAD: StoryCoin = { ticker: '$TOAD', fill: '#8FFFAF', glyph: 'toad' };
export const ZAPZ: StoryCoin = { ticker: '$ZAPZ', fill: '#7DE7FF', glyph: 'bolt' };
export const NURG: StoryCoin = { ticker: '$NURG', fill: '#FFD36A', glyph: 'snack' };
export const GLOOP: StoryCoin = { ticker: '$GLOOP', fill: '#AF8FFF', glyph: 'blob' };
export const PENA: StoryCoin = { ticker: '$PENA', fill: '#FF9ECF', glyph: 'bear' };
export const LUNI: StoryCoin = { ticker: '$LUNI', fill: '#C9D4FF', glyph: 'moon' };
export const RUSH: StoryCoin = { ticker: '$RUSH', fill: '#9BE86B', glyph: 'rush' };

export const STORY_COINS: StoryCoin[] = [MOCHI, TOAD, ZAPZ, NURG, GLOOP, PENA, LUNI, RUSH];

export interface StoryCommit {
  coin: StoryCoin;
  /** The SOL of this commit. */
  sol: number;
  wallet: string;
}

/**
 * Three commits already in the pool when we look at it: the feed never starts
 * with an empty list and always holds three rows. Their amounts are part of the
 * starting 13 SOL.
 */
export const STORY_SEED_COMMITS: StoryCommit[] = [
  { coin: LUNI, sol: 1.6, wallet: 'Fw2…7r' },
  { coin: NURG, sol: 0.9, wallet: 'Kp5…3a' },
  { coin: TOAD, sol: 2.4, wallet: 'Rx8…m4' }
];

/**
 * Forty commits of one round: different wallets, different amounts, eight coins.
 * They add up to exactly 60 SOL, which takes the pool from 13 to 73.
 *
 * Every amount is a multiple of 0.1 deliberately. The card shows the pool to one
 * decimal, and a 0.75 SOL commit would turn it into a lie: the total would round
 * up and the next commit would "correct" it after the fact.
 */
export const STORY_COMMITS: StoryCommit[] = [
  { coin: MOCHI, sol: 2.0, wallet: '7xQ…p2' },
  { coin: TOAD, sol: 0.5, wallet: 'Bn4…zK' },
  { coin: NURG, sol: 1.2, wallet: 'Ge9…4t' },
  { coin: ZAPZ, sol: 3.0, wallet: '9Lm…a1' },
  { coin: GLOOP, sol: 0.8, wallet: 'Qv2…6h' },
  { coin: MOCHI, sol: 1.5, wallet: '3Fh…9w' },
  { coin: PENA, sol: 0.9, wallet: 'Lk8…3d' },
  { coin: RUSH, sol: 2.4, wallet: 'Tz5…mB' },
  { coin: TOAD, sol: 1.1, wallet: 'Wq7…8n' },
  { coin: LUNI, sol: 0.6, wallet: 'Hy3…c4' },
  { coin: MOCHI, sol: 4.0, wallet: 'Rp6…kS' },
  { coin: NURG, sol: 0.3, wallet: 'Vn1…2x' },
  { coin: ZAPZ, sol: 1.8, wallet: 'Ms4…7j' },
  { coin: GLOOP, sol: 2.2, wallet: 'Dc9…5r' },
  { coin: PENA, sol: 0.5, wallet: 'Yb2…qA' },
  { coin: MOCHI, sol: 1.3, wallet: 'Nu8…w3' },
  { coin: RUSH, sol: 0.8, wallet: 'Ax6…t9' },
  { coin: TOAD, sol: 3.5, wallet: 'Jd3…5f' },
  { coin: LUNI, sol: 1.4, wallet: 'Ep7…hV' },
  { coin: NURG, sol: 2.6, wallet: 'Cs2…8u' },
  { coin: MOCHI, sol: 0.4, wallet: 'Bq9…3m' },
  { coin: ZAPZ, sol: 1.1, wallet: 'Fk1…6y' },
  { coin: GLOOP, sol: 0.7, wallet: 'Zt8…4p' },
  { coin: PENA, sol: 2.9, wallet: 'Ih5…9c' },
  { coin: TOAD, sol: 0.6, wallet: 'Or3…2v' },
  { coin: MOCHI, sol: 5.0, wallet: 'Kw7…nD' },
  { coin: RUSH, sol: 1.2, wallet: 'Sg4…8e' },
  { coin: LUNI, sol: 0.3, wallet: 'Ud6…5k' },
  { coin: NURG, sol: 1.7, wallet: 'Pm2…7q' },
  { coin: ZAPZ, sol: 2.0, wallet: 'Xf9…3b' },
  { coin: GLOOP, sol: 0.6, wallet: 'Nc4…6z' },
  { coin: MOCHI, sol: 1.9, wallet: 'Ty1…8g' },
  { coin: PENA, sol: 0.4, wallet: 'Aw5…2s' },
  { coin: TOAD, sol: 2.7, wallet: 'Lv8…4h' },
  { coin: RUSH, sol: 1.0, wallet: 'Bd3…9t' },
  { coin: LUNI, sol: 1.3, wallet: 'Qk6…5n' },
  { coin: NURG, sol: 0.9, wallet: 'Jz2…7w' },
  { coin: MOCHI, sol: 2.1, wallet: 'Vr7…3j' },
  { coin: ZAPZ, sol: 0.6, wallet: 'Hn9…6d' },
  { coin: GLOOP, sol: 0.2, wallet: 'Em4…8x' }
];

/**
 * The purchases for the buying scene: a feed that also always holds three rows.
 * The amounts differ and the time runs back from the last purchase.
 */
export interface StoryBuy {
  /** How much SOL went into this purchase. */
  sol: number;
  /** Which coin was bought: there are three in the round, and that has to be visible. */
  coin: StoryCoin;
  tx: string;
}

export const STORY_BUYS: StoryBuy[] = [
  { sol: 4.2, coin: MOCHI, tx: '5Hq…k2P' },
  { sol: 3.1, coin: TOAD, tx: 'Dw8…4nR' },
  { sol: 2.8, coin: MOCHI, tx: 'Kt2…9sM' },
  { sol: 5.0, coin: ZAPZ, tx: 'Ye4…1bQ' },
  { sol: 2.4, coin: MOCHI, tx: 'Mn7…6xL' },
  { sol: 4.6, coin: TOAD, tx: 'Ph3…8dV' },
  { sol: 3.3, coin: ZAPZ, tx: 'Cz9…5tR' },
  { sol: 3.9, coin: MOCHI, tx: 'Ab6…2kW' },
  { sol: 2.7, coin: TOAD, tx: 'Gv1…9nH' },
  { sol: 3.5, coin: ZAPZ, tx: 'Ts5…4jF' }
];

/** How much SOL goes into the buying after the fee: the same 97 as on the third scene. */
export const BUY_BUDGET_SOL = 97;
/** How much has already been bought when the scene starts. */
export const BUY_START_SOL = 26;

/** How much SOL is in the pool at the start of the feed and at the end. */
export const POOL_START_SOL = 13;
export const POOL_END_SOL = POOL_START_SOL + STORY_COMMITS.reduce((sum, commit) => sum + commit.sol, 0);
