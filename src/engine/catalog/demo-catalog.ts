import type { BerthEntry, CatalogManifest } from '../../contracts';

/**
 * 시연용 장소 카탈로그 (kind: 'demo').
 * 터미널 약어는 부산항 신항 실재 터미널이지만, 선석 T1~T5 와 별칭은 시연 fixture 다.
 * confusables 는 2026-11-27 팀 녹음 실측(whisper-small/turbo)에서 나온 오인식 표기 — 후보로만 연결한다.
 * 실제 운영 카탈로그는 터미널 공식 자료와 현장 호칭을 대조해 확정한다 (백엔드 03장).
 */
function demoBerths(): BerthEntry[] {
  const words = ['원', '투', '쓰리', '포', '파이브'];
  return [1, 2, 3, 4, 5].map((n) => ({
    berthId: `T${n}`,
    label: `T${n}`,
    aliases: [`T${n}`, `티${n}`, `티 ${n}`, `티${words[n - 1]}`, `${n}번 선석`, `${n}번선석`, `${n}선석`],
  }));
}

export const DEMO_CATALOG: CatalogManifest = {
  catalogVersion: 'demo-catalog-v1',
  kind: 'demo',
  sourceRefs: ['시연 fixture — 공식 자료 대조 전'],
  verifiedAt: null,
  terminals: [
    {
      terminalId: 'PNIT',
      officialName: 'Pusan Newport International Terminal',
      displayName: 'PNIT',
      aliases: ['PNIT', '피엔아이티', '피앤아이티', '피닛', '부산신항국제터미널', '신항국제터미널'],
      confusables: ['PNIC', 'TNIC', 'PNI', '피엔아이씨', '피니트'],
      port: '부산항 신항',
      berths: demoBerths(),
      sourceUrl: null,
      verifiedAt: null,
    },
    {
      terminalId: 'HPNT',
      officialName: 'HMM PSA Newport Terminal',
      displayName: 'HPNT',
      aliases: ['HPNT', '에이치피엔티', '에이치피앤티', 'HMM신항', '현대신항'],
      confusables: ['펜트', '팬티', '펜티', '에이치피엔티티'],
      port: '부산항 신항',
      berths: demoBerths(),
      sourceUrl: null,
      verifiedAt: null,
    },
    {
      terminalId: 'PNC',
      officialName: 'Pusan Newport Company',
      displayName: 'PNC',
      aliases: ['PNC', '피엔씨', '피앤씨', '부산신항만'],
      confusables: ['BNC', 'PNP', 'TNC', '피엔시'],
      port: '부산항 신항',
      berths: demoBerths(),
      sourceUrl: null,
      verifiedAt: null,
    },
    {
      terminalId: 'HJNC',
      officialName: 'Hanjin Newport Company',
      displayName: 'HJNC',
      aliases: ['HJNC', '에이치제이엔씨', '한진신항'],
      confusables: ['HJG', 'HJMC', 'HJNT', 'HGENC', 'HJENC', '에이치제이엔시'],
      port: '부산항 신항',
      berths: demoBerths(),
      sourceUrl: null,
      verifiedAt: null,
    },
    {
      terminalId: 'BNCT',
      officialName: 'Busan New Container Terminal',
      displayName: 'BNCT',
      aliases: ['BNCT', '비엔씨티', '비앤씨티'],
      port: '부산항 신항',
      berths: demoBerths(),
      sourceUrl: null,
      verifiedAt: null,
    },
    {
      terminalId: 'SINSEONDAE',
      officialName: '신선대부두',
      displayName: '신선대부두',
      aliases: ['신선대부두', '신선대 부두', '신선대'],
      // 실측 오인식: "신선대부도"
      confusables: ['신선대부도', '신선대 부도'],
      port: '부산항 북항',
      berths: demoBerths(),
      sourceUrl: null,
      verifiedAt: null,
    },
  ],
  // 시연 대본에 나오는 장소 (공식 자료 대조 전)
  places: [
    { placeId: 'OREUKDO', label: '오륙도', aliases: ['오륙도'] },
    { placeId: 'PALMIDO', label: '팔미도', aliases: ['팔미도'] },
    { placeId: 'GADEOK_CHANNEL', label: '가덕수로', aliases: ['가덕수로', '가덕 수로'] },
    { placeId: 'BUSAN_SOUTH_SEA', label: '부산 남쪽 바다', aliases: ['부산 남쪽 바다', '부산 남쪽'] },
    { placeId: 'NAMOEHANG', label: '부산남항 남외항', aliases: ['남외항'] },
    { placeId: 'BUSAN_PORT', label: '부산항', aliases: ['부산항'] },
    { placeId: 'INCHEON_PORT', label: '인천항', aliases: ['인천항'] },
  ],
};
