import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 画面とAPIを同一Originで扱い、Cookie・CSRF境界を開発時も維持する。
// [ko] 화면과 API를 같은 Origin으로 다뤄 개발 중에도 쿠키·CSRF 경계를 유지한다.
// [en] Proxy API calls through the page origin to preserve cookie and CSRF boundaries in development.
const proxy = { '/api': { target: process.env.SOLVELOOP_API_TARGET ?? 'http://127.0.0.1:8000', changeOrigin: false } }

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy,
  },
})
