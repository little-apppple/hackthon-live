import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式下 /api 代理到大屏服务；API_TARGET 可覆盖（如 http://localhost:3100）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
