/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'icon.svg'],
        manifest: {
          id: '/',
          name: 'SpazaStock',
          short_name: 'SpazaStock',
          description: 'Mobile-first PWA inventory and sales management tool for spaza shops.',
          theme_color: '#09090b',
          background_color: '#09090b',
          display: 'standalone',
          orientation: 'portrait-primary',
          start_url: '/',
          scope: '/',
          // Generated from public/icon.svg by `npm run generate-pwa-assets`.
          icons: [
            { src: '/pwa-64x64.png', sizes: '64x64', type: 'image/png' },
            { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        // Push and notification-click handlers for expiry alerts (public/push-handler.js).
        // The barcode decoder's wasm (~1.1 MB) is precached so scanning works offline.
        workbox: {
          importScripts: ['push-handler.js'],
          globPatterns: ['**/*.{js,css,html,wasm,svg,png,ico}'],
          // Platform admin code (/admin) is fetched on demand; shop phones never download it.
          globIgnores: ['**/AdminApp-*.js'],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    test: {
      environment: 'happy-dom',
      setupFiles: ['./src/test/setup.ts'],
      // Several databases start at once; a 5s limit fails the suite when the machine is busy.
      testTimeout: 20_000,
    },
  };
});
