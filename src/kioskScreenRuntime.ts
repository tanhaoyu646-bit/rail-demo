import * as THREE from 'three';
import { revealPaperRows } from './revealPaperLayout';
import { TrainingCardMemory, cardMatchesPaper, paperRevealRecords, publishedRevealRecords, trainingScenario, shuffled, seededRandom, introduceDifference, type DifferenceSource, type CardReveal } from './cardRevealData';

type RuntimeOptions = {
  onClose: () => void;
  onComplete: () => void;
  onPrinted: () => void;
  onStartBreath: () => void;
  onRequestCard: () => void;
  onStepChange: (step: number) => void;
  onRevealViewChange: (view: 'overview' | 'screen' | 'paper') => void;
  getSelectedItem: () => string | null;
  onInsertCard: () => Promise<boolean>;
  onTakeCard: () => void;
  assessmentMode?: boolean;
  onDocumentsChecked?: (correct: boolean) => void;
  onPublishedChecked?: (correct: boolean) => void;
  onCardChecked?: (correct: boolean) => void;
  onQuizChecked?: (correct: boolean) => void;
  cardMemory?: TrainingCardMemory;
  publishedRecords?: readonly CardReveal[];
  onReportDifference?: (source: DifferenceSource) => void;
};

type HitRegion = { x: number; y: number; w: number; h: number; action: () => void };

const asset = (path: string) => `${import.meta.env.BASE_URL}assets/${path}`;
const documents = [
  ['work-card', '铁路职工工作证', 'certificate-work.png', true],
  ['driver-license', '机车车辆驾驶证', 'certificate-driver.png', true],
  ['training-certificate', '岗位培训合格证', 'certificate-training.png', true],
  ['technical-rules', '铁路技术管理规程', 'book-technical-rules.png', true],
  ['locomotive-operation', '铁路机车操作规则', 'book-locomotive-operation.png', true],
  ['operation-organization', '普速铁路行车组织规则', 'book-operation-organization.png', false],
  ['accident-response', '事故应急救援条例', 'book-accident-response.png', false],
  ['passenger-rules', '铁路旅客运输规程', 'book-passenger-rules.png', false],
  ['crew-handbook', '乘务员统编综合手册', 'book-crew-handbook.png', false],
  ['crew-standard', '一次乘务作业标准', 'book-crew-operation-standard.png', false],
  ['emergency-rules', '事故应急救援规则', 'book-accident-emergency-rules.png', false],
] as const;

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

export class KioskScreenRuntime {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly regions: HitRegion[] = [];
  private readonly selectedDocuments = new Set<string>();
  private readonly paperMarks = new Set<number>();
  private readonly cardPaperMarks = new Set<number>();
  private readonly cardMemory: TrainingCardMemory;
  private readonly documentChoices = shuffled(documents, seededRandom(`${trainingScenario.studentId}:documents`));
  private publishedRecords: CardReveal[];
  private cardFaultPending = trainingScenario.fault === 'card';
  private reportedDifferences = new Set<DifferenceSource>();
  private cardReadback: CardReveal[] = [];
  private cardContentsOpen = false;
  private selectedCardRow = 0;
  private publishedPage = 0;
  private inserting = false;
  private completed = false;
  private step = 0;
  private breathPassed = false;
  private breathRunning = false;
  private printed = false;
  private icInserted = false;
  private icWritten = false;
  private message = '';
  private revealView: 'overview' | 'screen' | 'paper' = 'overview';
  private quizAnswer: number | null = null;
  private readonly quizChoices = shuffled([
    paperRevealRecords.length - 1, paperRevealRecords.length, paperRevealRecords.length + 1, paperRevealRecords.length + 2,
  ].filter((value, index, values) => value > 0 && values.indexOf(value) === index), seededRandom(`${trainingScenario.studentId}:kiosk-quiz`));

  constructor(private readonly options: RuntimeOptions) {
    this.cardMemory = options.cardMemory ?? new TrainingCardMemory();
    this.publishedRecords = (options.publishedRecords ?? publishedRevealRecords).map(r => ({ ...r }));
    this.canvas.width = 1024;
    this.canvas.height = 618;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D unavailable');
    this.ctx = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    for (const [, , file] of documents) this.loadImage(`doc:${file}`, asset(`documents/upright/${file}`));
    const debugParams = new URLSearchParams(window.location.search);
    const debugStep = Number(debugParams.get('kioskStep'));
    if (import.meta.env.DEV && Number.isInteger(debugStep) && debugStep >= 0 && debugStep <= 7) this.step = debugStep;
    this.options.onStepChange(this.step);
    const debugRevealView = debugParams.get('revealView');
    if (import.meta.env.DEV && this.step === 4 && (debugRevealView === 'screen' || debugRevealView === 'paper')) {
      this.revealView = debugRevealView;
      this.options.onRevealViewChange(this.revealView);
    }
    this.draw();
  }

  private loadImage(key: string, url: string): void {
    const image = new Image();
    image.onload = () => this.draw();
    image.src = url;
    this.images.set(key, image);
  }

  private button(label: string, x: number, y: number, w: number, h: number, action: () => void, primary = false): void {
    const { ctx } = this;
    rounded(ctx, x, y, w, h, 12);
    ctx.fillStyle = primary ? '#18785f' : '#edf2ef';
    ctx.fill();
    ctx.strokeStyle = primary ? '#89e6c5' : '#bac7c1';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = primary ? '#fff' : '#1e3a31';
    ctx.font = '600 20px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2);
    this.regions.push({ x, y, w, h, action });
  }

  private header(title: string, instruction = ''): void {
    const { ctx } = this;
    ctx.fillStyle = '#0e4b59';
    ctx.fillRect(0, 0, this.canvas.width, 70);
    ctx.fillStyle = '#fff';
    ctx.font = '700 27px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`出勤业务 · ${title}`, 28, 27);
    ctx.font = '15px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#cfe8e4';
    ctx.fillText(instruction, 28, 53);
    for (let index = 0; index < 8; index += 1) {
      ctx.beginPath();
      ctx.arc(688 + index * 31, 35, 11, 0, Math.PI * 2);
      ctx.fillStyle = index < this.step ? '#82d7b8' : index === this.step ? '#ffb456' : '#4d7880';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(index + 1), 688 + index * 31, 36);
    }
    this.button('退出', 938, 14, 68, 42, this.options.onClose);
  }

  private footer(): void {
    if (this.message) {
      this.ctx.fillStyle = '#a6322d';
      this.ctx.font = '13px "Microsoft YaHei", sans-serif';
      this.ctx.textAlign = 'left';
      this.ctx.fillText(this.message, 28, 610, 975);
    }
    if (this.step > 0) this.button('上一步', 714, 553, 120, 48, () => { if (!this.inserting) this.setStep(this.step - 1); });
    if (this.step !== 5 && (this.step !== 6 || this.cardContentsOpen)) this.button('确认', 844, 553, 164, 48, () => this.next(), true);
  }

  private setStep(step: number): void {
    if (step !== 1) this.breathRunning = false;
    this.step = THREE.MathUtils.clamp(step, 0, 7);
    if (this.revealView !== 'overview') {
      this.revealView = 'overview';
      this.options.onRevealViewChange(this.revealView);
    }
    this.message = '';
    this.options.onStepChange(this.step);
    this.draw();
  }

  focusRevealView(view: 'overview' | 'screen' | 'paper'): void {
    if (this.revealView === view) return;
    this.revealView = view;
    this.message = '';
    this.options.onRevealViewChange(view);
    this.draw();
  }

  private next(): void {
    if (this.inserting || this.completed) return;
    if (this.step === 1 && !this.breathPassed) this.message = '请先点击左侧酒测器完成检测。';
    else if (this.step === 2) {
      const required = documents.filter((item) => item[3]).map((item) => item[0]);
      const missing = required.filter((id) => !this.selectedDocuments.has(id));
      const extra = [...this.selectedDocuments].filter((id) => !required.includes(id as never));
      const correct = !missing.length && !extra.length;
      this.options.onDocumentsChecked?.(correct);
      if (!correct && !this.options.assessmentMode) {
        const missingNames = documents.filter((item) => missing.includes(item[0] as never)).map((item) => item[1]);
        const extraNames = documents.filter((item) => extra.includes(item[0] as never)).map((item) => item[1]);
        this.message = [
          missingNames.length ? `缺少：${missingNames.join('、')}` : '',
          extraNames.length ? `不应携带：${extraNames.join('、')}` : '',
        ].filter(Boolean).join('；');
      } else {
        this.message = '';
        this.setStep(this.step + 1);
        return;
      }
    } else if (this.step === 3 && !this.printed) this.message = '请先启动打印并领取交付揭示。';
    else if (this.step === 4) {
      const correct = cardMatchesPaper(this.publishedRecords) && this.paperMarks.size >= revealPaperRows.length;
      this.options.onPublishedChecked?.(correct);
      if (!correct && !this.options.assessmentMode) this.message = !cardMatchesPaper(this.publishedRecords) ? '揭示不一致，请向调度员报告复核。' : '核对尚未完成。';
      else { this.setStep(5); return; }
    }
    else if (this.step === 5) { this.verifyCard(); return; }
    else if (this.step === 6) {
      const correct = this.cardContentsOpen && cardMatchesPaper(this.cardReadback) && this.cardPaperMarks.size >= revealPaperRows.length;
      this.options.onCardChecked?.(correct);
      if (!correct && !this.options.assessmentMode) {
        if (!this.cardContentsOpen) this.message = '请先确认揭示条数。';
        else if (!cardMatchesPaper(this.cardReadback)) this.message = '卡内数据与纸质揭示不一致，不能通过；请返回重新写卡、验卡。';
        else this.message = '纸卡核对尚未完成：请举近纸质揭示，逐条点击正文划线。';
      } else { this.setStep(7); return; }
    }
    else if (this.step === 7) {
      if (this.quizAnswer === null) this.message = '请选择一个答案。';
      else {
        const correct = this.quizChoices[this.quizAnswer] === paperRevealRecords.length;
        this.options.onQuizChecked?.(correct);
        if (!correct && !this.options.assessmentMode) this.message = '回答不正确，请根据本轮揭示重新判断。';
        else {
          this.completed = true;
          this.options.onTakeCard();
          this.icInserted = false;
          this.options.onComplete();
          return;
        }
      }
    }
    else {
      this.message = '';
      this.setStep(this.step + 1);
      return;
    }
    this.draw();
  }

  private drawIdentity(): void {
    const { ctx } = this;
    this.header('身份识别与选择实训台');
    rounded(ctx, 90, 118, 844, 350, 24);
    ctx.fillStyle = '#eef3f0'; ctx.fill();
    ctx.fillStyle = '#123f35'; ctx.font = '700 28px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('练习编号', 150, 190); ctx.fillText(trainingScenario.studentId || '示例', 430, 190, 440);
    ctx.fillText('实训设备', 150, 285); ctx.fillText('HXD3C 模拟实训台 01', 430, 285);
    ctx.font = '18px "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#567069';
    ctx.fillText('模拟练习 · 雨雾天气', 150, 390);
    this.footer();
  }

  private drawBreath(): void {
    const { ctx } = this;
    this.header('酒精检测');
    ctx.fillStyle = this.breathPassed ? '#1b765a' : '#315e59'; ctx.beginPath(); ctx.arc(300, 300, 115, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 34px "Microsoft YaHei", sans-serif';
    ctx.fillText(this.breathPassed ? '检测通过' : this.breathRunning ? '正在检测' : '等待检测', 300, 290);
    ctx.font = '20px "Microsoft YaHei", sans-serif'; ctx.fillText(this.breathPassed ? '0.00 mg/100mL' : this.breathRunning ? '请稍候…' : '点击左侧设备', 300, 340);
    this.button(this.breathPassed ? '检测已完成' : this.breathRunning ? '检测中…' : '开始酒精检测', 548, 214, 300, 78,
      () => { if (!this.breathPassed && !this.breathRunning) this.options.onStartBreath(); }, true);
    ctx.fillStyle = '#174b40'; ctx.textAlign = 'center'; ctx.font = '18px "Microsoft YaHei", sans-serif';
    this.footer();
  }

  private drawDocuments(): void {
    const { ctx } = this;
    this.header('选择携带证件和规章');
    this.documentChoices.forEach(([id, label, file], index) => {
      const col = index % 4;
      const row = Math.floor(index / 4);
      const x = 24 + col * 248;
      const y = 84 + row * 146;
      const selected = this.selectedDocuments.has(id);
      rounded(ctx, x, y, 230, 132, 14);
      ctx.fillStyle = selected ? '#d9f6e8' : '#eef2ef'; ctx.fill();
      ctx.strokeStyle = selected ? '#22ba80' : '#c6d0cb'; ctx.lineWidth = selected ? 5 : 1.5; ctx.shadowColor = selected ? '#67f6c1' : 'transparent'; ctx.shadowBlur = selected ? 15 : 0; ctx.stroke(); ctx.shadowBlur = 0;
      const image = this.images.get(`doc:${file}`);
      if (image?.complete && image.naturalWidth) ctx.drawImage(image, x + 12, y + 8, 78, 116);
      ctx.fillStyle = '#18382f'; ctx.font = '600 16px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left';
      const short = label.length > 10 ? `${label.slice(0, 10)}…` : label;
      ctx.fillText(short, x + 101, y + 56, 118);
      ctx.font = '14px "Microsoft YaHei", sans-serif'; ctx.fillStyle = selected ? '#11865d' : '#65756f';
      ctx.fillText(selected ? '✓ 已携带' : '未携带', x + 101, y + 88);
      this.regions.push({ x, y, w: 230, h: 132, action: () => { selected ? this.selectedDocuments.delete(id) : this.selectedDocuments.add(id); this.draw(); } });
    });
    this.footer();
  }

  private drawPrint(): void {
    const { ctx } = this;
    this.header('交付揭示打印');
    ctx.fillStyle = '#253e38'; ctx.fillRect(130, 160, 450, 90);
    ctx.fillStyle = '#111'; ctx.fillRect(170, 205, 370, 18);
    if (this.printed) {
      ctx.fillStyle = '#f8f5e9'; ctx.fillRect(205, 222, 300, 245);
      ctx.fillStyle = '#19201d'; ctx.textAlign = 'center'; ctx.font = '700 28px "Microsoft YaHei", sans-serif'; ctx.fillText('运行揭示', 355, 270);
      ctx.font = '16px "Microsoft YaHei", sans-serif'; ctx.fillText(`${paperRevealRecords[0].order}号 · ${paperRevealRecords[0].location}至${paperRevealRecords.at(-1)!.location}`, 355, 310);
    }
    this.button(this.printed ? '已打印并领取' : '启动打印', 650, 240, 230, 78, () => {
      if (this.printed) return;
      this.printed = true; this.options.onPrinted(); this.message = ''; this.draw();
    }, true);
    this.footer();
  }

  private drawReveal(): void {
    const { ctx } = this;
    this.header('公布揭示核对');
    const records=this.publishedRecords;
    ctx.fillStyle='#174fa1';ctx.fillRect(18,82,988,35);
    ctx.fillStyle='#fff';ctx.font='700 22px "SimSun",serif';ctx.textAlign='left';ctx.fillText('公布揭示查看',34,101);
    ctx.font='17px "SimSun",serif';ctx.textAlign='center';ctx.fillText(`当前揭示：[T${this.publishedPage+1}]　${records[0]?.direction??''}`,670,101);
    records.slice(this.publishedPage*2,this.publishedPage*2+2).forEach((record,index)=>this.drawPublishedRecord(record,26+index*493,125,this.publishedPage*2+index));
    this.regions.push({x:18,y:82,w:988,h:447,action:()=>this.focusRevealView('screen')});
    this.button('报告不一致',376,553,156,48,()=>{
      this.reportDifference('published');
    });
    if(records.length>2) this.button('翻页',544,553,100,48,()=>{this.publishedPage=(this.publishedPage+1)%Math.ceil(records.length/2);this.draw();});
    this.button(this.revealView === 'paper' ? '放下纸张看屏幕' : '举近纸质揭示', 28, 553, 190, 48,
      () => this.focusRevealView(this.revealView === 'paper' ? 'screen' : 'paper'));
    this.button('并排查看', 232, 553, 130, 48, () => this.focusRevealView('overview'));
    this.footer();
  }

  private wrapText(text: string, x: number, y: number, width: number, lineHeight: number, maxLines = 8): void {
    const {ctx}=this; let line='',row=0;
    for(const char of text) {
      const measured=ctx.measureText(line+char)?.width ?? (line.length+1)*18;
      if(line&&measured>width) { ctx.fillText(line,x,y+row*lineHeight); row++; line=''; if(row>=maxLines)return; }
      line+=char;
    }
    if(line&&row<maxLines)ctx.fillText(line,x,y+row*lineHeight);
  }

  private drawPublishedRecord(record: CardReveal,x:number,y:number,index:number): void {
    const {ctx}=this,w=479,h=397;
    ctx.fillStyle='#faf7ec';ctx.fillRect(x,y,w,h);ctx.strokeStyle='#8c938e';ctx.lineWidth=1;
    ctx.strokeRect(x,y,w,h);
    for(const dy of [32,77,112,327]){ctx.beginPath();ctx.moveTo(x,y+dy);ctx.lineTo(x+w,y+dy);ctx.stroke();}
    ctx.fillStyle='#252b28';ctx.font='bold 18px "SimSun",serif';ctx.textAlign='center';
    ctx.fillText(`[${record.order}]-[第${index+1}条]`,x+w/2,y+18);
    ctx.textAlign='left';ctx.font='17px "SimSun",serif';
    ctx.fillText('命令号',x+9,y+51);ctx.fillText(record.order,x+78,y+51);
    ctx.fillText('起止日期',x+165,y+51);
    ctx.font='14px "SimSun",serif';ctx.fillText(record.start,x+245,y+47);ctx.fillText(`至 ${record.end}`,x+245,y+66);
    ctx.font='16px "SimSun",serif';ctx.fillText(`出示日期：${record.start}`,x+9,y+95);
    ctx.fillText('撤除日期：',x+299,y+95);
    ctx.fillText('内容',x+9,y+190);
    ctx.beginPath();ctx.moveTo(x+52,y+112);ctx.lineTo(x+52,y+327);ctx.stroke();
    ctx.font='19px "SimSun",serif';this.wrapText(`${record.start}至${record.end}，${record.content}`,x+64,y+135,w-78,27,7);
    ctx.font='15px "SimSun",serif';ctx.fillText('抄录人：',x+9,y+358);ctx.fillText('复核人：',x+235,y+358);
    ctx.strokeStyle='#b34c46';ctx.fillStyle='#a5413c';
    for(const [sx,name] of [[x+73,'张三'],[x+299,'李四']] as const){
      ctx.strokeRect(sx,y+339,91,48);ctx.beginPath();ctx.moveTo(sx,y+363);ctx.lineTo(sx+91,y+363);ctx.stroke();
      ctx.textAlign='center';ctx.fillText('调度员',sx+45,y+352);ctx.fillText(name,sx+45,y+377);
    }
    ctx.textAlign='left';
  }

  isRevealComparison(): boolean { return this.step === 4 || (this.step === 6 && this.cardContentsOpen); }

  getPaperMarks(): readonly number[] { return [...(this.step === 6 ? this.cardPaperMarks : this.paperMarks)]; }

  markPaperRevealLine(index: number): boolean {
    if (!this.isRevealComparison() || this.revealView !== 'paper' || !Number.isInteger(index) || index < 0 || index >= revealPaperRows.length) return false;
    if(this.step===4&&!cardMatchesPaper(this.publishedRecords)) {
      this.message='揭示不一致，请报告复核。';this.draw();return false;
    }
    if (this.step === 6 && !cardMatchesPaper(this.cardReadback)) {
      this.message = '卡内数据不一致，不能确认本行；请返回重新写卡。'; this.draw(); return false;
    }
    const marks = this.step === 6 ? this.cardPaperMarks : this.paperMarks;
    marks.add(index);
    this.message = marks.size === revealPaperRows.length ? '核对完成。' : '';
    this.draw();
    return true;
  }

  private drawIc(): void {
    const { ctx } = this;
    this.header('写卡 · 验卡');
    ctx.fillStyle = '#e5eeea'; rounded(ctx, 65, 118, 894, 330, 20); ctx.fill();
    ctx.fillStyle = '#1c5d4d'; ctx.font = '700 23px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`卡片状态：${this.inserting ? '正在对槽插入…' : this.icWritten && this.icInserted ? '已写卡 · 待验卡（卡仍在槽内）' : this.icInserted ? '已插入 · 待写卡' : '请取出IC卡'}`, 104, 174);
    ctx.font = '21px "Microsoft YaHei", sans-serif';
    ctx.fillText(`运行区段：${paperRevealRecords[0].line} · ${paperRevealRecords[0].location}—${paperRevealRecords.at(-1)!.location} · ${paperRevealRecords[0].direction}`, 104, 230);
    ctx.fillText(`待写入揭示：${paperRevealRecords.length} 条 · ${paperRevealRecords.map(r=>r.order).join(' / ')}`, 104, 277);
    this.button(this.options.getSelectedItem() === 'ic-card' ? 'IC卡已取出' : '取出IC卡', 104, 337, 190, 68,
      () => { if (!this.icInserted && !this.inserting) this.options.onRequestCard(); }, true);
    this.button(this.inserting ? '插入中…' : this.icInserted ? '已插入卡槽' : '插入IC卡', 306, 337, 190, 68,
      () => { void this.insertCard(); }, true);
    this.button('写卡', 508, 337, 190, 68, () => {
      if (!this.icInserted || this.inserting) this.message = '请先等IC卡完全插入卡槽。';
      else {
        this.cardMemory.write(this.cardFaultPending ? introduceDifference(paperRevealRecords,trainingScenario.studentId) : paperRevealRecords);
        this.cardFaultPending = false;
        this.icWritten = true; this.cardReadback = []; this.cardPaperMarks.clear(); this.cardContentsOpen = false;
        this.message = '写卡成功。';
      }
      this.draw();
    }, true);
    this.button('验卡', 710, 337, 190, 68, () => this.verifyCard(), true);
    ctx.font = '18px "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#4a665d'; ctx.textAlign = 'left';
    this.footer();
  }

  async insertCard(): Promise<void> {
    if (this.step !== 5 || this.inserting || this.icInserted) return;
    if (this.options.getSelectedItem() !== 'ic-card') { this.message = '请先按3键取出IC卡。'; this.draw(); return; }
    this.inserting = true; this.message = '正在对准机身卡槽，以绿色接触端送入…'; this.draw();
    try {
      this.icInserted = await this.options.onInsertCard();
      if (this.icInserted) { this.icWritten = false; this.completed = false; }
      this.message = this.icInserted ? 'IC卡已插入，请点击“写卡”。' : '插卡未完成，请重新取卡后重试。';
    } catch {
      this.message = '插卡失败，请重新取卡后重试。';
    } finally { this.inserting = false; this.draw(); }
  }

  private verifyCard(): void {
    if (this.inserting || !this.icInserted || !this.icWritten) {
      this.message = '请先完成插卡、写卡，再点击“验卡”。'; this.draw(); return;
    }
    this.cardReadback = this.cardMemory.read();
    this.cardPaperMarks.clear(); this.cardContentsOpen = false; this.selectedCardRow=0;
    this.setStep(6);
  }

  private drawCardCheck(): void {
    const { ctx } = this;
    this.header('验卡');
    if (!this.cardContentsOpen) {
      ctx.fillStyle='#090909';ctx.fillRect(18,84,988,450);
      ctx.strokeStyle='#444';ctx.lineWidth=1;
      for(let y=112;y<531;y+=50){ctx.beginPath();ctx.moveTo(18,y);ctx.lineTo(1006,y);ctx.stroke();}
      // Match the supplied LKJ count-dialog visual language: blue title bar,
      // square gray window, red warning symbol and beveled confirmation button.
      ctx.fillStyle='#c0c0c0';ctx.fillRect(276,211,472,261);
      ctx.strokeStyle='#f2f2f2';ctx.lineWidth=3;ctx.strokeRect(276,211,472,261);
      ctx.fillStyle='#000080';ctx.fillRect(280,215,464,37);
      ctx.font='24px "SimSun",serif';ctx.textAlign='left';ctx.fillStyle='#fff';ctx.fillText('揭示',292,234);
      ctx.fillStyle='#de1434';ctx.beginPath();ctx.arc(380,320,23,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#171717';ctx.textAlign='center';ctx.font='bold 31px serif';ctx.fillText('!',380,322);
      ctx.font='32px "SimSun",serif';ctx.fillText(`共 [${this.cardReadback.length}] 条`,536,320);
      ctx.fillStyle='#c0c0c0';ctx.fillRect(430,396,164,52);
      ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(430,448);ctx.lineTo(430,396);ctx.lineTo(594,396);ctx.stroke();
      ctx.strokeStyle='#333';ctx.beginPath();ctx.moveTo(594,396);ctx.lineTo(594,448);ctx.lineTo(430,448);ctx.stroke();
      ctx.fillStyle='#151515';ctx.font='bold 28px "SimSun",serif';ctx.fillText('确定',512,423);
      this.regions.push({x:430,y:396,w:164,h:52,action:()=>{
        this.cardContentsOpen = true;
        this.options.onStepChange(this.step);
        this.focusRevealView('overview'); this.draw();
      }});
    } else {
      ctx.fillStyle='#000080';ctx.fillRect(18,84,988,34);
      ctx.font='22px "SimSun",serif';ctx.textAlign='left';ctx.fillStyle='#fff';ctx.fillText('全部揭示信息查询',28,102);
      ctx.fillStyle='#2eee13';ctx.fillText(`共有揭示 [${this.cardReadback.length}] 条`,535,102);
      const columns=[18,72,165,298,357,465,816,910,1006];
      const labels=['序号','命令号','工务线路名','行别','位置','起止日期','客限','货限'];
      ctx.fillStyle='#c0c0c0';ctx.fillRect(18,118,988,32);ctx.font='19px "SimSun",serif';
      labels.forEach((text,i)=>{ctx.fillStyle='#171717';ctx.fillText(text,columns[i]+6,135);});
      for(let row=0;row<6;row++) {
        const y=150+row*32,record=this.cardReadback[row],selected=row===this.selectedCardRow&&!!record;
        ctx.fillStyle=selected?'#b60000':row%2?'#f3f3f3':'#fff';ctx.fillRect(18,y,988,32);
        if(record){
          const values=[String(row),record.order,record.line,record.direction,record.location,`${record.start}～${record.end}`,'—','—'];
          ctx.fillStyle=selected?'#fff043':'#151515';ctx.font='18px "SimSun",serif';
          values.forEach((value,i)=>ctx.fillText(value,columns[i]+6,y+17,columns[i+1]-columns[i]-10));
          this.regions.push({x:18,y,w:988,h:32,action:()=>{this.selectedCardRow=row;this.focusRevealView('screen');this.draw();}});
        }
      }
      ctx.strokeStyle='#999';ctx.lineWidth=1;
      for(const x of columns){ctx.beginPath();ctx.moveTo(x,118);ctx.lineTo(x,342);ctx.stroke();}
      for(let y=118;y<=342;y+=32){ctx.beginPath();ctx.moveTo(18,y);ctx.lineTo(1006,y);ctx.stroke();}
      const record=this.cardReadback[this.selectedCardRow];
      ctx.fillStyle='#e4e4e4';ctx.fillRect(18,352,988,180);ctx.fillStyle='#111';ctx.font='20px "SimSun",serif';ctx.textAlign='left';
      if(record){ctx.fillText(`命令 ${record.order}　${record.location}　${record.direction}`,32,375);this.wrapText(record.content,32,413,953,30,3);}
      this.regions.push({x:18,y:352,w:988,h:180,action:()=>this.focusRevealView('screen')});
      this.button(this.revealView === 'paper' ? '放下纸张看屏幕' : '举近纸质揭示', 28, 553, 190, 48,
        () => this.focusRevealView(this.revealView === 'paper' ? 'screen' : 'paper'));
      this.button('并排查看', 232, 553, 130, 48, () => this.focusRevealView('overview'));
      this.button('报告不一致',376,553,156,48,()=>this.reportDifference('card'));
    }
    this.footer();
  }

  private drawQuiz(): void {
    const { ctx } = this;
    this.header('揭示核对答题');
    ctx.fillStyle = '#0a4d9a'; ctx.fillRect(0, 70, 1024, 474);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = '700 27px "Microsoft YaHei", sans-serif';
    ctx.fillText('第1题：本轮运行揭示共有多少条？', 72, 180);
    ctx.font = '18px "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#cbe4ff';
    ctx.fillText('请依据已打印并核对的纸质运行揭示作答。', 72, 220);
    this.quizChoices.forEach((choice, index) => {
      const x = 76 + index * 225;
      const selected = this.quizAnswer === index;
      rounded(ctx, x, 300, 175, 68, 8);
      ctx.fillStyle = selected ? '#ffdf75' : '#edf2f8'; ctx.fill();
      ctx.strokeStyle = selected ? '#fff5bb' : '#9eb8d8'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#123f84'; ctx.textAlign = 'center'; ctx.font = '700 32px "Microsoft YaHei", sans-serif';
      ctx.fillText(`${choice}条`, x + 87, 342);
      this.regions.push({ x, y: 300, w: 175, h: 68, action: () => { this.quizAnswer = index; this.message = ''; this.draw(); } });
    });
    this.footer();
  }

  draw(): void {
    this.regions.length = 0;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = '#f7f8f5'; this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.step === 0) this.drawIdentity();
    else if (this.step === 1) this.drawBreath();
    else if (this.step === 2) this.drawDocuments();
    else if (this.step === 3) this.drawPrint();
    else if (this.step === 4) this.drawReveal();
    else if (this.step === 5) this.drawIc();
    else if (this.step === 6) this.drawCardCheck();
    else this.drawQuiz();
    this.texture.needsUpdate = true;
  }

  private reportDifference(source: DifferenceSource): void {
    const records = source === 'published' ? this.publishedRecords : this.cardReadback;
    if (cardMatchesPaper(records)) this.message = '请指出具体差异后再复核。';
    else {
      this.reportedDifferences.add(source);
      this.message = source === 'published' ? '已记录差异，待调度员复核。' : '已记录纸卡差异，请向调度员询问或返回重新写卡。';
      this.options.onReportDifference?.(source);
    }
    this.draw();
  }

  resolveReportedDifference(source: DifferenceSource): boolean {
    if (!this.reportedDifferences.delete(source)) return false;
    if (source === 'published') {
      this.publishedRecords = paperRevealRecords.map(r => ({ ...r }));
      this.paperMarks.clear(); this.publishedPage = 0;
      this.message = '公布揭示已复核更正，请重新核对。';
    } else {
      this.cardPaperMarks.clear(); this.cardReadback = []; this.cardContentsOpen = false;
      this.icWritten = false; this.setStep(5);
      this.message = '请重新写卡，再验卡核对。';
    }
    this.draw(); return true;
  }

  completeBreathTest(): void {
    if (this.step !== 1 || !this.breathRunning) return;
    this.breathRunning = false;
    this.breathPassed = true;
    this.message = '酒精检测通过。';
    this.draw();
  }

  beginBreathTest(): boolean {
    if (this.step !== 1 || this.breathRunning || this.breathPassed) return false;
    this.breathRunning = true; this.message = '测酒器正在伸出，请稍候。'; this.draw();
    return true;
  }

  cancelBreathTest(): void {
    if (!this.breathRunning) return;
    this.breathRunning = false; this.message = '检测已中断，可重新开始。'; this.draw();
  }

  handlePointer(u: number, v: number, phase: 'down' | 'move' | 'up'): void {
    const point = { x: u * this.canvas.width, y: v * this.canvas.height };
    if (phase !== 'up') return;
    this.regions.find((region) => point.x >= region.x && point.x <= region.x + region.w && point.y >= region.y && point.y <= region.y + region.h)?.action();
  }
}
