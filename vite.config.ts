import { defineConfig } from 'vite';

// 백엔드 검증 하네스 전용 (npm run harness). 엔진 패키지 빌드는 tsc 로 한다.
export default defineConfig({
  root: 'harness',
  publicDir: '../fixtures',
  // 모델 다운로드·장시간 분석 중 코드 수정으로 페이지가 새로고침되지 않도록 HMR·감시 끔
  server: { port: 5181, strictPort: true, hmr: false, watch: null },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
