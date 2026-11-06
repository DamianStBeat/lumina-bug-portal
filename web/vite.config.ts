import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { mockApi } from './dev/mock-api'

export default defineConfig({
  // mockApi only runs under `vite` (dev): `apply: 'serve'` leaves it out of `vite build`.
  plugins: [react(), mockApi()],
})
