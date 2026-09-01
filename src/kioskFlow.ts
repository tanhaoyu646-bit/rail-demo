type KioskFlowOptions = {
  onClose: () => void;
  onComplete: () => void;
  onPrinted: () => void;
  getSelectedItem: () => string | null;
  onStepChange?: (step: number) => void;
};

export type KioskFlowController = {
  destroy: () => void;
  completeBreathTest: () => void;
};

type DocumentOption = {
  id: string;
  label: string;
  image: string;
  required: boolean;
};

type FlowStep = {
  title: string;
  instruction: string;
  action: string;
  renderBody: () => string;
  validate?: () => string | null;
};

const asset = (path: string) => `${import.meta.env.BASE_URL}assets/${path}`;

const documentOptions: DocumentOption[] = [
  { id: 'work-card', label: '铁路职工工作证', image: asset('documents/certificate-work.png'), required: true },
  { id: 'driver-license', label: '机车车辆驾驶证', image: asset('documents/certificate-driver.png'), required: true },
  { id: 'training-certificate', label: '铁路岗位培训合格证', image: asset('documents/certificate-training.png'), required: true },
  { id: 'technical-rules', label: '《铁路技术管理规程（普速铁路部分）》', image: asset('documents/book-technical-rules.png'), required: true },
  { id: 'locomotive-operation', label: '《铁路机车操作规则》', image: asset('documents/book-locomotive-operation.png'), required: true },
  { id: 'operation-organization', label: '《普速铁路行车组织规则》', image: asset('documents/book-operation-organization.png'), required: false },
  { id: 'accident-response', label: '《铁路交通事故应急救援和调查处理条例》', image: asset('documents/book-accident-response.png'), required: false },
  { id: 'passenger-rules', label: '《铁路旅客运输规程》', image: asset('documents/book-passenger-rules.png'), required: false },
  { id: 'crew-handbook', label: '《乘务员统编综合手册》', image: asset('documents/book-crew-handbook.png'), required: false },
  { id: 'crew-standard', label: '《机车乘务员一次乘务作业标准》', image: asset('documents/book-crew-operation-standard.png'), required: false },
  { id: 'emergency-rules', label: '《铁路交通事故应急救援规则》', image: asset('documents/book-accident-emergency-rules.png'), required: false },
];

const revealPairs = [
  { id: 'command', label: '命令号', value: '21171号' },
  { id: 'date', label: '起止日期', value: '2021-01-01 00:00—2021-12-31 23:59' },
  { id: 'route', label: '线路与行别', value: '通用线 · 丙站至戊站 · 下行' },
  { id: 'station', label: '车站', value: '丙站、戊站' },
  { id: 'control', label: '行车办法', value: '绿色许可证发车 / 特定引导接车' },
  { id: 'change', label: '设备变化', value: '出站、进站信号机施工' },
];

export function mountKioskFlow(host: HTMLElement, options: KioskFlowOptions): KioskFlowController {
  let currentStep = 0;
  const completed = new Set<number>();
  const selectedDocuments = new Set<string>();
  const revealMarks = new Map<string, Set<'screen' | 'paper'>>();
  let printed = false;
  let breathPassed = false;
  let icInserted = false;
  let icWritten = false;

  const selectedDocumentError = (): string | null => {
    const required = new Set(documentOptions.filter((item) => item.required).map((item) => item.id));
    const missing = [...required].filter((id) => !selectedDocuments.has(id));
    const extras = [...selectedDocuments].filter((id) => !required.has(id));
    if (missing.length === 0 && extras.length === 0) return null;
    if (missing.length > 0 && extras.length > 0) return '存在漏选和错选，请重新核对证件与规章。';
    if (missing.length > 0) return `仍有${missing.length}项必带证件或规章未选择。`;
    return `已选择${extras.length}项非本次必带资料，请取消后再确认。`;
  };

  const revealError = (): string | null => revealPairs.every((pair) => revealMarks.get(pair.id)?.size === 2)
    ? null
    : '需要在屏幕公布揭示和手持交付揭示中分别点击同一要素，完成成对划记。';

  const steps: FlowStep[] = [
    {
      title: '身份识别与选择实训台',
      instruction: '按出勤计划办理出勤。当前使用训练样例工号和设备编号。',
      action: '确认身份并进入下一步',
      renderBody: () => `
        <div class="kiosk-card identity-card">
          <div class="face-frame"><span>人脸识别区域</span><i></i></div>
          <label>乘务员工号<input value="20250012" aria-label="乘务员工号"></label>
          <label>实训设备<select aria-label="选择实训设备"><option>HXD3C 模拟实训台 01</option><option>HXD3C 模拟实训台 02</option></select></label>
        </div>`,
    },
    {
      title: '酒精检测',
      instruction: '点击屏幕左侧竖直酒测器，检测器会转向当前视角；完成动作后再继续。',
      action: breathPassed ? '酒测通过并进入下一步' : '等待点击左侧酒测器',
      renderBody: () => `
        <div class="kiosk-card test-card">
          <div class="breath-meter"><i></i><i></i><i></i><i></i><i></i></div>
          <strong>${breathPassed ? '酒精检测通过' : '等待点击左侧酒测器'}</strong><span>训练模式不调用真实传感器</span>
        </div>`,
      validate: () => breathPassed ? null : '请先点击一体机左侧竖直酒测器。',
    },
    {
      title: '选择携带证件和规章',
      instruction: '点击图片选择，再点击可取消。发光边框和勾号表示已放入背包；错选干扰项也不能通过。',
      action: '确认携带项目',
      renderBody: () => `
        <div class="document-grid">
          ${documentOptions.map((item) => `
            <button type="button" class="document-option ${selectedDocuments.has(item.id) ? 'selected' : ''}" data-document-id="${item.id}" aria-pressed="${selectedDocuments.has(item.id)}">
              <span class="document-image"><img src="${item.image}" alt="${item.label}"><i>✓</i></span>
              <b>${item.label}</b>
            </button>`).join('')}
        </div>`,
      validate: selectedDocumentError,
    },
    {
      title: '打印并领取交付揭示',
      instruction: '先启动打印，等待纸张从打印口送出，再领取到快捷栏4号位。',
      action: '完成打印并继续',
      renderBody: () => `
        <div class="print-stage ${printed ? 'printed' : ''}">
          <div class="printer-mouth"><i></i><div class="printed-paper"><b>运行揭示</b><span>21171号 · 丙站至戊站 · 下行</span><small>训练样例</small></div></div>
          <div><strong>${printed ? '交付揭示已领取' : '打印机准备就绪'}</strong><p>${printed ? '已放入4号快捷位，可在核对时拿到镜头前。' : '点击下方按钮播放出纸并领取。'}</p><button type="button" data-print-reveal ${printed ? 'disabled' : ''}>${printed ? '打印完成' : '启动打印'}</button></div>
        </div>`,
      validate: () => printed ? null : '请先启动打印并领取交付揭示。',
    },
    {
      title: '纸纸核对：公布揭示与交付揭示',
      instruction: '公布揭示显示在一体机屏幕中；交付揭示拿到镜头前。分别点击两侧相同文字完成成对划记。',
      action: '完成纸纸核对',
      renderBody: () => `
        <div class="paper-check">
          <section class="published-screen"><header><b>公布揭示查看</b><span>当前揭示 [T1]</span></header><h3>下行</h3>${revealPairs.map((pair) => `<button type="button" class="reveal-text ${revealMarks.get(pair.id)?.has('screen') ? 'marked' : ''}" data-reveal-id="${pair.id}" data-reveal-side="screen"><small>${pair.label}</small>${pair.value}</button>`).join('')}</section>
          <section class="held-paper"><div class="hand-grip"></div><header><b>交付揭示</b><span>训练样例</span></header>${revealPairs.map((pair) => `<button type="button" class="reveal-text ${revealMarks.get(pair.id)?.has('paper') ? 'marked' : ''}" data-reveal-id="${pair.id}" data-reveal-side="paper"><small>${pair.label}</small>${pair.value}</button>`).join('')}</section>
        </div>
        <p class="pair-progress">已完成 ${revealPairs.filter((pair) => revealMarks.get(pair.id)?.size === 2).length} / ${revealPairs.length} 组核对</p>`,
      validate: revealError,
    },
    {
      title: 'IC卡写卡',
      instruction: '按3键或点击快捷栏中的IC卡，再把卡插入一体机。写卡完成后取回，稍后到HXD3C驾驶台进行人车核对。',
      action: '完成一体机阶段',
      renderBody: () => `
        <div class="ic-write-stage ${icInserted ? 'inserted' : ''} ${icWritten ? 'written' : ''}">
          <div class="ic-slot"><span>IC卡插槽</span><div class="ic-prop"><b>IC</b><i></i></div></div>
          <div class="ic-write-panel">
            <p><span>当前手持</span><b>${options.getSelectedItem() === 'ic-card' ? 'IC卡' : '未选择IC卡'}</b></p>
            <p><span>卡片状态</span><b>${icWritten ? '写卡成功，已取回' : icInserted ? '已插入，等待写卡' : '未插入'}</b></p>
            <p><span>运行区段</span><b>丙站—戊站 · 下行</b></p>
            <div class="ic-actions"><button type="button" data-insert-card ${icInserted || icWritten ? 'disabled' : ''}>插入IC卡</button><button type="button" data-write-card ${!icInserted || icWritten ? 'disabled' : ''}>执行写卡</button></div>
          </div>
        </div>`,
      validate: () => icWritten ? null : '需要选择IC卡、插卡并完成写卡。',
    },
  ];

  function render(message = ''): void {
    const step = steps[currentStep];
    if (currentStep === 1) step.action = breathPassed ? '酒测通过并进入下一步' : '等待点击左侧酒测器';
    options.onStepChange?.(currentStep);
    host.innerHTML = `
      <section class="kiosk-shell" role="dialog" aria-modal="true" aria-label="出勤一体机操作界面">
        <header class="kiosk-header">
          <div><span>乘务一体机 · 出勤业务</span><b>训练模式</b></div>
          <button type="button" data-close-kiosk aria-label="退出一体机">退出</button>
        </header>
        <div class="kiosk-progress">${steps.map((item, index) => `<i class="${index === currentStep ? 'current' : ''} ${completed.has(index) ? 'done' : ''}" title="${item.title}">${index + 1}</i>`).join('')}</div>
        <main class="kiosk-content">
          <p class="kiosk-step">步骤 ${currentStep + 1} / ${steps.length}</p>
          <h2>${step.title}</h2>
          <p class="kiosk-instruction">${step.instruction}</p>
          ${step.renderBody()}
          <p class="kiosk-error" aria-live="polite">${message}</p>
        </main>
        <footer class="kiosk-actions">
          <button type="button" data-prev-step ${currentStep === 0 ? 'disabled' : ''}>上一步</button>
          <button type="button" class="primary" data-complete-step>${step.action}</button>
        </footer>
      </section>`;

    host.querySelector('[data-close-kiosk]')?.addEventListener('click', options.onClose);
    host.querySelector('[data-prev-step]')?.addEventListener('click', () => {
      currentStep = Math.max(0, currentStep - 1);
      render();
    });
    host.querySelectorAll<HTMLElement>('[data-document-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.documentId || '';
        if (selectedDocuments.has(id)) selectedDocuments.delete(id);
        else selectedDocuments.add(id);
        button.classList.toggle('selected', selectedDocuments.has(id));
        button.setAttribute('aria-pressed', String(selectedDocuments.has(id)));
      });
    });
    host.querySelector('[data-print-reveal]')?.addEventListener('click', () => {
      printed = true;
      options.onPrinted();
      render('打印完成：交付揭示已进入4号快捷位。');
    });
    host.querySelectorAll<HTMLElement>('[data-reveal-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.revealId || '';
        const side = button.dataset.revealSide as 'screen' | 'paper';
        const sides = revealMarks.get(id) ?? new Set<'screen' | 'paper'>();
        if (sides.has(side)) sides.delete(side);
        else sides.add(side);
        revealMarks.set(id, sides);
        render();
      });
    });
    host.querySelector('[data-insert-card]')?.addEventListener('click', () => {
      if (options.getSelectedItem() !== 'ic-card') {
        render('请先按3键或点击底部快捷栏选择IC卡。');
        return;
      }
      icInserted = true;
      render('IC卡已插入一体机。');
    });
    host.querySelector('[data-write-card]')?.addEventListener('click', () => {
      if (!icInserted) return;
      icWritten = true;
      render('写卡成功，IC卡已自动取回3号快捷位。');
    });
    host.querySelector('[data-complete-step]')?.addEventListener('click', () => {
      const error = step.validate?.() ?? null;
      if (error) {
        render(error);
        return;
      }
      completed.add(currentStep);
      if (currentStep === steps.length - 1) {
        options.onComplete();
        return;
      }
      currentStep += 1;
      render();
    });
  }

  render();
  return {
    destroy: () => { host.innerHTML = ''; },
    completeBreathTest: () => {
      if (currentStep !== 1 || breathPassed) return;
      breathPassed = true;
      render('酒测器已转向当前视角，酒精检测通过。');
    },
  };
}
