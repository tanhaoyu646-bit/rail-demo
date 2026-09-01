// Training fixture transcribed from assets/documents/running-reveal.png.
// These historic example notices are not live railway operating instructions.
export type CardReveal = {
  order: string;
  line: string;
  direction: string;
  start: string;
  end: string;
  location: string;
  content: string;
};

const baselineRecords: readonly CardReveal[] = [
  { order: '21171', line: '通用线', direction: '下行', start: '2021-01-01 00:00', end: '2021-12-31 23:59',
    location: '丙站', content: '通用线丙站下行出站信号机施工，丙站下行方向凭绿色许可证发车。' },
  { order: '21172', line: '通用线', direction: '下行', start: '2021-01-01 00:00', end: '2021-12-31 23:59',
    location: '戊站', content: '通用线戊站下行进站信号机施工，戊站下行方向按特定引导接车进站。' },
];

export type DifferenceSource = 'published' | 'card';
export type ExerciseFault = 'none' | DifferenceSource;
export function seededRandom(key: string): () => number {
  let seed = 2166136261;
  for (const char of key) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => { seed += 0x6d2b79f5; let t = seed; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function introduceDifference(records: readonly CardReveal[], key: string): CardReveal[] {
  const random = seededRandom(`${key}:difference`), copy = records.map(r => ({ ...r }));
  const record = copy[Math.floor(random() * copy.length)];
  if (!record) return copy;
  switch (Math.floor(random() * 4)) {
    case 0: record.order = String(Number(record.order) + 100000); break;
    case 1: record.start = record.start.replace('00:00', '08:00'); break;
    case 2: {
      const direction = record.direction === '下行' ? '上行' : '下行';
      record.content = record.content.replaceAll(record.direction, direction); record.direction = direction; break;
    }
    default: record.content = record.content.includes('出站') ? record.content.replaceAll('出站', '进站') : record.content.replaceAll('进站', '出站');
  }
  return copy;
}
export type TrainingScenario = { studentId: string; paper: CardReveal[]; published: CardReveal[]; fault: ExerciseFault };
/** Deterministic local exercise assignment; no student data is uploaded. */
export function createTrainingScenario(studentId = '', mismatch: boolean | ExerciseFault | 'random' = false): TrainingScenario {
  const id=studentId.slice(0,40);
  let seed=0;
  for(const char of id) seed=(Math.imul(seed,31)+char.charCodeAt(0))>>>0;
  const random = seededRandom(id);
  const stations=id ? shuffled(['甲站','乙站','丙站','丁站','戊站','己站','庚站','辛站'],random).slice(0,2) : ['丙站','戊站'];
  const direction=id&&seed%2 ? '上行' : '下行';
  const line = id ? ['教学甲线','教学乙线','教学丙线'][seed%3] : '通用线';
  const month = String(1+Math.floor(random()*12)).padStart(2,'0');
  const day = 1+Math.floor(random()*22);
  const paper=(id ? shuffled(baselineRecords, random) : baselineRecords).map((record,index)=>({ ...record,
    order:id ? String(30000+(seed%30000)*2+index) : record.order,
    start:id ? `2026-${month}-${String(day).padStart(2,'0')} 00:00` : record.start,
    end:id ? `2026-${month}-${String(day+5).padStart(2,'0')} 23:59` : record.end,
    location:stations[index], direction, line,
    content:record.content.replaceAll(record.location,stations[index]).replaceAll('下行',direction).replaceAll('通用线',line),
  }));
  const draw = seededRandom(`${id}:fault`)();
  const fault: ExerciseFault = mismatch === 'random' ? (draw < .15 ? 'published' : draw < .30 ? 'card' : 'none') : mismatch === true ? 'published' : mismatch || 'none';
  const published = fault === 'published' ? introduceDifference(paper,id) : paper.map(record=>({...record}));
  return {studentId:id,paper,published,fault};
}
const params=new URLSearchParams(typeof window==='undefined' ? '' : window.location.search);
// One random assignment per page entry, stable throughout this entire attempt.
// Supplying a seed/student replays that assignment; it is never sent to a server.
const exerciseSeed = params.get('seed') || params.get('student') || (typeof window === 'undefined' ? ''
  : crypto.randomUUID?.().slice(0,8) ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`);
const requestedFault = params.get('fault');
const exerciseFault = params.get('revealMismatch') === '1' ? 'published'
  : requestedFault === 'none' || requestedFault === 'card' || requestedFault === 'published' ? requestedFault : 'random';
export const trainingScenario=createTrainingScenario(exerciseSeed, typeof window === 'undefined' ? false : exerciseFault);
export const paperRevealRecords: readonly CardReveal[]=trainingScenario.paper;
export const publishedRevealRecords: readonly CardReveal[]=trainingScenario.published;

export class TrainingCardMemory {
  private records: CardReveal[] = [];
  write(records: readonly CardReveal[]): void { this.records = records.map(record => ({ ...record })); }
  read(): CardReveal[] { return this.records.map(record => ({ ...record })); }
}

export function cardMatchesPaper(records: readonly CardReveal[], expected: readonly CardReveal[]=paperRevealRecords): boolean {
  if (records.length !== expected.length || new Set(records.map(r => r.order)).size !== records.length) return false;
  return expected.every(paper => {
    const card = records.find(record => record.order === paper.order);
    return card && (Object.keys(paper) as (keyof CardReveal)[]).every(key => card[key] === paper[key]);
  });
}
