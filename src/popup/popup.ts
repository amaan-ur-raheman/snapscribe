import { getSettings } from '../lib/storage';
import { sendRuntimeRequest } from '../types/messages';
import type { CaptureResponse } from '../types/messages';

type SuccessCapture = Extract<CaptureResponse, { ok: true }>['result'];

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const captureButton = $<HTMLButtonElement>('capture-visible');
const downloadButton = $<HTMLButtonElement>('download');
const resultSection = $<HTMLElement>('result');
const previewImage = $<HTMLImageElement>('preview');
const dimensionsLabel = $<HTMLElement>('meta-dimensions');
const siteLabel = $<HTMLElement>('meta-site');
const statusLabel = $<HTMLElement>('status');

let lastCapture: SuccessCapture | null = null;

captureButton.addEventListener('click', () => void onCaptureClick());
downloadButton.addEventListener('click', () => void onDownloadClick());

async function onCaptureClick(): Promise<void> {
  const tab = await currentTab();
  if (!tab?.id) {
    setStatus('No active tab to capture.', true);
    return;
  }
  setStatus('Capturing…');
  captureButton.disabled = true;
  try {
    const response = await sendRuntimeRequest({ type: 'CAPTURE_VISIBLE', tabId: tab.id });
    if (!response.ok) {
      setStatus(response.error, true);
      return;
    }
    lastCapture = response.result;
    previewImage.src = response.result.dataUrl;
    dimensionsLabel.textContent = `${response.result.width} × ${response.result.height}px`;
    siteLabel.textContent = hostnameOf(response.result.sourceUrl);
    resultSection.classList.remove('hidden');
    downloadButton.disabled = false;
    setStatus('Captured ✓');
  } catch (error) {
    setStatus(errorMessage(error), true);
  } finally {
    captureButton.disabled = false;
  }
}

async function onDownloadClick(): Promise<void> {
  if (!lastCapture) return;
  const settings = await getSettings();
  const filename = buildFilename(lastCapture.sourceUrl, settings.filenamePattern, 'png');
  downloadButton.disabled = true;
  try {
    const response = await sendRuntimeRequest({
      type: 'DOWNLOAD_CAPTURE',
      dataUrl: lastCapture.dataUrl,
      filename,
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

async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Expand the configured {site}/{date}/{time} pattern into a filename. */
function buildFilename(sourceUrl: string, pattern: string, ext: string): string {
  const site = hostnameOf(sourceUrl).replace(/\./g, '-');
  const now = new Date();
  const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('-');
  const time = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('-');
  const base = pattern
    .replace(/\{site\}/g, site || 'page')
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time);
  return `${base || `snapscribe-${date}-${time}`}.${ext}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function setStatus(message: string, isError = false): void {
  statusLabel.textContent = message;
  statusLabel.classList.toggle('error', isError);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
