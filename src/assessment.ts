export type TrainingMode = 'teaching' | 'assessment';

export type LearnerProfile = {
  studentId: string;
  studentName: string;
  mode: TrainingMode;
};

export type AssessmentScores = {
  kioskComplete: number;
  documents: number;
  publishedReveal: number;
  cardReveal: number;
  kioskQuiz: number;
  deputyMeeting: number;
  dispatcherCount: number;
  dispatcherQuestions: number;
};

const profileStorageKey = 'rail-training-profile-v1';
const emptyScores = (): AssessmentScores => ({
  kioskComplete: 0, documents: 0, publishedReveal: 0, cardReveal: 0,
  kioskQuiz: 0, deputyMeeting: 0, dispatcherCount: 0, dispatcherQuestions: 0,
});

const escapeHtml = (value: string): string => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char);

function readProfile(): LearnerProfile | null {
  try {
    const stored = sessionStorage.getItem(profileStorageKey);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as LearnerProfile;
    if (!parsed.studentId || !parsed.studentName || (parsed.mode !== 'teaching' && parsed.mode !== 'assessment')) return null;
    return parsed;
  } catch { return null; }
}

const query = new URLSearchParams(window.location.search);
const storedProfile = readProfile();
export const learnerProfile: LearnerProfile | null = storedProfile
  && storedProfile.studentId === query.get('student')
  && storedProfile.mode === query.get('mode')
  ? storedProfile : null;

export const assessmentMode = learnerProfile?.mode === 'assessment';
export const assessmentScores = emptyScores();

export function setScore(key: keyof AssessmentScores, points: number): void {
  if (!assessmentMode) return;
  assessmentScores[key] = Math.max(0, Math.min(10, points));
}

export function scoreKioskCompletion(): void {
  if (!assessmentMode) return;
  assessmentScores.kioskComplete = 30;
}

export function totalScore(): number {
  return Object.values(assessmentScores).reduce((sum, value) => sum + value, 0);
}

export function mountEntryGate(host: HTMLElement): void {
  if (learnerProfile) return;
  host.innerHTML = `
    <section class="entry-gate" role="dialog" aria-modal="true" aria-label="进入实训">
      <form class="entry-card">
        <p>电力机车乘务作业</p>
        <h1>出勤虚拟实训</h1>
        <label>学号<input name="studentId" required maxlength="40" autocomplete="off" inputmode="numeric" placeholder="请输入学号"></label>
        <label>姓名<input name="studentName" required maxlength="24" autocomplete="name" placeholder="请输入姓名"></label>
        <fieldset><legend>实训模式</legend>
          <label><input type="radio" name="mode" value="teaching" checked> 教学模式</label>
          <label><input type="radio" name="mode" value="assessment"> 考评模式</label>
        </fieldset>
        <button class="primary" type="submit">进入实训</button>
      </form>
    </section>`;
  const form = host.querySelector<HTMLFormElement>('form');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const studentId = String(data.get('studentId') ?? '').trim();
    const studentName = String(data.get('studentName') ?? '').trim();
    const mode = data.get('mode') === 'assessment' ? 'assessment' : 'teaching';
    if (!studentId || !studentName) return;
    const profile: LearnerProfile = { studentId, studentName, mode };
    sessionStorage.setItem(profileStorageKey, JSON.stringify(profile));
    const next = new URL(window.location.href);
    next.searchParams.set('student', studentId);
    next.searchParams.set('mode', mode);
    next.searchParams.delete('seed');
    window.location.replace(next.toString());
  });
}

export function mountLearnerBadge(host: HTMLElement): void {
  if (!learnerProfile) return;
  host.innerHTML = `<div class="learner-badge"><b>${escapeHtml(learnerProfile.studentName)}</b><span>${escapeHtml(learnerProfile.studentId)}</span>${assessmentMode ? '<em>考评模式</em>' : '<em>教学模式</em>'}</div>`;
}

const labels: Array<[keyof AssessmentScores, string]> = [
  ['kioskComplete', '一体机出勤流程'], ['documents', '证件规章选择'],
  ['publishedReveal', '公布揭示核对'], ['cardReveal', '验卡揭示核对'],
  ['kioskQuiz', '一体机揭示题'], ['deputyMeeting', '副司机小组会'],
  ['dispatcherCount', '调度员揭示条数核对'], ['dispatcherQuestions', '调度员作业题'],
];

export function mountScoreResult(host: HTMLElement, onClose: () => void): () => void {
  const profile = learnerProfile;
  if (!profile) return () => {};
  const rows = labels.map(([key, label]) => `<li><span>${label}</span><b>${assessmentScores[key]} / ${key === 'kioskComplete' ? 30 : 10}</b></li>`).join('');
  host.innerHTML = `<section class="training-panel score-panel" role="dialog" aria-modal="true" aria-label="考评成绩">
    <header><div><span>出勤虚拟实训 · ${profile.mode === 'assessment' ? '考评模式' : '教学模式'}</span><b>本轮完成情况</b></div><button type="button" data-close>关闭</button></header>
    <main><div class="score-identity"><b>${escapeHtml(profile.studentName)}</b><span>学号 ${escapeHtml(profile.studentId)}</span></div>
      ${assessmentMode ? `<div class="score-total"><span>总成绩</span><strong>${totalScore()}</strong><i>/ 100</i></div><ul>${rows}</ul><p>请截取本页成绩并上传至教学平台。</p>` : '<p class="teaching-finish">本轮教学练习完成。可重新进入练习巩固操作。</p>'}
    </main>
    <footer><button type="button" class="primary" data-close>完成</button></footer>
  </section>`;
  const close = () => onClose();
  host.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(button => button.addEventListener('click', close));
  return () => { host.innerHTML = ''; };
}
