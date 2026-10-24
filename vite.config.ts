import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const api = 'http://localhost:3000'
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': api, '/files': api, '/skill': api, '/install.sh': api } },
  test: { include: ['server/**/*.test.ts'], environment: 'node' },
})
