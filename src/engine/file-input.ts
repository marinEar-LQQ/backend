import type { AudioFrame, EngineClient, Session, SessionInputInfo } from '../contracts';

/**
 * 파일 입력 경로 (프론트 04장): 파일 디코딩 → 실시간 입력과 같은 AudioFrame 경로로 엔진에 전달.
 * decodeAudioFile 은 메인 스레드 전용 (Worker 에는 AudioContext 가 없다).
 */
export async function decodeAudioFile(file: Blob): Promise<{ pcm: Float32Array; sampleRate: number; durationMs: number }> {
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error('이 환경에서는 오디오 파일을 디코딩할 수 없습니다.');
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    // 채널 평균으로 mono (원래 sampleRate 유지)
    const pcm = new Float32Array(buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < data.length; i++) pcm[i] = pcm[i]! + data[i]! / buf.numberOfChannels;
    }
    return { pcm, sampleRate: buf.sampleRate, durationMs: Math.round(buf.duration * 1000) };
  } finally {
    void ctx.close();
  }
}

/** PCM 전체를 frameMs 단위 AudioFrame 으로 잘라 순서대로 보낸다 */
export async function streamPcm(client: EngineClient, sessionId: string, pcm: Float32Array, sampleRate: number, frameMs = 100): Promise<void> {
  const len = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  for (let i = 0, seq = 0; i < pcm.length; i += len, seq++) {
    const frame: AudioFrame = {
      sessionId,
      seq,
      startMs: Math.round((i / sampleRate) * 1000),
      sampleRate,
      channels: 1,
      pcm: pcm.slice(i, i + len),
    };
    await client.appendAudio(sessionId, frame);
  }
}

/** 파일 하나 분석: 세션 열기 → 프레임 전송 → 닫기. 분석 결과는 subscribe 이벤트로 도착한다. */
export async function analyzeFile(client: EngineClient, taskId: string, file: Blob & { name?: string }, inputInfo: SessionInputInfo = {}): Promise<Session> {
  const { pcm, sampleRate } = await decodeAudioFile(file);
  return analyzePcm(client, taskId, pcm, sampleRate, { fileName: file.name, sampleRate, ...inputInfo });
}

export async function analyzePcm(client: EngineClient, taskId: string, pcm: Float32Array, sampleRate: number, inputInfo: SessionInputInfo = {}): Promise<Session> {
  const session = await client.openSession(taskId, 'file', { sampleRate, ...inputInfo });
  await streamPcm(client, session.sessionId, pcm, sampleRate);
  return client.closeSession(session.sessionId);
}
