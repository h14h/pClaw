import { defineConfig } from 'vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In dev, the API comes from a running `pnpm prose-lab serve` (PROSE_LAB_PORT, default 7423).
export default defineConfig({
  server: { proxy: { '/api': `http://127.0.0.1:${process.env.PROSE_LAB_PORT ?? 7423}` } },
  plugins: [tailwindcss(), tanstackRouter({ target: 'react', autoCodeSplitting: true }), viteReact()],
})
