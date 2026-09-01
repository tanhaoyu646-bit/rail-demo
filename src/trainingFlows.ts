import { paperRevealRecords, shuffled } from './cardRevealData';
import { createHintPicker } from './trainingHints';

type OverlayOptions = {
  onClose: () => void;
  onComplete?: () => void;
};

const weatherQuestions = [
  {
    question: '雨雾天气瞭望条件不良时，出乘预想应重点采取什么措施？',
    answers: ['加强瞭望、控制速度并提前采取制动措施', '保持常速，只增加鸣笛次数', '关闭LKJ提示避免干扰'],
    correct: 0,
  },
  {
    question: '核对运行揭示时，应重点确认哪些内容？',
    answers: ['命令号、时间、区段、行别、限速及设备变化', '只核对车次和司机姓名', '只核对纸张页数'],
    correct: 0,
  },
  {
    question: '低温、冰雪条件下应在预想中增加哪项内容？',
    answers: ['防滑、防空转并关注制动距离变化', '提高牵引力快速通过', '减少对线路状态的确认'],
    correct: 0,
  },
];

let notebookDraft = '';
const deputyHint=createHintPicker('deputy');
const dispatcherHint=createHintPicker('dispatcher');

export function mountDispatcherFlow(host: HTMLElement, options: OverlayOptions): () => void {
  if (__PUBLIC_DEMO__) {
    const prompts = shuffled([
      '请结合天气条件，说出一项瞭望注意事项。',
      '请从纸质揭示中找出一个需要核对的字段。',
      '请说明发现纸卡信息不一致时应先做什么。',
      '请说出出乘预想中应包含的一类风险控制措施。',
    ]).slice(0, 2);
    host.innerHTML = `
      <section class="training-panel dialogue-panel" role="dialog" aria-modal="true" aria-label="公开版人人核对演示">
        <header><div><span>出勤调度室 · 人人核对</span><b>公开轻量体验</b></div><button type="button" data-close>退出</button></header>
        <main>
          <div class="npc-dialogue"><i>调</i><div><b>出勤调度员</b><p data-hint aria-live="polite">公开版只演示交互流程，不包含正式评分规则与答案。</p><button type="button" class="npc-ask" data-ask-hint>随机提示</button></div></div>
          <ol class="demo-question-list">${prompts.map(prompt => `<li>${prompt}</li>`).join('')}</ol>
          <p class="flow-message" aria-live="polite"></p>
        </main>
        <footer><button type="button" class="primary" data-submit>完成演示</button></footer>
      </section>`;
    host.querySelector('[data-ask-hint]')?.addEventListener('click', () => {
      const target = host.querySelector<HTMLElement>('[data-hint]');
      if (target) target.textContent = dispatcherHint();
    });
    host.querySelector('[data-close]')?.addEventListener('click', options.onClose);
    host.querySelector('[data-submit]')?.addEventListener('click', () => options.onComplete?.());
    return () => { host.innerHTML = ''; };
  }
  const questions = shuffled(weatherQuestions).slice(0, 2).map(item => ({...item,
    answers: shuffled(item.answers.map((text,index)=>({text,correct:index===item.correct}))),
  }));
  host.innerHTML = `
    <section class="training-panel dialogue-panel" role="dialog" aria-modal="true" aria-label="人人核对">
      <header><div><span>出勤调度室 · 人人核对</span><b>出勤调度员</b></div><button type="button" data-close>退出</button></header>
      <main>
        <div class="npc-dialogue"><i>调</i><div><b>出勤调度员</b><p data-hint aria-live="polite">先核对本次出乘信息。有疑问可以问我。</p><button type="button" class="npc-ask" data-ask-hint>询问调度员</button></div></div>
        <form class="question-list">
          ${questions.map((item, index) => `<fieldset><legend>${index + 1}. ${item.question}</legend>${item.answers.map((answer, answerIndex) => `<label><input type="radio" name="question-${index}" value="${answerIndex}"><span>${answer.text}</span></label>`).join('')}</fieldset>`).join('')}
        </form>
        <p class="flow-message" aria-live="polite"></p>
      </main>
      <footer><button type="button" class="primary" data-submit>确认</button></footer>
    </section>`;
  const message = host.querySelector<HTMLElement>('.flow-message');
  host.querySelector('[data-ask-hint]')?.addEventListener('click',()=>{const target=host.querySelector('[data-hint]');if(target)target.textContent=dispatcherHint();});
  host.querySelector('[data-close]')?.addEventListener('click', options.onClose);
  host.querySelector('[data-submit]')?.addEventListener('click', () => {
    const passed = questions.every((item, index) => {
      const value=host.querySelector<HTMLInputElement>(`input[name="question-${index}"]:checked`)?.value;
      return value !== undefined && item.answers[Number(value)]?.correct;
    });
    if (!passed) {
      if (message) message.textContent = '回答未通过，请重新结合揭示和天气条件判断。';
      return;
    }
    if (message) message.textContent = '人人核对通过。';
    options.onComplete?.();
  });
  return () => { host.innerHTML = ''; };
}

export function mountPersonDialogue(host: HTMLElement, options: OverlayOptions & {
  role: 'deputy' | 'dispatcher'; nextLine: () => string; onReview?: () => void;
}): () => void {
  const name = options.role === 'deputy' ? '副司机' : '出勤调度员';
  const hint = options.role === 'deputy' ? deputyHint : dispatcherHint;
  host.innerHTML = `<section class="training-panel dialogue-panel" role="dialog" aria-modal="true" aria-label="${name}对话">
    <header><div><span>出勤交谈</span><b>${name}</b></div><button type="button" data-close>结束交谈</button></header>
    <main><div class="npc-dialogue"><i>${options.role==='deputy'?'副':'调'}</i><div><b>${name}</b><p data-dialogue aria-live="polite"></p></div></div></main>
    <footer><button type="button" data-talk>继续交谈</button><button type="button" data-hint>请提示一个要点</button>${options.onReview?'<button type="button" class="primary" data-review>复核差异</button>':''}</footer>
  </section>`;
  const line=host.querySelector<HTMLElement>('[data-dialogue]');
  if(line) line.textContent=options.nextLine();
  host.querySelector('[data-talk]')?.addEventListener('click',()=>{if(line)line.textContent=options.nextLine();});
  host.querySelector('[data-hint]')?.addEventListener('click',()=>{if(line)line.textContent=hint();});
  host.querySelector('[data-review]')?.addEventListener('click',()=>{
    options.onReview?.();
    if(line)line.textContent='本次差异已复核，请回到一体机重新核对；纸卡差异需重新写卡、验卡。';
    host.querySelector<HTMLButtonElement>('[data-review]')!.disabled=true;
  });
  host.querySelector('[data-close]')?.addEventListener('click',options.onClose);
  return ()=>{host.innerHTML='';};
}

export function mountNotebookFlow(host: HTMLElement, options: OverlayOptions): () => void {
  host.innerHTML = `
    <section class="training-panel notebook-panel" role="dialog" aria-modal="true" aria-label="司机手帐填写">
      <header><div><span>副司机 · 出乘小组会</span><b>出乘预想填写</b></div><button type="button" data-close>收起手帐</button></header>
      <main>
        <div class="npc-dialogue"><i>副</i><div><b>副司机</b><p data-hint aria-live="polite">本次出乘预想由你填写。需要帮助时可以问我。</p><button type="button" class="npc-ask" data-ask-hint>询问副司机</button></div></div>
        <div class="notebook-spread">
          <section class="book-page form-page"><h3>司机手帐</h3><dl><div><dt>机车型号</dt><dd>HXD3C</dd></div><div><dt>运行区段</dt><dd>${paperRevealRecords[0].location}—${paperRevealRecords.at(-1)!.location}</dd></div><div><dt>天气</dt><dd>雨雾</dd></div><div><dt>揭示条数</dt><dd>${paperRevealRecords.length}条</dd></div></dl><div class="notebook-writing-tools"><label for="forecast-draft">出乘预想、退乘总结及重要记事</label><button type="button" data-expand-writing aria-pressed="false">专注填写</button></div><textarea id="forecast-draft" aria-label="出乘预想内容" placeholder="请输入出乘预想…"></textarea><p class="draft-status" aria-live="polite">草稿已保留</p></section>
        </div>
        <p class="flow-message" aria-live="polite"></p>
      </main>
      <footer><button type="button" class="primary" data-submit>保存手帐填写</button></footer>
    </section>`;
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
  const message = host.querySelector<HTMLElement>('.flow-message');
  host.querySelector('[data-ask-hint]')?.addEventListener('click',()=>{const target=host.querySelector('[data-hint]');if(target)target.textContent=deputyHint();});
  if (textarea) {
    textarea.value = notebookDraft;
    textarea.addEventListener('input', () => { notebookDraft = textarea.value; });
  }
  host.querySelector('[data-expand-writing]')?.addEventListener('click', event => {
    const expanded = host.querySelector('.notebook-panel')?.classList.toggle('writing-focused') ?? false;
    const button = event.currentTarget as HTMLButtonElement;
    button.textContent = expanded ? '返回小组会' : '专注填写';
    button.setAttribute('aria-pressed', String(expanded));
    textarea?.focus();
  });
  host.querySelector('[data-close]')?.addEventListener('click', options.onClose);
  host.querySelector('[data-submit]')?.addEventListener('click', () => {
    const value = textarea?.value.trim() ?? '';
    if (__PUBLIC_DEMO__) {
      if (value.length < 2) {
        if (message) message.textContent = '请输入一项出乘预想，或向副司机询问提示。';
        return;
      }
      if (message) message.textContent = '公开版填写演示完成。';
      options.onComplete?.();
      return;
    }
    const hasReveal = /(揭示|限速|命令号|信号机|施工|绿色许可证|特定引导)/.test(value);
    const hasWeather = /(雨|雾|大风|冰雪|低温|高温|天气)/.test(value);
    const hasMeasure = /(瞭望|控速|控制速度|制动|防滑|防空转)/.test(value);
    if (!hasReveal || !hasWeather || !hasMeasure) {
      if (message) message.textContent = '预想还不完整，可向副司机或调度员询问。';
      return;
    }
    if (message) message.textContent = '司机手帐填写通过。';
    options.onComplete?.();
  });
  return () => { host.innerHTML = ''; };
}

export function mountLkjFlow(host: HTMLElement, options: OverlayOptions): () => void {
  let step = 0;
  let selected = 0;
  function render(): void {
    const bodies = [
      `<div class="lkj-screen count-screen"><div class="lkj-instruments"><b>0</b><b>165</b><b>2000</b><span>出站 1260<br>361.421</span><time>10:28:16</time></div><div class="lkj-dialog"><b>揭示</b><p><i></i>共 [${paperRevealRecords.length}] 条</p><button type="button" data-next>确定</button></div></div>`,
      `<div class="lkj-screen menu-screen"><h3>揭示信息查询</h3><div class="lkj-menu"><button>当前揭示信息</button><button class="selected" data-next>全部揭示信息查询</button><button>已解除揭示查询</button><button>IC卡状态查询</button></div><p>请选择“全部揭示信息查询”。</p></div>`,
      '',
    ];
    // The driver-console prototype follows this attempt, never a separate fixed 51-item sample.
    const current = paperRevealRecords[selected];
    bodies[2] = `<div class="lkj-screen table-screen"><header><b>全部揭示信息查询</b><span>共有揭示 [${paperRevealRecords.length}] 条</span></header><table><thead><tr><th>序号</th><th>命令号</th><th>线路</th><th>行别</th><th>位置</th><th>起止日期</th></tr></thead><tbody>${paperRevealRecords.map((record,index)=>`<tr class="${index===selected?'active':''}"><td><button type="button" data-record="${index}">${index+1}</button></td><td>${record.order}</td><td>${record.line}</td><td>${record.direction}</td><td>${record.location}</td><td>${record.start}～${record.end}</td></tr>`).join('')}</tbody></table><p>${current.content}</p><button type="button" data-complete>核对完成</button></div>`;
    host.innerHTML = `
      <section class="training-panel lkj-panel" role="dialog" aria-modal="true" aria-label="LKJ人车核对">
        <header><div><span>HXD3C驾驶台 · LKJ</span><b>人车核对</b></div><button type="button" data-close>退出驾驶台</button></header>
        <main>${bodies[step]}</main>
      </section>`;
    host.querySelector('[data-close]')?.addEventListener('click', options.onClose);
    host.querySelectorAll<HTMLButtonElement>('[data-record]').forEach(button=>button.addEventListener('click',()=>{selected=Number(button.dataset.record);render();}));
    host.querySelector('[data-next]')?.addEventListener('click', () => { step = Math.min(2, step + 1); render(); });
    host.querySelector('[data-complete]')?.addEventListener('click', () => options.onComplete?.());
  }
  render();
  return () => { host.innerHTML = ''; };
}
