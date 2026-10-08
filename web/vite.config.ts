import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

const backend = process.env.NOTIFY_BACKEND || 'http://[::1]:18794'

export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { host: '::', proxy: { '/api': backend } },
})
