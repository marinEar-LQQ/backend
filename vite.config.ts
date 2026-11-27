import { defineConfig } from 'vite';

// 백엔드 검증 하네스 전용 (npm run harness). 엔진 패키지 빌드는 tsc 로 한다.
export default defineConfig({
  root: 'harness',
  publicDir: '../fixtures',
  server: { port: 5181, strictPort: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
