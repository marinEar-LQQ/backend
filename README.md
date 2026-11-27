# marinEar 엔진 (백엔드)

브라우저 Web Worker 안에서 실행하는 로컬 분석 엔진. 기준 문서: marinEar 프론트/백엔드/통합 기술설명서 v1.0.
상시 서버 없음 — 최초 설치·업데이트 때만 모델을 내려받고, 현장 처리는 기기 안에서 한다.

## 프론트에서 설치

```bash
npm i github:marinEar-LQQ/backend
```

설치 시 `prepare` 가 `dist/` 를 빌드한다. Vite 설정:

```ts
// vite.config.ts
export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers', '@shiguredo/rnnoise-wasm'] },
  // ONNX WASM 멀티스레드에 필요 (없으면 단일 스레드라 2배 이상 느림). 배포 서버에도 같은 헤더
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
```

## 0) 온라인 모드 (기본 권장 · 2026-11-27 전환)

음성인식과 번역을 클라우드 모델로 처리한다. 모델 다운로드가 없고 더 정확하다. **음성이 분석을 위해 외부 서비스로 전송된다** — 화면에 고지할 것.
오프라인 모델 코드는 그대로 남아 있다 (`mode: 'offline'`, 전환 전 상태는 태그 `offline-v1`).

```bash
# 1. 저장소 루트 .env 에 키를 넣는다 (git 에 올라가지 않음)
#    GEMINI_API_KEY=...   음성인식 (gemini-3.5-flash-lite)
#    NVIDIA_API_KEY=...   번역 (nemotron-3-ultra)
# 2. 중계 서버 실행 — 키를 브라우저에 노출하지 않기 위한 프록시
npm run server          # http://localhost:8787
```

```ts
const engine = new WorkerEngineClient(new EngineWorker(), { mode: 'online', proxyUrl: 'http://localhost:8787' });
const readiness = await engine.loadAssets(DEFAULT_ASSET_MANIFEST);   // 온라인: 서버 상태 확인만 (0.2초)
// readiness.mode === 'online', 이후 호출·이벤트는 오프라인과 동일
```

- 발화 자르기, 원음/완화음 이중 인식, 판정 규칙, "확인 필요", 저장, 반영, 일지는 오프라인과 **같은 코드**.
- 번역은 `reference: false` 로 온다 (자리표시 복원·검증 통과 시 `ready`). 정형 요약(`summary`)도 그대로 제공.
- 실패 시 오류 코드 `ONLINE_UNAVAILABLE` (인터넷·서버·외부 API). 원음은 보존된다.
- 실측(노트북 Chrome, 약한 잡음 시연 녹음): 발화당 처리 p50 4.4초 (오프라인 약 10초). 전사 CER 9~21% (오프라인 whisper-small 29~44%).
- 한계: 강한 잡음에서는 용어 힌트 때문에 안 들린 코드(BNCT)를 적는 경우가 실측에서 나왔다 → 원음/완화음 교차 검사와 "확인 필요"가 계속 필요.

## 1) 화면 개발 / 시연 안전망: MockEngineClient

실제 엔진과 같은 규칙·IndexedDB 를 쓰고 ASR/번역만 시연 고정 데이터(팀 대본 3개, 9개 대사)다.
결과의 `origin === 'fixture'`, 세션의 `inputInfo.fixtureMode === true` 이면 **"시연 데이터" 배지**로 구분한다.

```ts
import { MockEngineClient, analyzeFile } from 'marinear-engine';
import script1 from 'marinear-engine/fixtures/audio/team/script1_noisy.wav?url';

const engine = await MockEngineClient.create();
engine.subscribe((e) => console.log(e.type, e));
const taskId = await engine.seedDemoTask();          // 해동호 / 현대부산호 / PNIT 2번 (일부러 틀린 기록)
await engine.playScenario(taskId);                    // 합성음 + 9개 대사
// 또는 팀 녹음 파일을 그대로 넣으면 구간별 대본 자막이 나온다
await analyzeFile(engine, taskId, Object.assign(await (await fetch(script1)).blob(), { name: 'script1_noisy.wav' }));
```

## 2) 실제 엔진: WorkerEngineClient

```ts
import { WorkerEngineClient, DEFAULT_ASSET_MANIFEST, analyzeFile } from 'marinear-engine';
import EngineWorker from 'marinear-engine/worker?worker';

const engine = new WorkerEngineClient(new EngineWorker(), { allowRemote: true });
const readiness = await engine.loadAssets(DEFAULT_ASSET_MANIFEST, (p) => showProgress(p));
// readiness.canAnalyze === false 면 분석 시작 버튼 비활성 (MODEL_NOT_READY)
// 현장(오프라인): { allowRemote: false } — 캐시에 있는 모델만 쓰고 외부 요청은 차단

const { task } = await engine.saveTask({ ownVessel: '해동호', targetVessel: '현대부산호', terminalId: 'PNIT', berthId: 'T2', note: '' });
await analyzeFile(engine, task.taskId, file);
```

- 자원: whisper-small(약 250MB) + Opus-MT 3개(약 315MB). 첫 설치만 다운로드, 이후 캐시.
- 실측(노트북 Chrome, WASM 멀티스레드): 발화당 처리 약 10초(RTF 2.4). 첫 결과(rev1)는 약 5초.
- 실시간 입력: 프론트 AudioWorklet → `openSession(taskId, 'live')` → `appendAudio` → `closeSession`. 장치 끊김은 `markDisconnected(sessionId)`.

## 이벤트 흐름 (발화 1건)

```
analysis.progress(queued, utterance 포함) → enhancing → asr_enhanced
→ transcript.partial(enhanced)                       // 잠정 자막. 검토·반영 금지
→ analysis.final(revision 1, crossCheck=pending)     // 완화음만으로 잠정 판정
→ asr_raw
→ analysis.final(revision 2, crossCheck=complete)    // 원음 교차 검사 반영
```

- `utteranceId + revision` 으로 갱신. 더 낮은 revision 이 늦게 와도 덮어쓰지 않는다.
- `crossCheck !== 'complete'` 결과로 `apply` 하면 `UNCERTAIN_VALUE`.

## 판정 (comparison.kind)

| kind | 뜻 | 대표 reasonCodes |
|---|---|---|
| match | 대상·장소가 기준과 같음 (자동 승인 아님) | LOCATION_MATCHES, BERTH_MISSING |
| difference | 같은 대상, 명확한 장소가 기준과 다름 (기준 자동 변경 금지) | LOCATION_DIFFERS + `diffs` |
| ambiguous | 후보가 여럿·인식 차이·오인식 후보·터미널 누락 | ASR_DISAGREEMENT, **ASR_CONFUSABLE**, TERMINAL_MISSING, MULTIPLE_CANDIDATES, CORRECTION_UNCLEAR |
| unrelated | 다른 선박 교신 | OTHER_VESSEL |
| unknown | 선박/장소 판별 불가, 등록 작업 없음 | VESSEL_MISSING, NO_TASK |

`ASR_CONFUSABLE`: 인식 결과가 실측 오인식 표기("펜트", "TNIC")로만 터미널을 가리킬 때. 후보(`uncertainties`)로만 보여 주고 확정하지 않는다.

## 추출 값 (entities)

`vessel, terminalId, berthId, time, distance, identifier(CALLSIGN 6KLM 등), changeIntent`
+ **`speed`**(예 `8kn`), **`course`**(예 `320°`), **`instructions`**(지시어 코드 배열):
`REDUCE_SPEED, PASS_PORT_TO_PORT, PASS_STBD_TO_STBD, KEEP_CLEAR, STAND_BY, BERTH, PROCEED, ALTER_COURSE_STBD, ALTER_COURSE_PORT, CORRECTION`

## 번역 (en / id / vi, 미얀마어 제외)

`requestTranslation(utteranceId, revision, lang)` 결과:

| 필드 | 내용 | 화면 |
|---|---|---|
| `summary` | **정형 요약** — 번역 모델 없이 추출값 + 해사 표준 문구로 만든 줄들. `lines[].uncertain` 이면 확정값처럼 보이지 않게 | 항상 먼저, 크게 |
| `text` + `reference: true` | 참고용 기계번역 (Opus-MT, 절 단위) | "참고 번역(부정확할 수 있음)" 라벨 |
| `status` | `ready` / `needs_check`(코드 값이 번역문에서 사라짐) / `unavailable`(문장 번역 없음, 요약은 있음) / `failed` | 상태 표시 |

`ko` 는 원문(불확실 값 `[HPNT / PNIT]` 표시), 미지원 언어(`my` 등)는 `summary: null, status: 'unavailable'`.

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

## 계약 확장 (문서 EngineClient 목록 외)

- `saveNote(taskId, text, noteId?)` — 일지 직접 메모
- `listTasks()` — 앱 재시작 후 작업 목록 복원
- `importTaskLog(json)` — `exportTaskLog(taskId, 'json')` 결과를 다시 불러오기 (미리 실제 모델로 분석해 둔 시연 일지). 음성은 미포함
- `markDisconnected(sessionId)` — 입력 장치 끊김 기록

## 구조

- `src/contracts/` — 공통 타입·이벤트·오류 코드·검증 (프론트와 공동 변경)
- `src/engine/rules/` — EntityResolver(추출), ComparisonEngine(비교)
- `src/engine/audio/` — 리샘플링, 잡음 완화(DSP, RNNoise), VAD 발화 분리
- `src/engine/translate/` — 보호 토큰, 정형 요약·해사 표준 문구
- `src/engine/models/` — transformers.js Whisper / Opus-MT provider
- `src/engine/assets/` — AssetManager (manifest·해시·자체 검사·오프라인 차단)
- `src/engine/core.ts` — EngineCore (EngineClient 구현)
- `src/repositories/` — IndexedDB TaskLogRepository (원자적 apply)
- `src/engine/online/` — 온라인 부품 (중계 서버 호출)
- `src/online/` + `server/` — 중계 서버와 외부 API 호출 (키는 서버에만)
- `src/workers/` — Worker 진입점
- `harness/` — 백엔드 검증 페이지 (`npm run harness`)
- `scripts/` — 평가: `eval-asr.ts`(원음/DSP/RNNoise, CER·핵심어), `eval-translate.ts`, `seg-probe.ts`
- `fixtures/audio/` — Windows/Azure TTS 시연 음성 + 합성 잡음 (**현장 성능 근거 아님**), `team/truth.json` 정답

## 실측 요약 (2026-11-27, 팀 합성 잡음 TTS 3건)

| 항목 | 결과 |
|---|---|
| 잡음 제거 vs 인식 (whisper-small CER) | 원음 43% / 우리 DSP 47% / RNNoise 89% → **인식은 원음, 완화음은 재생·교차 검사용** |
| 모델 크기 | small 대비 large-v3-turbo: CER 낮음(38~57%), 코드(HPNT 등)는 여전히 오인식, 1GB·1.5~2배 느림 → small 유지 |
| 장치 | 이 노트북: WASM 멀티스레드가 WebGPU 보다 2배 빠름 → 기본 WASM |
| 번역 | m2m100 사용 불가 → Opus-MT. 긴 문장 누락·고유명사 오역 → 정형 요약 중심 |

## 개발

```bash
npm test            # Vitest
npm run typecheck
npm run harness     # http://localhost:5181
npx vite-node --config vitest.config.ts scripts/eval-asr.ts fixtures/audio/team/*.wav
```

## 사용 모델·라이선스

| 역할 | 모델 | 라이선스 |
|---|---|---|
| ASR | onnx-community/whisper-small | MIT (Whisper 가중치) / Apache-2.0 (ONNX 변환) |
| 번역 | Xenova/opus-mt-ko-en, opus-mt-en-id, opus-mt-en-vi | CC-BY-4.0 (Helsinki-NLP) — 출처 표기 필요 |
| 잡음 제거(비교용) | @shiguredo/rnnoise-wasm (RNNoise) | Apache-2.0 / BSD-3 |
| 런타임 | @huggingface/transformers 4.3.2 (ONNX Runtime Web) | Apache-2.0 |
