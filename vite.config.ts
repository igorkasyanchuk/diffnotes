import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const api = 'http://localhost:3000'
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': api, '/files': api, '/skill': api, '/install.sh': api } },
  test: {
    include: ['server/**/*.test.ts'], environment: 'node',
    // npm run coverage: the server and the Markdown renderer it shares with the web app and the extension.
    // index.ts is startup wiring; the extension's DOM code and the web app are checked in a real browser, not here.
    coverage: {
      provider: 'v8', include: ['server/**/*.ts', 'extension/markdown.js'], exclude: ['server/**/*.test.ts', 'server/testkit.ts', 'server/index.ts'],
      reporter: ['text-summary', 'text'], thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
})
