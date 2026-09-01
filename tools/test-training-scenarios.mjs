import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=name=>readFile(new URL(`../src/${name}.ts`,import.meta.url),'utf8');
const moduleUrl=code=>`data:text/javascript;base64,${Buffer.from(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64')}`;
const dataUrl=moduleUrl(await source('cardRevealData'));
const {createTrainingScenario,cardMatchesPaper,paperRevealRecords}=await import(dataUrl);
for(let i=0;i<100;i++) {
  const scenario=createTrainingScenario(`student-${i}`);
  assert.deepEqual(scenario,createTrainingScenario(`student-${i}`));
  assert.ok(cardMatchesPaper(scenario.published,scenario.paper));
  assert.notEqual(scenario.paper,scenario.published);
  const wrong=createTrainingScenario(`student-${i}`,true);
  assert.equal(cardMatchesPaper(wrong.published,wrong.paper),false);
  assert.deepEqual(wrong.paper,scenario.paper,'Mismatch changes published copy only');
}
assert.notDeepEqual(createTrainingScenario('1').paper,createTrainingScenario('2').paper);
assert.notEqual(createTrainingScenario('1').paper[0].content,createTrainingScenario('2').paper[0].content);
const hintUrl=moduleUrl(await source('trainingHints'));
const {createHintPicker,hintBanks}=await import(hintUrl);
for(const role of ['deputy','dispatcher']) {
  const pick=createHintPicker(role,()=>.45), first=Array.from({length:hintBanks[role].length},pick);
  assert.equal(new Set(first).size,first.length);
  assert.notEqual(pick(),first.at(-1),'No immediate repeat across bag boundaries');
  for(const hint of first)assert.ok(hint.length<60,'One short cue, not a full answer');
}

let texts=[];const urls=[];
const ctx=new Proxy({fillText:text=>texts.push(String(text)),measureText:text=>({width:[...text].reduce((n,c)=>n+(/[\x00-\xff]/.test(c)?9:18),0)})},{get:(o,k)=>o[k]??(()=>{}),set:(o,k,v)=>(o[k]=v,true)});
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>ctx})};
globalThis.window={location:{search:'?kioskStep=4'}};
globalThis.Image=class{set src(url){urls.push(url);}};
const layoutUrl=moduleUrl((await source('revealPaperLayout')).replace("'./cardRevealData'",JSON.stringify(dataUrl)));
const layout=await import(layoutUrl);
layout.drawPaperReveal(ctx);
assert.ok(texts.some(t=>t.includes('21171')));
assert.equal(layout.revealPaperRows.length,6);
for(const row of layout.revealPaperRows){assert.ok(row.x+row.width<=938);assert.ok(row.underlineY<layout.revealPaperSize.imageHeight);}
let runtimeSource=(await source('kioskScreenRuntime')).replace("'three'",JSON.stringify(import.meta.resolve('three')))
  .replace("'./cardRevealData'",JSON.stringify(dataUrl)).replace("'./revealPaperLayout'",JSON.stringify(layoutUrl)).replaceAll('import.meta.env',"({DEV:true,BASE_URL:'/'})");
const {KioskScreenRuntime}=await import(moduleUrl(runtimeSource));
let step;
const badRecords=paperRevealRecords.map((r,i)=>({...r,order:i?'21172':'99999'}));
const runtime=new KioskScreenRuntime({publishedRecords:badRecords,onClose(){},onComplete(){},onPrinted(){},onStartBreath(){},onStepChange:s=>step=s,onRevealViewChange(){},getSelectedItem:()=> 'delivery-reveal',onInsertCard:async()=>true,onTakeCard(){}});
assert.ok(texts.some(t=>t.includes('[99999]')),'Displayed published notice comes from injected data');
assert.equal(urls.some(url=>url.includes('published-reveal-reference')),false,'No screenshot asset loaded for published notices');
runtime.focusRevealView('paper');for(let i=0;i<6;i++)runtime.markPaperRevealLine(i);
runtime.handlePointer(.91,.93,'up');assert.equal(step,4,'Mismatch cannot advance to writing');
runtime.handlePointer(450/1024,578/618,'up');assert.ok(texts.includes('已记录差异，待调度员复核。'));

const flowCode=(await source('trainingFlows')).replace("'./cardRevealData'",JSON.stringify(dataUrl)).replace("'./trainingHints'",JSON.stringify(hintUrl));
const {mountNotebookFlow}=await import(moduleUrl(flowCode));
const host={innerHTML:'',querySelector:()=>null};mountNotebookFlow(host,{onClose(){}});
assert.ok(host.innerHTML.includes('询问副司机'));
assert.equal(host.innerHTML.includes('绿色许可证'),false);
assert.equal(host.innerHTML.includes('加强瞭望'),false);
assert.equal(host.innerHTML.includes('查看本次预想要点'),false);
for(const obsolete of ['点击完整封面选择','启动打印，纸张','公布揭示只读','确认并进入下一步','验卡读取完成'])assert.equal(runtimeSource.includes(obsolete),false,obsolete);
console.log('PASS: 100 deterministic student scenarios, independent mismatch copies and gating, data-drawn paper/screen, no screenshot fetch, random single-point hints without repeats, no preset notebook answer.');
