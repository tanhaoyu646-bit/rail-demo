import { paperRevealRecords } from './cardRevealData';

export const revealPaperSize = { width: 0.45, height: 0.316, imageWidth: 938, imageHeight: 699 };
export function chineseDate(value: string): string {
  const [date,time]=value.split(' '), [year,month,day]=date.split('-');
  return `${year}年${Number(month)}月${Number(day)}日${time??''}`;
}
const textWidth=(text:string)=>[...text].reduce((sum,c)=>sum+(/[\x00-\xff]/.test(c)?13:24),0);
export function wrapPaperText(text: string, width=700): string[] {
  const lines:string[]=[]; let line='';
  for(const char of text) {
    if(line&&textWidth(line+char)>width) { lines.push(line); line=''; }
    line+=char;
  }
  if(line)lines.push(line); return lines;
}
export const revealPaperRows=paperRevealRecords.flatMap((record,recordIndex)=>{
  const text=`${recordIndex+1}、△调度命令号 ${record.order} 号：${chineseDate(record.start)}至${chineseDate(record.end)}，${record.content}`;
  return wrapPaperText(text).map(text=>({text,recordIndex}));
}).map((row,index)=>({...row,x:110,y:303+index*52,width:Math.min(700,textWidth(row.text)),height:35,underlineY:337+index*52}));
revealPaperSize.imageHeight=Math.max(699,337+revealPaperRows.length*52+40);

export function drawPaperReveal(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle='#fffdf5'; ctx.fillRect(0,0,revealPaperSize.imageWidth,revealPaperSize.imageHeight);
  ctx.fillStyle='#171b19'; ctx.textAlign='center'; ctx.textBaseline='top';
  ctx.font='38px "SimSun",serif'; ctx.fillText('运行揭示',469,92);
  ctx.font='22px "SimSun",serif';
  ctx.fillText(`${paperRevealRecords[0].location}至${paperRevealRecords.at(-1)!.location}　${paperRevealRecords[0].direction}`,469,188);
  ctx.font='18px "SimSun",serif';
  ctx.fillText(`交付日期：${chineseDate(paperRevealRecords[0].start)}　有效时间至 ${chineseDate(paperRevealRecords[0].end)}`,469,230);
  ctx.font='24px "SimSun",serif';ctx.textAlign='left';
  revealPaperRows.forEach(row=>ctx.fillText(row.text,row.x,row.y,row.width));
}

export function paperLineAtLocalPoint(x: number, y: number): number | null {
  const px = (x / revealPaperSize.width + 0.5) * revealPaperSize.imageWidth;
  const py = (0.5 - y / revealPaperSize.height) * revealPaperSize.imageHeight;
  const index = revealPaperRows.findIndex(row => px >= row.x - 8 && px <= row.x + row.width + 8
    && py >= row.y - 5 && py <= row.y + row.height + 5);
  return index >= 0 ? index : null;
}
