import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/camera-stream': {
        target: 'http://192.168.100.119',
        changeOrigin: false,
        rewrite: () => '/',
      },
    },
  },
})
