import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /api is proxied to the backend (server/) so the browser can fetch the world.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:5179', changeOrigin: true },
    },
  },
})
