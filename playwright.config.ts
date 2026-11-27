import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    headless: true,
    // Ordinary regression tests exercise unrelated features with background work
    // paused. Dedicated recognition tests explicitly enable the automatic queue.
    storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:3000', localStorage: [
      { name: 'ancestry-lens-recognition-paused', value: 'true' },
      { name: 'ancestry-lens-similarity-paused', value: 'true' },
    ] }] },
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 3000 --strictPort',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
  },
});
