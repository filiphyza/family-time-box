import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiKey = (env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || env.API_KEY || '').trim();

  return {
    // GitHub Pages serves the app from /family-time-box/; local dev and builds stay at /.
    base: env.BASE_PATH || '/',
    server: {
      port: 3000,
      host: '127.0.0.1',
    },
    define: {
      'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(apiKey),
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
