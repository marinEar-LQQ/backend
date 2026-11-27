import type { AnalysisResult, AnyEngineEvent, EngineClient, LangCode } from '../src/contracts';
import { DEFAULT_ASSET_MANIFEST } from '../src/engine/assets/asset-manager';
import { DEMO_TASK } from '../src/engine/fixtures/demo-scenario';
import { analyzePcm, decodeAudioFile } from '../src/engine/file-input';
import { PerfRecorder } from '../src/engine/metrics';
import { WorkerEngineClient } from '../src/engine/worker-client';
import EngineWorker from '../src/workers/engine.worker?worker';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $('log');
const log = (s: string) => {
  logEl.textContent = `${new Date().toLocaleTimeString()} ${s}\n` + logEl.textContent;
};

let engine: (EngineClient & { markDisconnected?: (id: string) => Promise<void> }) | null = null;
let taskId: string | null = null;
let perf = new PerfRecorder();
const latest = new Map<string, AnalysisResult>();
const order: string[] = [];

function render(): void {
  const lang = ($('lang') as HTMLSelectElement).value;
  $('rows').innerHTML = order
    .map((id, i) => {
      const r = latest.get(id);
      if (!r) return `<tr><td>${i + 1}</td><td colspan=6>분석 대기…</td></tr>`;
      const unc = r.uncertainties.filter((u) => u.field !== 'number').map((u) => `${u.field}: [${u.alternatives.join(' / ')}] (${u.reason})`).join('<br>');
      return `<tr>
        <td>${i + 1}${r.origin === 'fixture' ? ' <span class=badge>시연</span>' : ''}</td>
        <td>${r.revision} ${r.crossCheck}</td>
        <td class="k-${r.comparison.kind}">${r.comparison.kind}<br><small>${r.comparison.reasonCodes.join(', ')}</small></td>
        <td>E: ${r.enhancedTranscript?.text ?? '-'}<br>R: ${r.rawTranscript?.text ?? '-'}</td>
        <td>${unc}</td>
        <td><button data-tr="${id}" data-rev="${r.revision}">${lang}</button><div id="tr-${id}"></div></td>
        <td><button data-play="${id}" data-v="raw">원음</button><button data-play="${id}" data-v="enhanced">완화음</button></td>
      </tr>`;
    })
    .join('');
}

function onEvent(e: AnyEngineEvent): void {
  perf.onEvent(e);
  if (e.type === 'analysis.progress') {
    const p = e.payload as { stage: string; utterance?: { utteranceId: string } };
    if (p.stage === 'queued' && p.utterance) {
      order.push(p.utterance.utteranceId);
      render();
    }
    if (p.stage === 'failed') log(`발화 분석 실패 ${e.utteranceId}`);
  } else if (e.type === 'analysis.final') {
    const r = (e.payload as { result: AnalysisResult }).result;
    const prev = latest.get(r.utteranceId);
    if (!prev || prev.revision < r.revision) latest.set(r.utteranceId, r); // 늦은/중복 revision 무시
    render();
  } else if (e.type === 'engine.error' || e.type === 'input.status') {
    log(`${e.type} ${JSON.stringify(e.payload)}`);
  }
}

$('start').onclick = async () => {
  const mode = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value;
  const client = new WorkerEngineClient(new EngineWorker(), {
    fixtureMode: mode === 'fixture',
    allowRemote: !($('offline') as HTMLInputElement).checked,
    skipTranslation: ($('skipTr') as HTMLInputElement).checked,
  });
  engine = client;
  client.subscribe(onEvent);
  log(`엔진 시작 (${mode})`);
  if (mode === 'fixture') return log(JSON.stringify(await client.checkReadiness()));
  const t0 = performance.now();
  try {
    const r = await client.loadAssets(DEFAULT_ASSET_MANIFEST, (p) => {
      $('progress').textContent = `${p.modelId} ${p.status} ${(p.loadedBytes / 1e6).toFixed(1)}MB${p.totalBytes ? ` / ${(p.totalBytes / 1e6).toFixed(1)}MB` : ''}`;
    });
    log(`자원 준비 ${((performance.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify(r)}`);
  } catch (e) {
    log(`자원 준비 실패: ${(e as Error).message}`);
  }
};

$('ready').onclick = async () => engine && log(JSON.stringify(await engine.checkReadiness()));

$('seed').onclick = async () => {
  if (!engine) return log('엔진을 먼저 시작하세요');
  const { task, version } = await engine.saveTask(DEMO_TASK);
  taskId = task.taskId;
  log(`작업 등록 ${taskId} v${version.version}`);
};

async function analyzeBlob(blob: Blob, name: string): Promise<void> {
  if (!engine || !taskId) return log('엔진 시작과 작업 등록을 먼저 하세요');
  perf = new PerfRecorder();
  const { pcm, sampleRate, durationMs } = await decodeAudioFile(blob);
  log(`파일 ${name} ${(durationMs / 1000).toFixed(1)}s @${sampleRate}Hz`);
  await analyzePcm(engine, taskId, pcm, sampleRate, { fileName: name });
}

$('runSample').onclick = async () => {
  const url = ($('sample') as HTMLSelectElement).value;
  await analyzeBlob(await (await fetch(url)).blob(), url);
};
($('file') as HTMLInputElement).onchange = async (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (f) await analyzeBlob(f, f.name);
};

// 마이크 수신: getUserMedia + ScriptProcessor 대용 (하네스 전용. 실제 앱은 프론트 AudioWorklet)
let micStop: (() => Promise<void>) | null = null;
$('mic').onclick = async () => {
  if (!engine || !taskId) return log('엔진 시작과 작업 등록을 먼저 하세요');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: false, autoGainControl: false, echoCancellation: false } });
  const settings = stream.getAudioTracks()[0]!.getSettings();
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const session = await engine.openSession(taskId, 'live', {
    deviceLabel: stream.getAudioTracks()[0]!.label,
    sampleRate: ctx.sampleRate,
    appliedSettings: { noiseSuppression: !!settings.noiseSuppression, autoGainControl: !!settings.autoGainControl, echoCancellation: !!settings.echoCancellation },
  });
  let seq = 0;
  let samples = 0;
  proc.onaudioprocess = (ev) => {
    const pcm = new Float32Array(ev.inputBuffer.getChannelData(0));
    const frame = { sessionId: session.sessionId, seq: seq++, startMs: Math.round((samples / ctx.sampleRate) * 1000), sampleRate: ctx.sampleRate, channels: 1 as const, pcm };
    samples += pcm.length;
    void engine!.appendAudio(session.sessionId, frame);
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  log(`수신 중 ${settings.sampleRate ?? ctx.sampleRate}Hz, 설정 ${JSON.stringify(settings)}`);
  micStop = async () => {
    proc.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    await engine!.closeSession(session.sessionId);
  };
};
$('micStop').onclick = async () => {
  await micStop?.();
  micStop = null;
};

$('rows').onclick = async (ev) => {
  const t = ev.target as HTMLElement;
  if (!engine) return;
  if (t.dataset.tr) {
    const lang = ($('lang') as HTMLSelectElement).value as LangCode;
    const tr = await engine.requestTranslation(t.dataset.tr, Number(t.dataset.rev), lang);
    $(`tr-${t.dataset.tr}`).textContent = `[${tr.status}] ${tr.text ?? ''} ${tr.issues.join(' ')}`;
  }
  if (t.dataset.play) {
    const clip = await engine.getAudioClip(t.dataset.play, t.dataset.v as 'raw' | 'enhanced');
    if (clip.blob) void new Audio(URL.createObjectURL(clip.blob)).play();
    else log(`재생 불가: ${clip.status}`);
  }
};

$('perf').onclick = () => log(JSON.stringify(perf.summary(), null, 1));

async function download(format: 'txt' | 'json') {
  if (!engine || !taskId) return;
  const f = await engine.exportTaskLog(taskId, format);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([f.content], { type: f.mimeType }));
  a.download = f.filename;
  a.click();
}
$('export').onclick = () => download('txt');
$('exportJson').onclick = () => download('json');
