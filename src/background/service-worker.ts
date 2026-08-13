/**
 * Placeholder service worker.
 *
 * The real message handling (visible-area capture, PNG download) lands with
 * the Phase 1 feature work — see the `feat/visible-capture` branch.
 */
chrome.runtime.onInstalled.addListener(() => {
  console.info('[SnapScribe] Service worker installed');
});
