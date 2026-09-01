import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const cardDataUrl = moduleUrl(transpile(await readFile(new URL('../src/cardRevealData.ts', import.meta.url), 'utf8')));
const layoutUrl = moduleUrl(transpile((await readFile(new URL('../src/revealPaperLayout.ts', import.meta.url), 'utf8')).replace("'./cardRevealData'",JSON.stringify(cardDataUrl))));
const layout = await import(layoutUrl);
const { TrainingCardMemory, cardMatchesPaper, paperRevealRecords } = await import(cardDataUrl);
for (const [index, row] of layout.revealPaperRows.entries()) {
  const x = ((row.x + row.width / 2) / 938 - 0.5) * 0.45;
  const y = (0.5 - (row.y + row.height / 2) / 699) * 0.316;
  assert.equal(layout.paperLineAtLocalPoint(x, y), index);
}
assert.equal(layout.paperLineAtLocalPoint(0, 0.12), null, 'Title must not count as a body line');
assert.equal(layout.paperLineAtLocalPoint(0.21, -0.12), null, 'Blank right margin must not count');

const ctx = new Proxy({}, { get: (object, key) => object[key] ?? (() => {}), set: (o, k, v) => (o[k] = v, true) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
globalThis.window = { location: { search: '?kioskStep=4' } };
globalThis.Image = class { complete = true; naturalWidth = 1819; naturalHeight = 1100; };
let source = await readFile(new URL('../src/kioskScreenRuntime.ts', import.meta.url), 'utf8');
source = source.replace("'three'", JSON.stringify(import.meta.resolve('three')))
  .replace("'./revealPaperLayout'", JSON.stringify(layoutUrl))
  .replace("'./cardRevealData'", JSON.stringify(cardDataUrl))
  .replaceAll('import.meta.env', "({ DEV: true, BASE_URL: '/' })");
const { KioskScreenRuntime } = await import(moduleUrl(transpile(source)));
let step;
let selected = 'delivery-reveal';
let complete = false;
let tookCard = false;
let insertCalls = 0;
let finishInsert;
const cardMemory = new TrainingCardMemory();
const runtime = new KioskScreenRuntime({
  onClose() {}, onComplete() { complete = true; }, onPrinted() {}, onRevealViewChange() {}, onStartBreath() {},
  getSelectedItem: () => selected, onStepChange: value => { step = value; },
  onInsertCard: () => { insertCalls++; return new Promise(resolve => { finishInsert = resolve; }); },
  onTakeCard: () => { tookCard = true; }, cardMemory,
});
assert.equal(step, 4);
assert.equal(runtime.markPaperRevealLine(0), false, 'Overview cannot mark paper');
runtime.handlePointer(0.5, 0.5, 'up');
assert.deepEqual(runtime.getPaperMarks(), [], 'Published screen click cannot mark paper');
runtime.handlePointer(0.91, 0.93, 'up');
assert.equal(step, 4, 'Incomplete paper prevents progression');
runtime.focusRevealView('paper');
for (let index = 0; index < 6; index++) assert.equal(runtime.markPaperRevealLine(index), true);
runtime.markPaperRevealLine(0);
assert.equal(runtime.getPaperMarks().length, 6, 'Repeated clicks must be idempotent');
runtime.focusRevealView('screen');
runtime.handlePointer(0.91, 0.93, 'up');
assert.equal(step, 5, 'Paper alone completes the check; published marks are not required');
console.log('PASS: six paper hit regions, focus gate, read-only published screen, duplicate clicks, progression to IC.');

const click = (x, y) => runtime.handlePointer(x / 1024, y / 618, 'up');
click(466, 370); // no card: write blocked
click(714, 370); // no card: verify blocked
assert.equal(step, 5);
assert.deepEqual(cardMemory.read(), []);
await runtime.insertCard();
assert.equal(insertCalls, 0, 'Wrong held item cannot insert');
selected = 'ic-card';
const insertion = runtime.insertCard();
void runtime.insertCard();
click(466, 370); click(714, 370);
assert.equal(insertCalls, 1, 'Repeated insert while busy must not duplicate');
assert.deepEqual(cardMemory.read(), [], 'Writing waits for physical insertion');
finishInsert(false); await insertion;
click(466, 370);
assert.deepEqual(cardMemory.read(), [], 'Cancelled insertion cannot write');
const retry = runtime.insertCard(); finishInsert(true); await retry;
click(714, 370);
assert.equal(step, 5, 'Inserted but unwritten card cannot verify');
click(466, 370);
assert.equal(complete, false, 'Writing alone cannot complete kiosk');
assert.equal(cardMemory.read().length, 2, 'Read count derives from written records, not screenshot count');
const editedRead = cardMemory.read(); editedRead[0].order = '999';
assert.equal(cardMemory.read()[0].order, '21171', 'Readback must not alias card storage');
click(714, 370);
assert.equal(step, 6);
assert.equal(runtime.isRevealComparison(), false, 'Count confirmation comes before content comparison');
click(920, 580);
assert.equal(complete, false);
click(512, 425);
assert.equal(runtime.isRevealComparison(), true);
assert.deepEqual(runtime.getPaperMarks(), [], 'Published check marks must not auto-complete paper/card check');
click(400, 190);
assert.deepEqual(runtime.getPaperMarks(), [], 'Card screen remains readonly');
runtime.focusRevealView('paper');
for (let i = 0; i < 5; i++) runtime.markPaperRevealLine(i);
click(920, 580);
assert.equal(complete, false, 'Partial paper/card marks block completion');
runtime.markPaperRevealLine(5); runtime.markPaperRevealLine(5);
assert.equal(runtime.getPaperMarks().length, 6);
// A new verify reads current card data and invalidates all previous confirmations.
click(760, 580); // back to writing
cardMemory.write([{ ...paperRevealRecords[0], content: '错误数据' }, paperRevealRecords[1]]);
click(714, 370); click(512, 425);
assert.deepEqual(runtime.getPaperMarks(), []);
runtime.focusRevealView('paper');
assert.equal(runtime.markPaperRevealLine(0), false, 'Mismatched payload blocks confirmation');
click(920, 580);
assert.equal(complete, false);
click(760, 580); click(466, 370); click(714, 370); click(512, 425);
runtime.focusRevealView('paper');
for (let i = 0; i < 6; i++) runtime.markPaperRevealLine(i);
click(920, 580);
assert.equal(complete, true); assert.equal(tookCard, true, 'Card is returned only after comparison');
assert.equal(cardMatchesPaper([]), false);
assert.equal(cardMatchesPaper([paperRevealRecords[0], paperRevealRecords[0]]), false);
assert.equal(cardMatchesPaper([...paperRevealRecords].reverse()), true);
for (const key of Object.keys(paperRevealRecords[0])) {
  assert.equal(cardMatchesPaper([{ ...paperRevealRecords[0], [key]: '不同内容' }, paperRevealRecords[1]]), false, `Mismatch in ${key}`);
}
console.log('PASS: physical insertion gate, cancelled/repeated actions, write/read snapshots, explicit verify/count, independent paper/card check, mismatches, rewrite/reverify, completion/takeback.');
