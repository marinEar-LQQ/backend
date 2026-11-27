# marinEar 엔진 (백엔드)

브라우저 Web Worker 안에서 실행하는 로컬 분석 엔진. 기준 문서: marinEar 프론트/백엔드/통합 기술설명서 v1.0.
상시 서버 없음 — 최초 설치·업데이트 때만 모델을 내려받고, 현장 처리는 기기 안에서 한다.

## 프론트에서 설치

```bash
npm i github:marinEar-LQQ/backend
```

설치 시 `prepare` 가 `dist/` 를 빌드한다. Vite 설정에 다음을 추가한다.

```ts
// vite.config.ts
export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
```

## 1) 화면 개발: MockEngineClient (모델 없이, 메인 스레드)

실제 엔진과 같은 규칙·IndexedDB 를 쓰고 ASR/번역만 시연 고정 데이터다. 결과의 `origin === 'fixture'`, 세션의 `inputInfo.fixtureMode === true` 이면 **시연 배지**로 구분해야 한다.

```ts
import { MockEngineClient } from 'marinear-engine';

const engine = await MockEngineClient.create();
engine.subscribe((e) => console.log(e.type, e));
const taskId = await engine.seedDemoTask();   // 해동호 / A선박 / PNIT T3
await engine.playScenario(taskId);             // 사례 A~D·일치·정정 6건
```

## 2) 실제 엔진: WorkerEngineClient

```ts
import { WorkerEngineClient, DEFAULT_ASSET_MANIFEST, analyzeFile } from 'marinear-engine';
import EngineWorker from 'marinear-engine/worker?worker';

const engine = new WorkerEngineClient(new EngineWorker(), { allowRemote: true });
const readiness = await engine.loadAssets(DEFAULT_ASSET_MANIFEST, (p) => showProgress(p));
// readiness.canAnalyze 가 false 면 분석 시작 버튼 비활성 (MODEL_NOT_READY)

const { task } = await engine.saveTask({ ownVessel: '해동호', targetVessel: 'A선박', terminalId: 'PNIT', berthId: 'T3', note: '' });
await analyzeFile(engine, task.taskId, file);   // 파일 디코딩 → AudioFrame → 같은 엔진 경로
```

실시간 입력은 프론트 AudioWorklet 에서 `AudioFrame` 을 만들어 `openSession(taskId, 'live')` → `appendAudio` → `closeSession` 으로 보낸다. 장치가 끊기면 `markDisconnected(sessionId)`.

## 이벤트 흐름 (발화 1건)

```
analysis.progress(queued, utterance 포함) → enhancing → asr_enhanced
→ transcript.partial(enhanced)            // 잠정 자막. 검토·반영 금지
→ analysis.final(revision 1, crossCheck=pending)   // enhanced 만으로 잠정 판정
→ asr_raw
→ analysis.final(revision 2, crossCheck=complete)  // 원음 교차 검사 반영. 사례 B 는 여기서 ambiguous 로 바뀜
```

- `utteranceId + revision` 으로 갱신. 더 낮은 revision 이 늦게 와도 덮어쓰지 않는다.
- `crossCheck !== 'complete'` 인 결과로 `apply` 하면 `UNCERTAIN_VALUE`.
- 번역은 `requestTranslation(utteranceId, revision, lang)` — 결과는 그 revision 에 묶인다.

## 판정 (comparison.kind)

| kind | 뜻 | 대표 reasonCodes |
|---|---|---|
| match | 대상·장소가 기준과 같음 (자동 승인 아님) | LOCATION_MATCHES, BERTH_MISSING |
| difference | 같은 대상, 명확한 장소가 기준과 다름 (기준 자동 변경 금지) | LOCATION_DIFFERS + `diffs` |
| ambiguous | 후보가 여럿·인식 차이·터미널 누락 | ASR_DISAGREEMENT, TERMINAL_MISSING, MULTIPLE_CANDIDATES, CORRECTION_UNCLEAR |
| unrelated | 다른 선박 교신 | OTHER_VESSEL |
| unknown | 선박/장소 판별 불가, 등록 작업 없음 | VESSEL_MISSING, NO_TASK |

## 확인·반영

```ts
await engine.reviewUtterance({
  requestId: crypto.randomUUID(),     // 멱등 키 — 재전송해도 한 번만 반영
  utteranceId, action: 'apply',       // 'review' | 'dismiss' 는 기준을 바꾸지 않음
  expectedResultRevision: result.revision,
  expectedTaskVersion: task.activeVersion,
  confirmedByUser: true,
  patch: { terminalId: 'HPNT' },      // 사용자가 명시적으로 선택한 값
});
// VERSION_CONFLICT / RESULT_STALE → 자동 재시도하지 말고 최신 기준·결과를 다시 보여줄 것
```

## 계약 확장 (프론트 협의 필요)

문서의 EngineClient 목록에 없는데 필요해서 추가한 것:
- `saveNote(taskId, text, noteId?)` — 일지 직접 메모 (문서 저장소 표에는 notes 있음)
- `listTasks()` — 앱 재시작 후 작업 목록 복원
- `markDisconnected(sessionId)` — 입력 장치 끊김 기록 (WorkerEngineClient/EngineCore)

## 구조

- `src/contracts/` — 공통 타입·이벤트·오류 코드·검증 (프론트와 공동 변경)
- `src/engine/rules/` — EntityResolver(추출), ComparisonEngine(비교)
- `src/engine/audio/` — 리샘플링, 잡음 완화(VHF 대역 + 스펙트럼 게이트), VAD 발화 분리
- `src/engine/models/` — transformers.js Whisper / M2M100 provider
- `src/engine/assets/` — AssetManager (manifest·해시·자체 검사)
- `src/engine/core.ts` — EngineCore (EngineClient 구현)
- `src/repositories/` — IndexedDB TaskLogRepository (원자적 apply)
- `src/workers/` — Worker 진입점
- `harness/` — 백엔드 검증 페이지 (`npm run harness`)
- `fixtures/audio/` — Windows TTS 로 만든 시연 음성 + 합성 잡음 (**현장 성능 근거 아님**)

## 개발

```bash
npm test            # Vitest (규칙·저장소·오디오·엔진 흐름)
npm run typecheck
npm run harness     # http://localhost:5181
```

## 사용 모델·라이선스

| 역할 | 모델 | 라이선스 |
|---|---|---|
| ASR | onnx-community/whisper-small | MIT (Whisper 가중치) / Apache-2.0 (ONNX 변환) |
| 번역 | Xenova/m2m100_418M | MIT |
| 런타임 | @huggingface/transformers 4.3.2 (ONNX Runtime Web) | Apache-2.0 |
