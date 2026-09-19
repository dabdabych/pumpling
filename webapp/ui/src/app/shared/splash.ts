/**
 * The link to the splash screen from index.html.
 *
 * The splash leaves once the app has said "ready" and nobody is holding it. A
 * page that needs time to build its first screen (the main page builds the story
 * and waits for images) holds the splash itself and releases it when the screen is
 * ready: otherwise you would see it being assembled from under the departing splash.
 */

interface PumplingSplash {
  hold(): void;
  release(): void;
  ready(): void;
}

declare global {
  interface Window {
    pumplingSplash?: PumplingSplash;
  }
}

/** The splash is still on screen. */
export function isSplashActive(): boolean {
  return document.documentElement.classList.contains('qres-splash-active');
}

export function holdSplash(): void {
  window.pumplingSplash?.hold();
}

export function releaseSplash(): void {
  window.pumplingSplash?.release();
}

/** The app started and showed its first route. */
export function markAppReady(): void {
  window.pumplingSplash?.ready();
}

/** The splash has started leaving: the moment to bring the first screen through. */
export function onSplashExit(callback: () => void): () => void {
  window.addEventListener('pumpling:splash-exit', callback, { once: true });
  return () => window.removeEventListener('pumpling:splash-exit', callback);
}
