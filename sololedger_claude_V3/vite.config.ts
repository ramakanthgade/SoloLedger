import path from 'path';
import { defineConfig } from 'vite';
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
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'SoloLedger — Private Crypto Tax',
        short_name: 'SoloLedger',
        description: 'Fully local, offline-first crypto capital gains & tax reporting.',
        theme_color: '#F8F6FE',
        background_color: '#F8F6FE',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}']
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
    allowedHosts: ['.cursorvm.com', '.agent.cvm.dev', 'localhost'],
    // Browser → localhost → Vite → Alchemy. Avoids CORS blocks on direct Alchemy calls.
    proxy: {
      ...alchemyDevProxy,
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
    sourcemap: false
  }
});
