import { defineConfig } from 'vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fixture } from './dev/fixture.ts'

// In dev, the API comes from a running pclaw (PCLAW_DASHBOARD_PORT, default 7421), or from the scripted fixture
// in dev/ when PCLAW_FIXTURE is set (see dev/fixture.ts for the modes).
const fixtureMode = process.env.PCLAW_FIXTURE

const config = defineConfig({
  server: fixtureMode ? {} : { proxy: { '/api': `http://127.0.0.1:${process.env.PCLAW_DASHBOARD_PORT ?? 7421}` } },
  resolve: { tsconfigPaths: true },
  plugins: [
    ...(fixtureMode ? [fixture(fixtureMode)] : []),
    tailwindcss(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
})

export default config
