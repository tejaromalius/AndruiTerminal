/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// The app version lives in the workspace Cargo.toml ([workspace.package] version).
const cargoToml = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8');
const appVersion = /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
if (!appVersion) throw new Error('No [workspace.package] version in ../Cargo.toml');

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:19811', // scripts/run-dev.sh
        changeOrigin: false,
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
