import { defineManifest } from '@crxjs/vite-plugin';

const icons = {
  '16': 'icons/icon-16.png',
  '32': 'icons/icon-32.png',
  '48': 'icons/icon-48.png',
  '128': 'icons/icon-128.png',
};

export default defineManifest({
  manifest_version: 3,
  name: 'SnapScribe',
  version: '1.0.0',
  // The UI relies on :has() and color-mix() (Chrome 105 / 111).
  minimum_chrome_version: '111',
  description:
    'On-device screenshot capture for Chrome: visible area, full page, region, or element. Nothing leaves your browser.',
  permissions: ['activeTab', 'scripting', 'downloads', 'storage', 'contextMenus', 'clipboardWrite'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/content-script.ts'],
      run_at: 'document_idle',
    },
  ],
  options_page: 'src/options/options.html',
  commands: {
    'capture-visible': {
      suggested_key: { default: 'Alt+Shift+S' },
      description: 'Capture the visible area of the current tab',
    },
    'capture-full-page': {
      suggested_key: { default: 'Alt+Shift+F' },
      description: 'Capture the full current page',
    },
  },
  action: {
    default_title: 'SnapScribe',
    default_popup: 'src/popup/popup.html',
    default_icon: icons,
  },
  icons,
});
