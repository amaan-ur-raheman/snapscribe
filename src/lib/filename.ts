/**
 * Filename helpers shared by the popup and the content script.
 */

import type { ExportFormat } from '../types/messages';

/** File extension for an export format (jpeg → .jpg). */
export function extensionFor(format: ExportFormat): string {
  switch (format) {
    case 'png':
      return 'png';
    case 'jpeg':
      return 'jpg';
    case 'pdf':
      return 'pdf';
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Expand the configured {site}/{date}/{time} pattern into a filename. */
export function buildFilename(sourceUrl: string, pattern: string, ext: string): string {
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
