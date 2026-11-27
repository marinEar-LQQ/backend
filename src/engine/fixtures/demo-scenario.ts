import type { TaskDraft } from '../../contracts';

/**
 * 시연 고정 데이터 — 팀 대본 3개(9개 대사). 실제 모델 결과가 아니다:
 * origin='fixture', session.inputInfo.fixtureMode=true 로 표시되고 화면은 "시연 데이터" 배지로 구분해야 한다.
 *
 * 시연 작업은 "현대부산호를 PNIT 2번 선석으로" 잘못 등록해 둔 상태 → 대본 1의 "HPNT 이번 선석"이 장소 차이로 잡힌다.
 * 대본 1 세 번째 대사의 원음 인식은 실측 오인식("TNIC")을 그대로 넣어 "확인 필요" 흐름을 보여 준다.
 */

export interface DemoLine {
  id: string;
  label: string;
  /** 완화음 인식 결과 (시연용) */
  enhanced: string;
  /** 원음 인식 결과 (시연용) */
  raw: string;
  /** 합성 음성 길이 */
  durationMs: number;
}

export const DEMO_TASK: TaskDraft = {
  ownVessel: '해동호',
  targetVessel: '현대부산호',
  terminalId: 'PNIT',
  berthId: 'T2',
  note: '시연 작업 (대본 1 기준)',
};

const same = (id: string, label: string, text: string, durationMs: number): DemoLine => ({ id, label, enhanced: text, raw: text, durationMs });

export const DEMO_SCENARIO: DemoLine[] = [
  same('s1-1', '대본1 · 현대부산호 호출 (장소 차이: 기록 PNIT, 교신 HPNT)',
    '부산항 관제, 부산항 관제, 여기는 현대부산호, 호출부호 6KLM. 현재 가덕수로 통과 중이며 차항지 HPNT 이번 선석 접안 예정입니다. 침로 삼이공도, 속력 일일 노트입니다. 오바.', 4200),
  same('s1-2', '대본1 · VTS 지시 (감속·좌현 대 좌현)',
    '현대부산호, 여기는 부산항 VTS. 현재 PNIT 일번 선석에서 출항 중인 외항선 있으니 속력 팔 노트로 감속하시고 좌현 대 좌현으로 통과하십시오. HPNT 접안 예정 시각 일사시 삼십분 확인되었습니다. 이상.', 4600),
  {
    id: 's1-3',
    label: '대본1 · 현대부산호 응답 (원음 오인식 TNIC → 확인 필요)',
    enhanced: '수신 양호. 속력 팔 노트로 감속 후 PNIT 출항선 좌현 대 좌현 통과하겠습니다. 현대부산호 이상.',
    raw: '수신 양호. 속력 팔 노트로 감속 후 TNIC 출항선 좌현 대 좌현 통과하겠습니다. 현대부산호 이상.',
    durationMs: 3400,
  },
  same('s2-1', '대본2 · 한진오션호 (영어 교신, 다른 선박)',
    'Busan VTS, Busan VTS, this is Hanjin Ocean, call sign D7AB. Approaching Gadeok channel, destination PNC berth three, course zero-one-five, speed ten knots. Over.', 4000),
  same('s2-2', '대본2 · VTS 지시 (우회·이동)',
    '한진오션호, 여기는 부산항 VTS. 현재 HJNC 전방 해역에 준설 작업선 작업 중이니 우현으로 여유 있게 우회하시고, PNC 삼번 선석 도선사 승선 지점까지 이동하십시오. 이상.', 4200),
  same('s2-3', '대본2 · 한진오션호 응답 (영어)',
    'Roger, keeping clear to starboard of HJNC area, proceeding to pilot station for PNC berth three. Hanjin Ocean out.', 3000),
  same('s3-1', '대본3 · 어선 호출',
    '아, 제205동해호에서 제108한성호 감도 있나? 부산남항 남외항 해역이다. 오바.', 2600),
  same('s3-2', '대본3 · 어군 위치',
    '여기는 제108한성호. 감도 양호하다. 현재 북위 삼오도 영삼분, 동경 일이구도 일일분 지점에 고등어 어군 크게 잡혔다. 침로 이일오도, 속력 칠 노트로 이동 중이다. 오바.', 4400),
  same('s3-3', '대본3 · 지시 (우현 변침·대기)',
    '확인했다. 한성호는 우현으로 크게 돌아서 어군 막아주고, 제302운반선은 본선 좌현 백 미터 거리 유지하면서 부산공동어시장 입항 대기해라. 오바.', 4200),
];

/**
 * 팀 녹음 파일(fixtures/audio/team/scriptN_noisy.wav)을 시연 모드로 분석할 때 쓰는 발화별 대본.
 * 현재 VAD 설정(offRatio 2.5, hangover 500ms)으로 잘린 구간 순서에 맞췄다. 구간 수가 달라지면 남는 구간은 빈 자막.
 */
export const TEAM_AUDIO_SCRIPT: Record<string, Array<{ enhanced: string; raw?: string }>> = {
  script1: [
    { enhanced: '부산항 관제, 부산항 관제, 여기는 현대부산호, 호출부호 6KLM. 현재 가덕수로 통과 중이며 차항지 HPNT 이번 선석 접안 예정입니다.' },
    { enhanced: '현대부산호 침로 삼이공도, 속력 일일 노트입니다.' },
    { enhanced: '오바.' },
    { enhanced: '현대부산호, 여기는 부산항 VTS.' },
    { enhanced: '현대부산호, 현재 PNIT 일번 선석에서 출항 중인 외항선 있으니 속력 팔 노트로 감속하시고 좌현 대 좌현으로 통과하십시오. HPNT 접안 예정 시각 일사시 삼십분 확인되었습니다. 이상.' },
    {
      enhanced: '수신 양호. 속력 팔 노트로 감속 후 PNIT 출항선 좌현 대 좌현 통과하겠습니다. 현대부산호 이상.',
      raw: '수신 양호. 속력 팔 노트로 감속 후 TNIC 출항선 좌현 대 좌현 통과하겠습니다. 현대부산호 이상.',
    },
  ],
  script2: [
    { enhanced: 'Busan VTS, Busan VTS, this is Hanjin Ocean, call sign D7AB. Approaching Gadeok channel, destination PNC berth three, course zero-one-five, speed ten knots. Over.' },
    { enhanced: '한진오션호, 여기는 부산항 VTS.' },
    { enhanced: '한진오션호, 현재 HJNC 전방 해역에 준설 작업선 작업 중이니 우현으로 여유 있게 우회하시고, PNC 삼번 선석 도선사 승선 지점까지 이동하십시오. 이상.' },
    { enhanced: 'Roger, keeping clear to starboard of HJNC area, proceeding to pilot station for PNC berth three. Hanjin Ocean out.' },
  ],
  script3: [
    { enhanced: '아, 제205동해호에서 제108한성호 감도 있나?' },
    { enhanced: '부산남항 남외항 해역이다. 오바.' },
    { enhanced: '여기는 제108한성호. 감도 양호하다.' },
    { enhanced: '현재 북위 삼오도 영삼분, 동경 일이구도 일일분 지점에 고등어 어군 크게 잡혔다.' },
    { enhanced: '침로 이일오도, 속력 칠 노트로 이동 중이다. 오바.' },
    { enhanced: '확인했다.' },
    { enhanced: '한성호는 우현으로 크게 돌아서 어군 막아주고, 제302운반선은 본선 좌현 백 미터 거리 유지하면서' },
    { enhanced: '부산공동어시장 입항 대기해라. 오바.' },
  ],
};
