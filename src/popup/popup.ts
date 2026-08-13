import { buildFilename, extensionFor, hostnameOf } from '../lib/filename';
import { stitchFullPage } from '../lib/stitcher';
import { getSettings } from '../lib/storage';
import { sendRuntimeRequest } from '../types/messages';
import type { CaptureResult, ExportFormat } from '../types/messages';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const captureVisibleButton = $<HTMLButtonElement>('capture-visible');
const captureFullPageButton = $<HTMLButtonElement>('capture-full-page');
const captureRegionButton = $<HTMLButtonElement>('capture-region');
const captureElementButton = $<HTMLButtonElement>('capture-element');
const downloadButton = $<HTMLButtonElement>('download');
const copyButton = $<HTMLButtonElement>('copy');
const formatPngButton = $<HTMLButtonElement>('format-png');
const formatJpegButton = $<HTMLButtonElement>('format-jpeg');
const formatPdfButton = $<HTMLButtonElement>('format-pdf');
const qualityRow = $<HTMLElement>('quality-row');
const qualityInput = $<HTMLInputElement>('quality');
const qualityValue = $<HTMLElement>('quality-value');
const resultSection = $<HTMLElement>('result');
const previewImage = $<HTMLImageElement>('preview');
const dimensionsLabel = $<HTMLElement>('meta-dimensions');
const siteLabel = $<HTMLElement>('meta-site');
const statusLabel = $<HTMLElement>('status');

/** Enough of a capture to preview and export. */
type Presentable = Pick<CaptureResult, 'dataUrl' | 'width' | 'height' | 'sourceUrl'>;

let lastCapture: Presentable | null = null;
let exportFormat: ExportFormat = 'png';
let jpegQuality = 90;

captureVisibleButton.addEventListener('click', () => void onCaptureVisibleClick());
captureFullPageButton.addEventListener('click', () => void onCaptureFullPageClick());
captureRegionButton.addEventListener('click', () => void onRegionClick());
captureElementButton.addEventListener('click', () => void onElementClick());
downloadButton.addEventListener('click', () => void onDownloadClick());
copyButton.addEventListener('click', () => void onCopyClick());

const formatButtons: Record<ExportFormat, HTMLButtonElement> = {
  png: formatPngButton,
  jpeg: formatJpegButton,
  pdf: formatPdfButton,
};

for (const format of ['png', 'jpeg', 'pdf'] as const) {
  formatButtons[format].addEventListener('click', () => selectFormat(format));
}
qualityInput.addEventListener('input', () => {
  jpegQuality = Number(qualityInput.value);
  qualityValue.textContent = String(jpegQuality);
});

// Seed the export controls from the user's settings.
void (async () => {
  const settings = await getSettings();
  exportFormat = settings.defaultFormat;
  jpegQuality = settings.jpegQuality;
  qualityInput.value = String(jpegQuality);
  qualityValue.textContent = String(jpegQuality);
  selectFormat(exportFormat);
})();

async function onCaptureVisibleClick(): Promise<void> {
  const tab = await currentTab();
  if (!tab?.id) {
    setStatus('No active tab to capture.', true);
    return;
  }
  setStatus('Capturing…');
  captureVisibleButton.disabled = true;
  try {
    const response = await sendRuntimeRequest({ type: 'CAPTURE_VISIBLE', tabId: tab.id });
    if (!response.ok) {
      setStatus(response.error, true);
      return;
    }
    presentCapture(response.result);
    setStatus('Captured ✓');
  } catch (error) {
    setStatus(errorMessage(error), true);
  } finally {
    captureVisibleButton.disabled = false;
  }
}

async function onCaptureFullPageClick(): Promise<void> {
  const tab = await currentTab();
  if (!tab?.id) {
    setStatus('No active tab to capture.', true);
    return;
  }
  if (!isCapturableUrl(tab.url)) {
    setStatus('SnapScribe cannot run on this page (browser-internal page).', true);
    return;
  }
  setStatus('Capturing full page…');
  captureFullPageButton.disabled = true;
  try {
    const response = await sendRuntimeRequest({ type: 'CAPTURE_FULL_PAGE', tabId: tab.id });
    if (!response.ok) {
      setStatus(response.error, true);
      return;
    }
    setStatus('Stitching strips…');
    const dataUrl = await stitchFullPage(response.stitch);
    presentCapture({
      dataUrl,
      width: response.stitch.width,
      height: response.stitch.height,
      sourceUrl: response.stitch.sourceUrl,
    });
    setStatus('Captured ✓');
  } catch (error) {
    setStatus(errorMessage(error), true);
  } finally {
    captureFullPageButton.disabled = false;
  }
}

async function onRegionClick(): Promise<void> {
  await beginSelection('START_REGION_SELECTION');
}

async function onElementClick(): Promise<void> {
  await beginSelection('START_ELEMENT_SELECTION');
}

/**
 * Hand the capture over to the content script and close the popup — the
 * popup would lose focus the moment the user interacts with the page.
 * The response is moot (the popup is closing), so errors are ignored.
 */
async function beginSelection(
  type: 'START_REGION_SELECTION' | 'START_ELEMENT_SELECTION',
): Promise<void> {
  const tab = await currentTab();
  if (!tab?.id) {
    setStatus('No active tab to capture.', true);
    return;
  }
  if (!isCapturableUrl(tab.url)) {
    setStatus('SnapScribe cannot run on this page (browser-internal page).', true);
    return;
  }
  setStatus('Select an area on the page…');
  void sendRuntimeRequest({ type, tabId: tab.id }).catch(() => undefined);
  window.setTimeout(() => window.close(), 60);
}

async function onDownloadClick(): Promise<void> {
  if (!lastCapture) return;
  const settings = await getSettings();
  const filename = buildFilename(
    lastCapture.sourceUrl,
    settings.filenamePattern,
    extensionFor(exportFormat),
  );
  downloadButton.disabled = true;
  try {
    const response = await sendRuntimeRequest({
      type: 'DOWNLOAD_CAPTURE',
      dataUrl: lastCapture.dataUrl,
      filename,
      format: exportFormat,
      quality: jpegQuality,
    });
    if (!response.ok) {
      setStatus(response.error, true);
      return;
    }
    setStatus(`Saved ${filename}`);
  } catch (error) {
    setStatus(errorMessage(error), true);
  } finally {
    downloadButton.disabled = false;
  }
}

/** Copy the raw capture to the system clipboard as a PNG. */
async function onCopyClick(): Promise<void> {
  if (!lastCapture) return;
  copyButton.disabled = true;
  try {
    const blob = await (await fetch(lastCapture.dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus('Copied to clipboard ✓');
  } catch (error) {
    setStatus(errorMessage(error), true);
  } finally {
    copyButton.disabled = false;
  }
}

/** Highlight the chosen format and reveal the quality slider where it applies. */
function selectFormat(format: ExportFormat): void {
  exportFormat = format;
  for (const key of ['png', 'jpeg', 'pdf'] as const) {
    const active = key === format;
    formatButtons[key].classList.toggle('active', active);
    formatButtons[key].setAttribute('aria-pressed', String(active));
  }
  // PDF pages are JPEG-encoded internally, so quality applies to both.
  qualityRow.classList.toggle('hidden', format === 'png');
  downloadButton.textContent = `Download ${format.toUpperCase()}`;
}

function presentCapture(result: Presentable): void {
  lastCapture = result;
  previewImage.src = result.dataUrl;
  dimensionsLabel.textContent = `${result.width} × ${result.height}px`;
  siteLabel.textContent = hostnameOf(result.sourceUrl);
  resultSection.classList.remove('hidden');
  downloadButton.disabled = false;
  copyButton.disabled = false;
}

async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const BLOCKED_PROTOCOLS = [
  'chrome:',
  'chrome-extension:',
  'edge:',
  'about:',
  'devtools:',
  'view-source:',
];

/** True when content scripts can run on this URL (browser-internal pages excluded). */
function isCapturableUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) return false;
    if (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function setStatus(message: string, isError = false): void {
  statusLabel.textContent = message;
  statusLabel.classList.toggle('error', isError);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
