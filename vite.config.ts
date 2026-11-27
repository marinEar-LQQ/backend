import { defineConfig } from 'vite';

// 백엔드 검증 하네스 전용 (npm run harness). 엔진 패키지 빌드는 tsc 로 한다.
export default defineConfig({
  root: 'harness',
  publicDir: '../fixtures',
  // 모델 다운로드·장시간 분석 중 코드 수정으로 페이지가 새로고침되지 않도록 HMR·감시 끔
  // COOP/COEP: crossOriginIsolated 가 켜져야 ONNX Runtime WASM 이 멀티스레드(SharedArrayBuffer)로 돈다.
  // 프론트 배포 서버에도 같은 헤더가 필요하다.
  server: {
    port: 5181,
    strictPort: true,
    hmr: false,
    watch: null,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
