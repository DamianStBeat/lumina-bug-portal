import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Its own file, not vite.config.ts: that one loads the dev mock API (dev/mock-api.ts), a second server the specs
// must not talk to. The specs bring their own fake worker (test/helpers.ts).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
})
