"""
marinEar 잡음 제거 서버 (DeepFilterNet3, MIT/Apache-2.0) — 중계 서버(server/index.ts)가 내부에서 호출한다.

  .venv/Scripts/python server/denoise.py        (http://127.0.0.1:8788)

  POST /denoise?atten=12   body: 16-bit mono WAV   → 16-bit mono WAV (입력과 같은 sampleRate, 같은 길이)
  GET  /health

atten (dB): 잡음을 최대 몇 dB 까지만 깎을지. 작을수록 말소리를 덜 건드린다 (음성인식 앞단용).
0 또는 생략이면 제한 없음(최대 제거).
모델은 시작할 때 한 번만 불러온다. 음성은 저장하지 않는다.
"""

import io
import json
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from urllib.parse import parse_qs, urlparse

import numpy as np
import torch
import torchaudio.functional as AF
from df.enhance import enhance, init_df

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
MAX_BODY = 20 * 1024 * 1024

torch.set_num_threads(max(1, torch.get_num_threads()))
print("DeepFilterNet 모델 불러오는 중...", flush=True)
MODEL, DF_STATE, _ = init_df()
MODEL_SR = DF_STATE.sr()  # 48000
LOCK = Lock()  # 모델은 동시에 한 요청만
print(f"준비 완료 (모델 {MODEL_SR}Hz)", flush=True)


def read_wav(data: bytes):
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("16-bit PCM WAV 만 지원")
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        pcm = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1)
    return pcm, sr


def write_wav(pcm: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(pcm, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def denoise(pcm: np.ndarray, sr: int, atten: float | None) -> np.ndarray:
    x = torch.from_numpy(pcm).unsqueeze(0)
    if sr != MODEL_SR:
        x = AF.resample(x, sr, MODEL_SR)
    with LOCK, torch.no_grad():
        y = enhance(MODEL, DF_STATE, x, atten_lim_db=atten)
    if sr != MODEL_SR:
        y = AF.resample(y, MODEL_SR, sr)
    out = y.squeeze(0).numpy()
    # 길이를 입력과 정확히 맞춘다 (시간축 보존)
    if len(out) >= len(pcm):
        return out[: len(pcm)]
    return np.pad(out, (0, len(pcm) - len(out)))


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, ctype: str):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self._send(200, json.dumps({"ok": True, "model": "DeepFilterNet3", "sr": MODEL_SR}).encode(), "application/json")
        self._send(404, b"{}", "application/json")

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/denoise":
            return self._send(404, b"{}", "application/json")
        try:
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > MAX_BODY:
                raise ValueError("본문 크기 오류")
            q = parse_qs(url.query)
            atten = float(q.get("atten", ["0"])[0]) or None
            t0 = time.perf_counter()
            pcm, sr = read_wav(self.rfile.read(size))
            out = denoise(pcm, sr, atten)
            body = write_wav(out, sr)
            print(f"denoise {len(pcm) / sr:.1f}s atten={atten} → {(time.perf_counter() - t0) * 1000:.0f}ms", flush=True)
            self._send(200, body, "audio/wav")
        except Exception as e:  # noqa: BLE001 — 오류 내용을 호출자에게 그대로 돌려준다
            self._send(400, json.dumps({"error": str(e)[:300]}).encode(), "application/json")

    def log_message(self, *_):  # 기본 접근 로그 끔
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
