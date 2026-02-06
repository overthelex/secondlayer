import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: mode === 'staging' ? 'dist-staging' : 'dist',
    sourcemap: mode === 'staging' || mode === 'development',
  },
  server: {
    proxy: mode === 'development' ? {
      '/api': {
        target: 'https://stage.legal.org.ua',
        changeOrigin: true,
      },
    } : undefined,
  },
}))
