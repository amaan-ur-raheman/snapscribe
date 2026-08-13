/**
 * Typed message contracts for SnapScribe.
 *
 * Three directions, three unions, one file:
 * - `RuntimeRequest` — popup / editor / content script → service worker
 * - `ContentRequest` — service worker → content script
 * - Responses, typed per request via `ResponseFor` / `ContentResponseFor`
 *
 * Every handler switches exhaustively over `type`, so an unhandled message is
 * a compile-time miss instead of a silent no-op.
 */

export type ExportFormat = 'png' | 'jpeg' | 'pdf';

// ---------------------------------------------------------------------------
// Requests sent to the service worker (popup / editor / content script → worker)
// ---------------------------------------------------------------------------

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

/** Ask the page's content script to start a region drag-select. (Phase 3) */
export interface StartRegionSelectionMsg {
  type: 'START_REGION_SELECTION';
  tabId: number;
}

/** Ask the page's content script to start element picking. (Phase 3) */
export interface StartElementSelectionMsg {
  type: 'START_ELEMENT_SELECTION';
  tabId: number;
}

/** Capture the current viewport and return the raw PNG data URL. (Phase 3) */
export interface CaptureViewportMsg {
  type: 'CAPTURE_VIEWPORT';
}

/** Export an existing capture through chrome.downloads. (Phase 1) */
export interface DownloadCaptureMsg {
  type: 'DOWNLOAD_CAPTURE';
  /** PNG data URL of the image to save. */
  dataUrl: string;
  /** Desired filename (extension included); sanitized by the receiver. */
  filename: string;
  /**
   * Export format. Omitted by legacy callers — the worker falls back to the
   * user's default format setting. (Phase 4)
   */
  format?: ExportFormat;
  /** JPEG quality, 0-100. Omitted by legacy callers — falls back to settings. (Phase 4) */
  quality?: number;
}

export type RuntimeRequest =
  | CaptureVisibleMsg
  | CaptureFullPageMsg
  | StartRegionSelectionMsg
  | StartElementSelectionMsg
  | CaptureViewportMsg
  | DownloadCaptureMsg;

// ---------------------------------------------------------------------------
// Requests sent to the content script (service worker → content script)
// ---------------------------------------------------------------------------

/** Measure the page and hide fixed/sticky elements for the strip captures. */
export interface FullPagePrepareMsg {
  type: 'FULL_PAGE_PREPARE';
}

/** Scroll the page to `y` (CSS px) and wait for it to settle. */
export interface FullPageScrollMsg {
  type: 'FULL_PAGE_SCROLL';
  /** Target scroll position in CSS pixels. */
  y: number;
}

/** Restore fixed/sticky elements and the original scroll position. */
export interface FullPageRestoreMsg {
  type: 'FULL_PAGE_RESTORE';
}

/** Enter region drag-select mode; resolves when the user finishes. (Phase 3) */
export interface RegionSelectMsg {
  type: 'REGION_SELECT';
}

/** Enter element-picker mode; resolves when the user clicks an element. (Phase 3) */
export interface ElementSelectMsg {
  type: 'ELEMENT_SELECT';
}

export type ContentRequest =
  FullPagePrepareMsg | FullPageScrollMsg | FullPageRestoreMsg | RegionSelectMsg | ElementSelectMsg;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** A fixed/sticky element's viewport rect in CSS px, captured before hiding. */
export interface FixedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PrepareResponse =
  | {
      ok: true;
      /** Viewport width in CSS px (matches the captured strip width / dpr). */
      clientWidth: number;
      /** Total page height in CSS px. */
      scrollHeight: number;
      /** Viewport height in CSS px — one strip's worth of page. */
      innerHeight: number;
      /** Device pixel ratio of the page. */
      dpr: number;
      /** Fixed/sticky elements hidden for the capture, in viewport CSS px. */
      fixedRects: FixedRect[];
    }
  | { ok: false; error: string };

export type ScrollResponse = { ok: true; scrollY: number } | { ok: false; error: string };

/** Generic ok/error used where the caller does not inspect a payload. */
export type SimpleOkResponse = { ok: true } | { ok: false; error: string };

export type ContentResponseFor<M extends ContentRequest> = M extends { type: 'FULL_PAGE_PREPARE' }
  ? PrepareResponse
  : M extends { type: 'FULL_PAGE_SCROLL' }
    ? ScrollResponse
    : M extends { type: 'FULL_PAGE_RESTORE' | 'REGION_SELECT' | 'ELEMENT_SELECT' }
      ? SimpleOkResponse
      : never;

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

/** Raw viewport capture for the content script to crop. (Phase 3) */
export type ViewportCaptureResponse = { ok: true; dataUrl: string } | { ok: false; error: string };

/** One stitched strip: its image and where to draw it (device pixels). */
export interface StitchedStrip {
  /** Top edge of the strip in device pixels. */
  y: number;
  /** PNG data URL of the strip. */
  dataUrl: string;
}

/** A fixed/sticky element restored over the stitched page (device pixels). */
export interface FixedComposite {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Strip the element's pixels were cropped from (the pre-hide capture). */
  sourceDataUrl: string;
}

/** Everything the popup needs to render the full-page image. */
export interface FullPageStitch {
  /** Canvas dimensions in device pixels. */
  width: number;
  height: number;
  dpr: number;
  strips: StitchedStrip[];
  composites: FixedComposite[];
  sourceUrl: string;
  timestamp: number;
}

export type FullPageCaptureResponse =
  { ok: true; stitch: FullPageStitch } | { ok: false; error: string };

/** Union of every response the service worker can send back. */
export type RuntimeResponse =
  | CaptureResponse
  | DownloadResponse
  | FullPageCaptureResponse
  | ViewportCaptureResponse
  | SimpleOkResponse;

/** Maps a request type to the response the service worker will send back. */
export type ResponseFor<T extends RuntimeRequest> = T extends { type: 'CAPTURE_VISIBLE' }
  ? CaptureResponse
  : T extends { type: 'CAPTURE_FULL_PAGE' }
    ? FullPageCaptureResponse
    : T extends { type: 'DOWNLOAD_CAPTURE' }
      ? DownloadResponse
      : T extends { type: 'CAPTURE_VIEWPORT' }
        ? ViewportCaptureResponse
        : T extends { type: 'START_REGION_SELECTION' | 'START_ELEMENT_SELECTION' }
          ? SimpleOkResponse
          : never;

// ---------------------------------------------------------------------------
// Guards + typed send helpers
// ---------------------------------------------------------------------------

const RUNTIME_REQUEST_TYPES = [
  'CAPTURE_VISIBLE',
  'CAPTURE_FULL_PAGE',
  'START_REGION_SELECTION',
  'START_ELEMENT_SELECTION',
  'CAPTURE_VIEWPORT',
  'DOWNLOAD_CAPTURE',
] as const;

const CONTENT_REQUEST_TYPES = [
  'FULL_PAGE_PREPARE',
  'FULL_PAGE_SCROLL',
  'FULL_PAGE_RESTORE',
  'REGION_SELECT',
  'ELEMENT_SELECT',
] as const;

/** Narrow an unknown payload (from onMessage) to a RuntimeRequest. */
export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && (RUNTIME_REQUEST_TYPES as readonly string[]).includes(type);
}

/** Narrow an unknown payload (from onMessage) to a ContentRequest. */
export function isContentRequest(value: unknown): value is ContentRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && (CONTENT_REQUEST_TYPES as readonly string[]).includes(type);
}

/**
 * Send a typed request to the service worker and await its typed response.
 *
 * @types/chrome types sendMessage as `Promise<any>`; this cast is the single
 * narrowing point for the whole extension — every call site is fully typed.
 */
export function sendRuntimeRequest<T extends RuntimeRequest>(msg: T): Promise<ResponseFor<T>> {
  return chrome.runtime.sendMessage(msg) as Promise<ResponseFor<T>>;
}

/** Send a typed request to a tab's content script and await its typed response. */
export function sendContentRequest<T extends ContentRequest>(
  tabId: number,
  msg: T,
): Promise<ContentResponseFor<T>> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<ContentResponseFor<T>>;
}
