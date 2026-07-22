/// <reference types="vitest/config" />
import path from 'path';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** Alchemy networks used by wallet lookup — proxied in dev to avoid browser CORS blocks. */
const ALCHEMY_NETWORKS = [
  'eth-mainnet',
  'polygon-mainnet',
  'arb-mainnet',
  'base-mainnet',
  'opt-mainnet',
  'bnb-mainnet',
  'avax-mainnet',
  'solana-mainnet'
] as const;

const alchemyDevProxy = Object.fromEntries(
  ALCHEMY_NETWORKS.map((network) => [
    `/alchemy-rpc/${network}`,
    {
      target: `https://${network}.g.alchemy.com`,
      changeOrigin: true,
      secure: true,
      rewrite: () => '/v2'
    }
  ])
);

// All processing is client-side. This app makes zero network calls to any
// SoloLedger-owned server by design — there is no backend. The only optional
// network calls a user can enable are (a) a price-lookup API and
// (b) a public blockchain RPC/explorer for read-only address lookups —
// both off by default and gated behind explicit settings toggles.
export default defineConfig({
  // Local dev: /. GitHub Pages build sets VITE_BASE_PATH=/SoloLedger/ (must match repo name case).
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'SoloLedger — Private Crypto Tax',
        short_name: 'SoloLedger',
        description: 'Fully local, offline-first crypto capital gains & tax reporting.',
        theme_color: '#0A0B1A',
        background_color: '#0A0B1A',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The lazy vendor-ccxt chunk (~5 MB) far exceeds workbox's 2 MiB
        // precache limit and would fail generateSW. It's only ever fetched
        // on demand by exchange auto-sync (a hosted/online-only feature), so
        // excluding it from the precache manifest keeps the PWA offline-first
        // for everything else.
        globIgnores: ['**/vendor-ccxt-*.js']
      }
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    // Cursor Cloud (and similar remote dev proxies) forward the app through
    // a changing *.cursorvm.com / *.agent.cvm.dev hostname. Vite blocks unknown
    // hosts by default to prevent DNS rebinding; allow those proxy domains in dev.
    allowedHosts: true,
    // Browser → localhost → Vite → Alchemy. Avoids CORS blocks on direct Alchemy calls.
    proxy: {
      ...alchemyDevProxy,
      // Public Solana JSON-RPC (no API key) — used by Portfolio ledger repair.
      '/solana-rpc': {
        target: 'https://api.mainnet-beta.solana.com',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/'
      },
      '/etherscan-api': {
        target: 'https://api.etherscan.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/etherscan-api/, '')
      },
      '/blockscout-api': {
        target: 'https://eth.blockscout.com/api/v2',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/blockscout-api/, '')
      }
    }
  },
  preview: {
    proxy: {
      ...alchemyDevProxy,
      '/solana-rpc': {
        target: 'https://api.mainnet-beta.solana.com',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/'
      },
      '/etherscan-api': {
        target: 'https://api.etherscan.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/etherscan-api/, '')
      },
      '/blockscout-api': {
        target: 'https://eth.blockscout.com/api/v2',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/blockscout-api/, '')
      }
    }
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split heavy vendor libraries into dedicated chunks so the main
        // entry chunk stays well under Vite's 500 KB warning threshold.
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-xlsx': ['xlsx'],
          'vendor-pdf': ['jspdf', 'jspdf-autotable'],
          'vendor-papaparse': ['papaparse'],
          'vendor-dexie': ['dexie', 'dexie-react-hooks'],
          // Exchange auto-sync: ccxt is huge and only loaded lazily via
          // `await import('ccxt')` in lib/exchangeSync/ccxtLoader.ts.
          'vendor-ccxt': ['ccxt']
        }
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Only run the CLIENT suite here. The `server/` workspace has its own
    // Vitest config, its own dependencies (express, jsonwebtoken, …) in
    // `server/node_modules`, and a Node (not jsdom) environment. Without this
    // scope Vitest's default glob sweeps `server/**` too and the client job
    // fails to resolve server-only imports.
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, 'server/**']
  }
});
