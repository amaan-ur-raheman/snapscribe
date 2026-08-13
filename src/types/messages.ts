/**
 * Discriminated union of every message passed between the service worker,
 * the popup, the content script, and the editor via `chrome.runtime.sendMessage`.
 *
 * New capture modes / export flows extend this union; every handler switches
 * exhaustively over `type`, so an unhandled message is a compile-time miss
 * instead of a silent no-op.
 */

export type ExportFormat = 'png' | 'jpeg' | 'pdf';

// --- Requests (sent TO the service worker) ---

/** Capture the visible viewport of a tab. (Phase 1) */
export interface CaptureVisibleMsg {
  type: 'CAPTURE_VISIBLE';
  /** Id of the tab to capture. */
  tabId: number;
}

/** Capture a whole page by scrolling and stitching. (Phase 2) */
export interface CaptureFullPageMsg {
  type: 'CAPTURE_FULL_PAGE';
  tabId: number;
}

/** Capture a user-selected region of the page. (Phase 3) */
export interface CaptureRegionMsg {
  type: 'CAPTURE_REGION';
  tabId: number;
}

/** Capture a user-picked DOM element. (Phase 3) */
export interface CaptureElementMsg {
  type: 'CAPTURE_ELEMENT';
  tabId: number;
}

/** Export an existing capture through chrome.downloads. (Phase 1) */
export interface DownloadCaptureMsg {
  type: 'DOWNLOAD_CAPTURE';
  /** PNG/JPEG data URL of the image to save. */
  dataUrl: string;
  /** Desired filename (extension included); sanitized by the receiver. */
  filename: string;
}

export type RuntimeRequest =
  | CaptureVisibleMsg
  | CaptureFullPageMsg
  | CaptureRegionMsg
  | CaptureElementMsg
  | DownloadCaptureMsg;

// --- Responses (sent back by the service worker) ---

/** Shape shared by every successful capture, whatever the source. */
export interface CaptureResult {
  format: ExportFormat;
  /** Pixel dimensions of the captured image. */
  width: number;
  height: number;
  /** Device pixel ratio of the source page (1 on standard-density displays). */
  dpr: number;
  /** Data URL of the captured image. */
  dataUrl: string;
  /** URL of the page that was captured. */
  sourceUrl: string;
  /** Capture timestamp, epoch milliseconds. */
  timestamp: number;
}

export type CaptureResponse = { ok: true; result: CaptureResult } | { ok: false; error: string };

export type DownloadResponse = { ok: true; downloadId?: number } | { ok: false; error: string };

/** Union of every response the service worker can send back. */
export type RuntimeResponse = CaptureResponse | DownloadResponse;

/** Maps a request type to the response the service worker will send back. */
export type ResponseFor<T extends RuntimeRequest> = T extends {
  type: 'CAPTURE_VISIBLE' | 'CAPTURE_FULL_PAGE' | 'CAPTURE_REGION' | 'CAPTURE_ELEMENT';
}
  ? CaptureResponse
  : T extends { type: 'DOWNLOAD_CAPTURE' }
    ? DownloadResponse
    : never;

/** Narrow an unknown payload (from onMessage) to a RuntimeRequest. */
export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    typeof type === 'string' &&
    [
      'CAPTURE_VISIBLE',
      'CAPTURE_FULL_PAGE',
      'CAPTURE_REGION',
      'CAPTURE_ELEMENT',
      'DOWNLOAD_CAPTURE',
    ].includes(type)
  );
}

/**
 * Send a typed request and await the matching typed response.
 *
 * @types/chrome types sendMessage as `Promise<any>`; this cast is the single
 * narrowing point for the whole extension — every call site is fully typed.
 */
export function sendRuntimeRequest<T extends RuntimeRequest>(msg: T): Promise<ResponseFor<T>> {
  return chrome.runtime.sendMessage(msg) as Promise<ResponseFor<T>>;
}
