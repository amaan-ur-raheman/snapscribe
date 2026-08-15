/**
 * Options page — default export format, quality, filename pattern, theme.
 * Reads/writes the typed settings object via the shared storage wrapper, so
 * the popup, editor, content script, and worker all see the same values.
 */

import { clearHistory, getSettings, setSettings } from '../lib/storage';
import type { ExportFormat } from '../types/messages';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const form = $<HTMLFormElement>('options-form');
const formatPngButton = $<HTMLButtonElement>('format-png');
const formatJpegButton = $<HTMLButtonElement>('format-jpeg');
const formatPdfButton = $<HTMLButtonElement>('format-pdf');
const qualityInput = $<HTMLInputElement>('quality');
const qualityValue = $<HTMLElement>('quality-value');
const filenamePatternInput = $<HTMLInputElement>('filename-pattern');
const themeInputs = document.querySelectorAll<HTMLInputElement>('input[name="theme"]');
const clearHistoryButton = $<HTMLButtonElement>('clear-history');
const saveButton = $<HTMLButtonElement>('save');
const statusLabel = $<HTMLElement>('status');

let selectedFormat: ExportFormat = 'png';

const formatButtons: Record<ExportFormat, HTMLButtonElement> = {
  png: formatPngButton,
  jpeg: formatJpegButton,
  pdf: formatPdfButton,
};

for (const format of ['png', 'jpeg', 'pdf'] as const) {
  formatButtons[format].addEventListener('click', () => selectFormat(format));
}

qualityInput.addEventListener('input', () => {
  qualityValue.textContent = qualityInput.value;
});

themeInputs.forEach((input) => {
  input.addEventListener('change', () => applyTheme(input.value as 'light' | 'dark'));
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void onSave();
});

clearHistoryButton.addEventListener('click', () => void onClearHistory());

// Load current settings into the form.
void (async () => {
  const settings = await getSettings();
  selectedFormat = settings.defaultFormat;
  qualityInput.value = String(settings.jpegQuality);
  qualityValue.textContent = String(settings.jpegQuality);
  filenamePatternInput.value = settings.filenamePattern;
  const themeInput = Array.from(themeInputs).find((input) => input.value === settings.theme);
  if (themeInput) themeInput.checked = true;
  selectFormat(selectedFormat);
  applyTheme(settings.theme);
})();

function selectFormat(format: ExportFormat): void {
  selectedFormat = format;
  for (const key of ['png', 'jpeg', 'pdf'] as const) {
    const active = key === format;
    formatButtons[key].classList.toggle('active', active);
    formatButtons[key].setAttribute('aria-pressed', String(active));
  }
  // PDF pages are JPEG-encoded internally, so quality applies to both.
  qualityInput.disabled = format === 'png';
}

async function onSave(): Promise<void> {
  saveButton.disabled = true;
  const themeInput = Array.from(themeInputs).find((input) => input.checked);
  try {
    await setSettings({
      defaultFormat: selectedFormat,
      jpegQuality: Number(qualityInput.value),
      filenamePattern: filenamePatternInput.value.trim() || '{site}-{date}-{time}',
      theme: (themeInput?.value as 'light' | 'dark') ?? 'dark',
    });
    setStatus('Settings saved ✓');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    saveButton.disabled = false;
  }
}

async function onClearHistory(): Promise<void> {
  clearHistoryButton.disabled = true;
  try {
    await clearHistory();
    setStatus('Capture history cleared');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    clearHistoryButton.disabled = false;
  }
}

/** Preview the selected theme immediately (persisted on Save). */
function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
}

function setStatus(message: string, isError = false): void {
  statusLabel.textContent = message;
  statusLabel.classList.toggle('error', isError);
}
