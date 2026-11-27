import { EngineError, type LangCode, type Transcript } from '../../contracts';
import type { AsrContext, AsrProvider, TranslationProvider } from '../providers';
import { DEMO_SCENARIO, TEAM_AUDIO_SCRIPT, type DemoLine } from './demo-scenario';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 시연 고정 ASR: 세션 내 발화 순번으로 시나리오 문장을 돌려준다. 실제 인식이 아니다. */
export class FixtureAsr implements AsrProvider {
  readonly modelVersion = 'fixture-asr-v1';
  readonly sampleRate = 16000 as const;

  constructor(
    private readonly lines: DemoLine[] = DEMO_SCENARIO,
    private readonly delayMs = 250,
  ) {}

  async transcribe(pcm16k: Float32Array, ctx: AsrContext): Promise<Transcript> {
    if (this.delayMs) await sleep(this.delayMs);
    // 팀 녹음 파일이면 파일별 대본, 아니면 시나리오 순서대로
    const teamKey = ctx.sessionFile ? Object.keys(TEAM_AUDIO_SCRIPT).find((k) => ctx.sessionFile!.includes(k)) : undefined;
    let text: string;
    if (teamKey) {
      const seg = TEAM_AUDIO_SCRIPT[teamKey]![ctx.utteranceIndex];
      text = seg ? (ctx.variant === 'raw' ? (seg.raw ?? seg.enhanced) : seg.enhanced) : '';
    } else {
      const line = this.lines[ctx.utteranceIndex % Math.max(1, this.lines.length)];
      text = line ? (ctx.variant === 'raw' ? line.raw : line.enhanced) : '';
    }
    const endMs = ctx.utteranceStartMs + Math.round((pcm16k.length / 16000) * 1000);
    return {
      text,
      segments: [{ segmentId: `${ctx.utteranceId}-${ctx.variant}-0`, text, startMs: ctx.utteranceStartMs, endMs, confidence: null }],
      modelVersion: this.modelVersion,
      wordAligned: false,
    };
  }
}

/** 팀 대본 9개 대사의 시연용 번역 (placeholder 문장 → en/id/vi). id/vi 는 원어민 검수 전. 실제 모델 번역이 아니다. */
export const FIXTURE_TRANSLATIONS: Record<string, Partial<Record<LangCode, string>>> = {
  // 독백 시연 녹음 (team3: mono-a/b/c)
  "부산항 관제, 여기는 [1]입니다. 지금 오륙도 근처를 지나고 있습니다. [2] [3]에 배를 댈 예정이고, 속도는 12노트입니다. 앞에 나가는 배가 보여서 속도를 8노트로 줄이고 오른쪽으로 비켜 가겠습니다. 도착은 [4]쯤 예상합니다. 이상.": {"en":"Busan Port Control, this is [1]. We are now passing near Oryukdo. We plan to berth at [2] [3]; our speed is 12 knots. We see a ship departing ahead, so we will reduce speed to 8 knots and give way to starboard. Expected arrival around [4]. Out.","id":"Kontrol Pelabuhan Busan, di sini [1]. Kami sedang melintas dekat Oryukdo. Kami akan sandar di [2] [3]; kecepatan kami 12 knot. Ada kapal yang keluar di depan, jadi kami akan mengurangi kecepatan menjadi 8 knot dan menghindar ke kanan. Perkiraan tiba sekitar pukul [4]. Selesai.","vi":"Điều hành cảng Busan, đây là [1]. Chúng tôi đang đi qua gần Oryukdo. Chúng tôi dự kiến cập [2] [3]; tốc độ hiện tại 12 hải lý/giờ. Phía trước có tàu đang ra, nên chúng tôi sẽ giảm tốc độ xuống 8 hải lý/giờ và tránh sang phải. Dự kiến đến khoảng [4]. Hết."},
  "인천항 관제, 여기는 [1]입니다. 엔진에 문제가 생겨서 속도가 잘 안 납니다. 지금 위치는 팔미도 남쪽 [2]입니다.": {"en":"Incheon Port Control, this is [1]. We have engine trouble and cannot make speed. Our position is [2] south of Palmido.","id":"Kontrol Pelabuhan Incheon, di sini [1]. Mesin kami bermasalah sehingga kecepatan tidak bisa naik. Posisi kami [2] di selatan Palmido.","vi":"Điều hành cảng Incheon, đây là [1]. Động cơ của chúng tôi gặp sự cố nên không lên được tốc độ. Vị trí hiện tại cách Palmido [2] về phía nam."},
  "끌어 줄 배가 필요합니다. 20분 정도는 이 자리에서 기다릴 수 있습니다. 주변 배들은 [1] 이상 떨어져 주시고, 연락은 [2]로 부탁드립니다.": {"en":"We need a tow. We can hold this position for about 20 minutes. Vessels nearby, please keep more than [1] clear, and contact us on [2].","id":"Kami membutuhkan kapal tunda. Kami dapat menunggu di posisi ini sekitar 20 menit. Kapal-kapal di sekitar mohon menjaga jarak lebih dari [1], dan hubungi kami di [2].","vi":"Chúng tôi cần tàu kéo. Chúng tôi có thể chờ tại vị trí này khoảng 20 phút. Các tàu xung quanh vui lòng giữ khoảng cách trên [1], và liên lạc qua [2]."},
  "[1], 여기는 [2]. 지금 부산 남쪽 바다에서 고등어 떼를 크게 봤다. 깊이는 [3]쯤 되고, 동쪽으로 움직이고 있다. 우리는 30분 안에 그쪽으로 간다. 너는 왼쪽으로 [4] 떨어져서 기다려라.": {"en":"[1], this is [2]. We just spotted a large school of mackerel in the sea south of Busan. Depth is about [3], and it is moving east. We will get there within 30 minutes. You stand by [4] off to port (left).","id":"[1], di sini [2]. Kami baru melihat gerombolan ikan makerel besar di laut selatan Busan. Kedalamannya sekitar [3], dan bergerak ke timur. Kami akan tiba di sana dalam 30 menit. Kamu tunggu dengan jarak [4] di sisi kiri.","vi":"[1], đây là [2]. Chúng tôi vừa thấy một đàn cá thu lớn ở vùng biển phía nam Busan. Độ sâu khoảng [3], đàn cá đang di chuyển về phía đông. Chúng tôi sẽ đến đó trong vòng 30 phút. Các anh chờ ở phía bên trái, cách [4]."},
  "이상.": {"en":"Out.","id":"Selesai.","vi":"Hết."},
  // 시연 녹음 구간별 (mono_noisy, script2·3)
  "오늘 바람이 많이 부네.": {"en":"It's really windy today.","id":"Hari ini anginnya kencang sekali.","vi":"Hôm nay gió to quá."},
  "[1]에 교대하고 라면이나 먹어야겠다.": {"en":"I'll change watch at [1] and then have some ramen.","id":"Saya akan berganti jaga pukul [1], lalu makan ramen.","vi":"Đổi ca lúc [1] xong rồi đi ăn mì thôi."},
  "Busan VTS, Busan VTS, this is [1], [2]. Approaching Gadeok channel, destination [3] [4], course zero-one-five, speed ten knots. Over. [5], 여기는 부산항 VTS.": {"en":"Busan VTS, Busan VTS, this is [1], [2]. Approaching Gadeok channel, destination [3] [4], course 015, speed 10 knots. Over. [5], this is Busan Port VTS.","id":"VTS Busan, VTS Busan, di sini [1], [2]. Mendekati Alur Gadeok, tujuan [3] [4], haluan 015, kecepatan 10 knot. Ganti. [5], di sini VTS Pelabuhan Busan.","vi":"VTS Busan, VTS Busan, đây là [1], [2]. Đang tiến vào luồng Gadeok, đích đến [3] [4], hướng đi 015, tốc độ 10 hải lý/giờ. Hết. [5], đây là VTS cảng Busan."},
  "[1], 현재 [2] 전방 해역에 준설 작업선 작업 중이니 우현으로 여유 있게 우회하시고, [3] [4] 도선사 승선 지점까지 이동하십시오. 이상. Roger, keeping clear to starboard of [5] area, proceeding to pilot station for [6] [7]. Hanjin Ocean out.": {"en":"[1], a dredger is working in the area ahead of [2]; keep well clear to starboard and proceed to the pilot boarding point for [3] [4]. Out. Roger, keeping clear to starboard of [5] area, proceeding to pilot station for [6] [7]. Hanjin Ocean out.","id":"[1], kapal keruk sedang bekerja di perairan depan [2]; memutar dengan jarak aman ke kanan dan lanjutkan ke titik naik pandu untuk [3] [4]. Selesai. Dimengerti, menjaga jarak ke kanan dari area [5], menuju stasiun pandu untuk [6] [7]. Hanjin Ocean selesai.","vi":"[1], tàu nạo vét đang làm việc ở vùng nước phía trước [2]; hãy đi vòng rộng sang phải và di chuyển đến điểm đón hoa tiêu của [3] [4]. Hết. Đã rõ, giữ khoảng cách bên phải khu vực [5], đang đến trạm hoa tiêu của [6] [7]. Hanjin Ocean hết."},
  "아, [1]에서 [2] 감도 있나?": {"en":"[1] calling [2], do you read me?","id":"[1] memanggil [2], apakah terdengar?","vi":"[1] gọi [2], có nghe rõ không?"},
  "부산남항 남외항 해역이다. 오바.": {"en":"We are in the outer harbor of Busan South Port. Over.","id":"Kami berada di perairan pelabuhan luar Busan Selatan. Ganti.","vi":"Chúng tôi đang ở vùng ngoài cảng Nam Busan. Hết."},
  "[1], 현재 [2] 전방 해역에 준설 작업선 작업 중이니 우현으로 여유 있게 우회하시고, [3] [4] 도선사 승선 지점까지 이동하십시오. 이상.": {"en":"[1], a dredger is working in the area ahead of [2]; keep well clear to starboard and proceed to the pilot boarding point for [3] [4]. Out.","id":"[1], kapal keruk sedang bekerja di perairan depan [2]; memutar dengan jarak aman ke kanan dan lanjutkan ke titik naik pandu untuk [3] [4]. Selesai.","vi":"[1], tàu nạo vét đang làm việc ở vùng nước phía trước [2]; hãy đi vòng rộng sang phải và di chuyển đến điểm đón hoa tiêu của [3] [4]. Hết."},
  // 팀 녹음 1 구간별 (TEAM_AUDIO_SCRIPT.script1)
  "부산항 관제, 부산항 관제, 여기는 [1], [2]. 현재 가덕수로 통과 중이며 차항지 [3] [4] 접안 예정입니다.": {"en":"Busan Port Control, Busan Port Control, this is [1], [2]. Now passing Gadeok Channel, next port [3] [4], expecting to berth.","id":"Kontrol Pelabuhan Busan, Kontrol Pelabuhan Busan, di sini [1], [2]. Sedang melewati Alur Gadeok, pelabuhan berikutnya [3] [4], dijadwalkan sandar.","vi":"Điều hành cảng Busan, điều hành cảng Busan, đây là [1], [2]. Đang đi qua luồng Gadeok, cảng đến [3] [4], dự kiến cập cầu."},
  "[1] 침로 삼이공도, 속력 일일 노트입니다.": {"en":"[1]: course 320 degrees, speed 11 knots.","id":"[1]: haluan 320 derajat, kecepatan 11 knot.","vi":"[1]: hướng đi 320 độ, tốc độ 11 hải lý/giờ."},
  "오바.": {"en":"Over.","id":"Ganti.","vi":"Hết."},
  "[1], 여기는 부산항 VTS.": {"en":"[1], this is Busan Port VTS.","id":"[1], di sini VTS Pelabuhan Busan.","vi":"[1], đây là VTS cảng Busan."},
  "[1], 현재 [2] [3]에서 출항 중인 외항선 있으니 속력 팔 노트로 감속하시고 좌현 대 좌현으로 통과하십시오. [4] 접안 예정 시각 일사시 삼십분 확인되었습니다. 이상.": {"en":"[1], an outbound ship is leaving [2] [3]; reduce speed to 8 knots and pass port to port. Your berthing time at [4], 14:30, is confirmed. Out.","id":"[1], ada kapal yang sedang keluar dari [2] [3]; kurangi kecepatan menjadi 8 knot dan berpapasan lambung kiri dengan lambung kiri. Waktu sandar di [4] pukul 14:30 sudah dikonfirmasi. Selesai.","vi":"[1], có tàu đang rời [2] [3]; hãy giảm tốc độ xuống 8 hải lý/giờ và tránh nhau mạn trái với mạn trái. Thời gian cập cầu tại [4] lúc 14:30 đã được xác nhận. Hết."},
  "부산항 관제, 부산항 관제, 여기는 [1], [2]. 현재 가덕수로 통과 중이며 차항지 [3] [4] 접안 예정입니다. 침로 삼이공도, 속력 일일 노트입니다. 오바.": {
    "en": "Busan Port Control, Busan Port Control, this is [1], [2]. Now passing Gadeok Channel, next port [3] [4], expecting to berth. Course 320 degrees, speed 11 knots. Over.",
    "id": "Kontrol Pelabuhan Busan, Kontrol Pelabuhan Busan, di sini [1], [2]. Sedang melewati Alur Gadeok, pelabuhan berikutnya [3] [4], dijadwalkan sandar. Haluan 320 derajat, kecepatan 11 knot. Ganti.",
    "vi": "Điều hành cảng Busan, điều hành cảng Busan, đây là [1], [2]. Đang đi qua luồng Gadeok, cảng đến [3] [4], dự kiến cập cầu. Hướng đi 320 độ, tốc độ 11 hải lý/giờ. Hết."
  },
  "[1], 여기는 부산항 VTS. 현재 [2] [3]에서 출항 중인 외항선 있으니 속력 팔 노트로 감속하시고 좌현 대 좌현으로 통과하십시오. [4] 접안 예정 시각 일사시 삼십분 확인되었습니다. 이상.": {
    "en": "[1], this is Busan Port VTS. An outbound ship is leaving [2] [3]; reduce speed to 8 knots and pass port to port. Your berthing time at [4], 14:30, is confirmed. Out.",
    "id": "[1], di sini VTS Pelabuhan Busan. Ada kapal yang sedang keluar dari [2] [3]; kurangi kecepatan menjadi 8 knot dan berpapasan lambung kiri dengan lambung kiri. Waktu sandar di [4] pukul 14:30 sudah dikonfirmasi. Selesai.",
    "vi": "[1], đây là VTS cảng Busan. Có tàu đang rời [2] [3]; hãy giảm tốc độ xuống 8 hải lý/giờ và tránh nhau mạn trái với mạn trái. Thời gian cập cầu tại [4] lúc 14:30 đã được xác nhận. Hết."
  },
  "수신 양호. 속력 팔 노트로 감속 후 [1] 출항선 좌현 대 좌현 통과하겠습니다. [2] 이상.": {
    "en": "Reading you clearly. Reducing speed to 8 knots, will pass the outbound ship from [1] port to port. [2] out.",
    "id": "Diterima dengan jelas. Mengurangi kecepatan menjadi 8 knot, akan berpapasan lambung kiri dengan lambung kiri dengan kapal yang keluar dari [1]. [2] selesai.",
    "vi": "Nghe rõ. Giảm tốc độ xuống 8 hải lý/giờ, sẽ tránh tàu rời [1] mạn trái với mạn trái. [2] hết."
  },
  "Busan VTS, Busan VTS, this is [1], [2]. Approaching Gadeok channel, destination [3] [4], course zero-one-five, speed ten knots. Over.": {
    "en": "Busan VTS, Busan VTS, this is [1], [2]. Approaching Gadeok channel, destination [3] [4], course 015, speed 10 knots. Over.",
    "id": "VTS Busan, VTS Busan, di sini [1], [2]. Mendekati Alur Gadeok, tujuan [3] [4], haluan 015, kecepatan 10 knot. Ganti.",
    "vi": "VTS Busan, VTS Busan, đây là [1], [2]. Đang tiến vào luồng Gadeok, đích đến [3] [4], hướng đi 015, tốc độ 10 hải lý/giờ. Hết."
  },
  "[1], 여기는 부산항 VTS. 현재 [2] 전방 해역에 준설 작업선 작업 중이니 우현으로 여유 있게 우회하시고, [3] [4] 도선사 승선 지점까지 이동하십시오. 이상.": {
    "en": "[1], this is Busan Port VTS. A dredger is working in the area ahead of [2]; keep well clear to starboard and proceed to the pilot boarding point for [3] [4]. Out.",
    "id": "[1], di sini VTS Pelabuhan Busan. Kapal keruk sedang bekerja di perairan depan [2]; memutar dengan jarak aman ke kanan dan lanjutkan ke titik naik pandu untuk [3] [4]. Selesai.",
    "vi": "[1], đây là VTS cảng Busan. Tàu nạo vét đang làm việc ở vùng nước phía trước [2]; hãy đi vòng rộng sang phải và di chuyển đến điểm đón hoa tiêu của [3] [4]. Hết."
  },
  "Roger, keeping clear to starboard of [1] area, proceeding to pilot station for [2] [3]. Hanjin Ocean out.": {
    "en": "Roger, keeping clear to starboard of [1] area, proceeding to pilot station for [2] [3]. Hanjin Ocean out.",
    "id": "Dimengerti, menjaga jarak ke kanan dari area [1], menuju stasiun pandu untuk [2] [3]. Hanjin Ocean selesai.",
    "vi": "Đã rõ, giữ khoảng cách bên phải khu vực [1], đang đến trạm hoa tiêu của [2] [3]. Hanjin Ocean hết."
  },
  "아, [1]에서 [2] 감도 있나? 부산남항 남외항 해역이다. 오바.": {
    "en": "[1] calling [2], do you read me? We are in the outer harbor of Busan South Port. Over.",
    "id": "[1] memanggil [2], apakah terdengar? Kami berada di perairan pelabuhan luar Busan Selatan. Ganti.",
    "vi": "[1] gọi [2], có nghe rõ không? Chúng tôi đang ở vùng ngoài cảng Nam Busan. Hết."
  },
  "여기는 [1]. 감도 양호하다. 현재 북위 삼오도 영삼분, 동경 일이구도 일일분 지점에 고등어 어군 크게 잡혔다. 침로 이일오도, 속력 칠 노트로 이동 중이다. 오바.": {
    "en": "This is [1]. Reading you clearly. A large school of mackerel found at 35°03′N, 129°11′E. Moving on course 215 degrees at 7 knots. Over.",
    "id": "Di sini [1]. Terdengar jelas. Gerombolan ikan makerel besar ditemukan di 35°03′LU, 129°11′BT. Bergerak dengan haluan 215 derajat, kecepatan 7 knot. Ganti.",
    "vi": "Đây là [1]. Nghe rõ. Phát hiện đàn cá thu lớn tại 35°03′B, 129°11′Đ. Đang di chuyển hướng 215 độ, tốc độ 7 hải lý/giờ. Hết."
  },
  "확인했다. [1]는 우현으로 크게 돌아서 어군 막아주고, 제302운반선은 본선 좌현 백 미터 거리 유지하면서 부산공동어시장 입항 대기해라. 오바.": {
    "en": "Understood. [1], turn wide to starboard and block the school. Carrier No.302, keep 100 m off our port side and stand by to enter Busan Cooperative Fish Market. Over.",
    "id": "Dimengerti. [1], putar lebar ke kanan dan halangi gerombolan ikan. Kapal angkut No.302, jaga jarak 100 m di sisi kiri kapal kami dan siaga untuk masuk ke Pasar Ikan Koperasi Busan. Ganti.",
    "vi": "Đã rõ. [1], quay rộng sang phải để chặn đàn cá. Tàu chở hàng số 302, giữ cách mạn trái tàu chúng ta 100 m và chờ vào Chợ cá Hợp tác Busan. Hết."
  }
};

export class FixtureTranslator implements TranslationProvider {
  readonly modelVersion = 'fixture-translation-v1';
  constructor(
    private readonly table = FIXTURE_TRANSLATIONS,
    private readonly langs: LangCode[] = ['en', 'id', 'vi'],
    private readonly delayMs = 150,
  ) {}

  supports(target: LangCode): boolean {
    return this.langs.includes(target);
  }

  async translate(text: string, target: LangCode): Promise<string> {
    if (this.delayMs) await sleep(this.delayMs);
    const hit = this.table[text]?.[target];
    // 표에 없는 문장은 "문장 번역 없음"(unavailable) — 정형 요약은 그대로 제공된다
    if (!hit) throw new EngineError('TRANSLATION_UNAVAILABLE', '시연 번역 데이터에 없는 문장입니다.', true);
    return hit;
  }
}

/**
 * 시연용 합성 음성 (발화마다 다른 기본 주파수의 음절형 신호 + 무전 잡음).
 * 실제 녹음이 아니다. 같은 합성음이 원음/완화음 양쪽에 쓰이지 않도록, 완화음은 엔진이 이 신호를 실제로 처리해 만든다.
 */
export function synthesizeScenarioAudio(lines: DemoLine[] = DEMO_SCENARIO, sampleRate = 16000, gapMs = 1500): Float32Array {
  const total = lines.reduce((n, l) => n + l.durationMs + gapMs, gapMs);
  const out = new Float32Array(Math.round((total / 1000) * sampleRate));
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = 0.004 * rnd(); // 배경 잡음
  let cursor = gapMs;
  lines.forEach((line, li) => {
    const f0 = 140 + li * 15;
    const start = Math.round((cursor / 1000) * sampleRate);
    const n = Math.round((line.durationMs / 1000) * sampleRate);
    for (let i = 0; i < n && start + i < out.length; i++) {
      const t = i / sampleRate;
      const syll = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t); // 초당 4음절
      const env = Math.min(1, i / 800, (n - i) / 800);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      out[start + i] = out[start + i]! + 0.12 * v * syll * env + 0.02 * rnd();
    }
    cursor += line.durationMs + gapMs;
  });
  return out;
}
