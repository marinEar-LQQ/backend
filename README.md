# marinEar 엔진 (백엔드)

브라우저 Web Worker 안에서 실행하는 로컬 분석 엔진. 기준 문서: marinEar 프론트/백엔드/통합 기술설명서 v1.0.

## 프론트에서 사용

```bash
npm i github:marinEar-LQQ/backend
```

```ts
import type { EngineClient, AnalysisResult } from 'marinear-engine/contracts';
```

- `src/contracts/` — 공통 타입·이벤트·오류 코드·검증 (프론트와 공동 변경)
- `src/engine/` — 추출·비교 규칙, 엔진 코어, EngineClient 구현
- `src/workers/` — Worker 진입점
- `src/repositories/` — IndexedDB 저장소

## 개발

```bash
npm test        # Vitest
npm run typecheck
```
