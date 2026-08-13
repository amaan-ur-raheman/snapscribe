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

/** A finished capture stored in history. (Read/write lands in Phase 6.) */
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

export async function getSettings(): Promise<SnapScribeSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<SnapScribeSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...raw };
}

export async function setSettings(patch: Partial<SnapScribeSettings>): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: patch });
}

// Capture history (list / add / clear) is implemented in Phase 6 using a
// `captureHistory` key and the CaptureHistoryEntry schema above.
