/**
 * Typed wrapper around chrome.storage.local for SnapScribe settings and the
 * capture history schema. Reads merge in defaults, so callers never see a
 * partial or missing settings object.
 */

import type { ExportFormat } from '../types/messages';

export interface SnapScribeSettings {
  /** Default export format for new captures. */
  defaultFormat: ExportFormat;
  /** JPEG quality, 0-100, used when exporting JPEG. (Phase 4) */
  jpegQuality: number;
  /** Filename pattern supporting {site}, {date}, {time} tokens. (Phase 6) */
  filenamePattern: string;
  /** UI theme for the popup and editor. (Phase 6) */
  theme: 'light' | 'dark';
}

export const DEFAULT_SETTINGS: SnapScribeSettings = {
  defaultFormat: 'png',
  jpegQuality: 90,
  filenamePattern: '{site}-{date}-{time}',
  theme: 'dark',
};

/** A finished capture stored in history — thumbnail + metadata only. */
export interface CaptureHistoryEntry {
  id: string;
  thumbnailDataUrl: string;
  width: number;
  height: number;
  dpr: number;
  format: ExportFormat;
  timestamp: number;
  sourceUrl: string;
}

const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'captureHistory';
/** Keep the newest N captures so storage.local stays well under quota. */
const MAX_HISTORY = 30;

export async function getSettings(): Promise<SnapScribeSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY];
  if (!isRecord(raw)) return { ...DEFAULT_SETTINGS };

  const defaultFormat = isExportFormat(raw.defaultFormat)
    ? raw.defaultFormat
    : DEFAULT_SETTINGS.defaultFormat;
  const jpegQuality =
    typeof raw.jpegQuality === 'number' && Number.isFinite(raw.jpegQuality)
      ? Math.min(100, Math.max(1, raw.jpegQuality))
      : DEFAULT_SETTINGS.jpegQuality;
  const filenamePattern =
    typeof raw.filenamePattern === 'string'
      ? raw.filenamePattern
      : DEFAULT_SETTINGS.filenamePattern;
  const theme = raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : DEFAULT_SETTINGS.theme;

  return { defaultFormat, jpegQuality, filenamePattern, theme };
}

export async function setSettings(patch: Partial<SnapScribeSettings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}

export async function getHistory(): Promise<CaptureHistoryEntry[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const raw = stored[HISTORY_KEY];
  return Array.isArray(raw) ? raw.filter(isHistoryEntry) : [];
}

/** Prepend a capture (newest first) and cap the list length. */
export async function addHistoryEntry(
  entry: Omit<CaptureHistoryEntry, 'id'>,
): Promise<CaptureHistoryEntry> {
  const id = crypto.randomUUID();
  const next = [{ ...entry, id }, ...(await getHistory())].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return { ...entry, id };
}

export async function removeHistoryEntry(id: string): Promise<void> {
  const next = (await getHistory()).filter((entry) => entry.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'png' || value === 'jpeg' || value === 'pdf';
}

function isHistoryEntry(value: unknown): value is CaptureHistoryEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.thumbnailDataUrl === 'string' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    typeof value.timestamp === 'number' &&
    typeof value.sourceUrl === 'string'
  );
}
