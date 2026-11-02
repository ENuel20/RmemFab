import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('recharts')) return 'vendor-recharts'
            if (id.includes('ajv')) return 'vendor-ajv'
            if (id.includes('react') || id.includes('react-dom')) return 'vendor-react'
          }
        }
      }
    }
  }
})
