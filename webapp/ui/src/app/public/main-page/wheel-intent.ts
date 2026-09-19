/**
 * Recognises new intents to scroll in a stream of wheel events, telling a
 * person's gesture from a trackpad's inertia. No DOM: it takes the time and
 * force of an event and returns the direction of a new intent, or 0. That is
 * why the thresholds were chosen not by eye but over thousands of simulated
 * swipes (60 and 120 Hz, frame coalescing, uneven finger force, inertia of
 * various lengths, a pause before the inertia, delivery delays).
 *
 * The basis is established practice (Lethargy, fullPage.js): a new intent is a
 * pause in events or a sustained rise after a decline. The difference is that we
 * compare not the force of an event but the speed: force divided by the time
 * since the previous event. Events arrive unevenly (14 ms, then 19 ms), Chrome
 * coalesces frames, and the force of a single event jumps around even on smooth
 * inertia. Speed does not depend on that, and a random "rise" in the tail does
 * not look like a new swipe.
 *
 *   — a long pause or a change of direction means a new stream, and an intent
 *     as soon as it has accumulated noticeable movement;
 *   — a short pause is not yet a new touch. After a finger lifts, Chrome waits
 *     up to 100 ms for the first inertia event (`mouse_wheel_phase_handler`),
 *     and inertia arrives after silence. The following events decide: inertia
 *     only decays, a new touch accelerates;
 *   — inside a stream, only if the speed fell almost to zero, then rises for
 *     several events in a row, and at least the minimum interval has passed
 *     since the previous intent.
 */

export interface WheelIntentOptions {
  /** The pause between events after which the stream is in question, ms. */
  streamGapMs: number;
  /**
   * A pause longer than this is definitely a new stream, ms. Shorter is a
   * continuation, if the speed after it did not grow. It covers the wait for
   * inertia after a finger lifts (up to 100 ms) and the delivery delay while the
   * page is busy animating: events then pile up and arrive in one chunk.
   */
  continuationMaxMs: number;
  /** How many events after a short pause to watch before deciding, counting the first. */
  settleEvents: number;
  /** How many times the speed has to grow after a short pause for it to be a new touch. */
  settleRise: number;
  /**
   * The first event after a short pause being this many times faster than
   * before means a new touch at once, with no waiting. Inertia is never faster
   * than a finger, but Chrome can coalesce its first two events into one, so the
   * margin is more than double.
   */
  fasterThanBefore: number;
  /** How much movement a new stream needs to count as an intent, px. */
  minDistancePx: number;
  /** A single event at least this large is an intent at once (a mouse wheel click), px. */
  singleEventPx: number;
  /** How many events in a row the speed has to rise inside a stream. */
  risingEvents: number;
  /** How many times the speed has to climb above the minimum after a decline. */
  riseRatio: number;
  /**
   * How deep the decline has to be relative to the peak since the previous
   * intent. A new touch starts almost from zero; the wobbles of a single finger
   * dip shallowly and do not count as a new swipe.
   */
  dipDepth: number;
  /** The minimum between intents inside one stream, ms. */
  minIntentIntervalMs: number;
}

export const DEFAULT_WHEEL_INTENT: WheelIntentOptions = {
  streamGapMs: 60,
  continuationMaxMs: 250,
  settleEvents: 4,
  settleRise: 1.25,
  fasterThanBefore: 3.2,
  minDistancePx: 6,
  singleEventPx: 4,
  risingEvents: 2,
  riseRatio: 2.6,
  dipDepth: 0.08,
  minIntentIntervalMs: 450
};

export interface WheelIntentResult {
  /** The direction of the new intent: 1, −1 or 0. */
  intent: number;
  /** The event opened a new stream: a pause, a change of direction or acceleration after a pause. */
  newStream: boolean;
}

/** A rise and a decline in speed only count if they are clearer than the noise. */
const RISE_STEP = 1.04;
const DECLINE_STEP = 0.97;
/** The bounds on the interval between events when computing speed, ms. */
const MIN_DT_MS = 4;
const MAX_DT_MS = 50;
const NOMINAL_DT_MS = 16.7;
/** The densest event stream there is: 120 Hz. */
const FASTEST_DT_MS = 8.3;
/** How many recent intervals to remember for estimating the event rate. */
const RECENT_DTS = 6;
/**
 * A chunk after a delivery delay carries the same speed as before the pause, if
 * its force is divided by the whole pause.
 */
const CHUNK_MIN_RATIO = 0.5;
const CHUNK_MAX_RATIO = 1.3;

export class WheelIntent {
  private lastTime = -Infinity;
  private lastVelocity = 0;
  private lastDirection = 0;
  /**
   * The recent intervals between this gesture's events. The rate is not
   * constant: 8 ms at 120 Hz, 16 ms at 60 Hz, and half as often when the page is
   * busy animating and Chrome coalesces frames. We do not trust the previous gesture.
   */
  private readonly recentDts: number[] = [];

  private awaitingStart = false;
  private streamDistance = 0;

  private risingRun = 0;
  private declined = false;
  private trough = Infinity;
  private peak = 0;
  private lastIntentAt = -Infinity;

  /** The event number after a short pause, while it is unclear whether this is inertia or a new touch; 0 means clear. */
  private settling = 0;
  private settleVelocity = 0;
  private settleDistance = 0;

  constructor(private readonly options: WheelIntentOptions = DEFAULT_WHEEL_INTENT) {}

  feed(time: number, delta: number): WheelIntentResult {
    const magnitude = Math.abs(delta);
    const direction = Math.sign(delta);
    if (direction === 0) {
      return { intent: 0, newStream: false };
    }
    const options = this.options;
    const gap = time - this.lastTime;
    let velocity: number;
    let newStream = false;

    if (direction !== this.lastDirection || gap > options.continuationMaxMs) {
      if (gap > options.continuationMaxMs) {
        this.recentDts.length = 0;
      }
      this.startStream();
      newStream = true;
      velocity = magnitude / NOMINAL_DT_MS;
    } else if (gap > options.streamGapMs) {
      this.settling = 0;
      // An event after a pause has no interval of its own. We take the speed in
      // two estimates from the gesture's rate: the upper one so that a new
      // touch's acceleration is real, the lower one so that "too fast" is not a
      // rate error.
      const shortestDt = this.recentDts.length ? Math.min(...this.recentDts) : FASTEST_DT_MS;
      const upper = magnitude / shortestDt;
      const lower = magnitude / Math.max(shortestDt, NOMINAL_DT_MS);
      const chunkVelocity = magnitude / gap;
      velocity = lower;
      if (chunkVelocity >= this.lastVelocity * CHUNK_MIN_RATIO && chunkVelocity <= this.lastVelocity * CHUNK_MAX_RATIO) {
        // A delivery delay: all the movement over the pause arrived in one chunk.
        velocity = chunkVelocity;
      } else if (lower > this.lastVelocity * options.fasterThanBefore) {
        this.startStream();
        newStream = true;
      } else {
        this.settling = 1;
        this.settleVelocity = upper;
        this.settleDistance = magnitude;
      }
    } else {
      const dt = Math.min(MAX_DT_MS, Math.max(MIN_DT_MS, gap));
      velocity = magnitude / dt;
      this.recentDts.push(dt);
      if (this.recentDts.length > RECENT_DTS) {
        this.recentDts.shift();
      }
      if (this.settling > 0) {
        this.settling++;
        this.settleDistance += magnitude;
        if (velocity > this.settleVelocity * options.settleRise) {
          // Accelerating — the fingers are back on the trackpad. The stream started with a pause.
          const before = this.settleDistance - magnitude;
          this.startStream();
          this.streamDistance = before;
          newStream = true;
        } else if (this.settling >= options.settleEvents) {
          this.settling = 0;
        }
      }
    }

    if (!newStream) {
      if (velocity > this.lastVelocity * RISE_STEP) {
        this.risingRun++;
      } else {
        if (velocity < this.lastVelocity * DECLINE_STEP) {
          this.declined = true;
        }
        this.risingRun = 0;
      }
    }
    this.peak = Math.max(this.peak, velocity);
    if (this.declined) {
      this.trough = Math.min(this.trough, velocity);
    }
    this.lastTime = time;
    this.lastVelocity = velocity;
    this.lastDirection = direction;

    if (this.awaitingStart) {
      this.streamDistance += magnitude;
      if (this.streamDistance >= options.minDistancePx || magnitude >= options.singleEventPx) {
        this.awaitingStart = false;
        return { intent: this.markIntent(time, direction), newStream };
      }
      return { intent: 0, newStream };
    }
    if (this.settling > 0) {
      return { intent: 0, newStream };
    }

    const risesAgain = this.declined
      && this.risingRun >= options.risingEvents
      && this.trough <= this.peak * options.dipDepth
      && velocity >= this.trough * options.riseRatio
      && time - this.lastIntentAt >= options.minIntentIntervalMs;
    return { intent: risesAgain ? this.markIntent(time, direction) : 0, newStream };
  }

  private startStream(): void {
    this.awaitingStart = true;
    this.streamDistance = 0;
    this.risingRun = 0;
    this.declined = false;
    this.trough = Infinity;
    this.peak = 0;
    this.settling = 0;
  }

  private markIntent(time: number, direction: number): number {
    this.lastIntentAt = time;
    this.declined = false;
    this.risingRun = 0;
    this.trough = Infinity;
    this.peak = 0;
    return direction;
  }
}
