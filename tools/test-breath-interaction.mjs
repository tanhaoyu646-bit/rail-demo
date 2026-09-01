import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

const url = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText).toString('base64')}`;
const source = (await readFile(new URL('../src/kioskBreathInteraction.ts', import.meta.url), 'utf8'))
  .replace("'three'", JSON.stringify(import.meta.resolve('three')));
const { fitScreenAndAccessory, nearestKioskSurface } = await import(url(source));
const root = new THREE.Group(); root.position.set(-3.1, .62, -2.55); root.rotation.set(.1, .3, 0);
const screen = new THREE.Mesh(new THREE.BoxGeometry(.96, .58, .025)); screen.position.set(.25, .9, .38);
const sensor = new THREE.Mesh(new THREE.BoxGeometry(.055, .42, .065)); sensor.position.set(-.52, 1.02, .51);
root.add(screen, sensor);
for (const aspect of [16/9, 4/3, 9/16]) {
  const camera = new THREE.PerspectiveCamera(50, aspect, .01, 100);
  fitScreenAndAccessory(camera, screen, sensor);
  for (const object of [screen, sensor]) {
    const box = new THREE.Box3().setFromObject(object);
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const ndc = new THREE.Vector3(x,y,z).project(camera);
      assert.ok(Math.abs(ndc.x) < .99 && Math.abs(ndc.y) < .99 && Math.abs(ndc.z) < 1, `Both objects must fit at aspect ${aspect}`);
    }
  }
}
const background = new THREE.Mesh(new THREE.BoxGeometry(2, 2, .02)); background.position.z = -2;
const foreground = new THREE.Mesh(new THREE.BoxGeometry(.1, .5, .1)); foreground.position.z = -1.5;
background.updateMatrixWorld(); foreground.updateMatrixWorld();
const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
assert.equal(nearestKioskSurface(ray, background, foreground, true).object, foreground, 'Foreground sensor must receive click before screen');
assert.equal(nearestKioskSurface(ray, background, foreground, false).object, background, 'Sensor only active at alcohol step');
foreground.position.z = -3; foreground.updateMatrixWorld();
assert.equal(nearestKioskSurface(ray, background, foreground, true).object, background, 'Hidden sensor may not click through screen');

const dataUrl = url(await readFile(new URL('../src/cardRevealData.ts', import.meta.url), 'utf8'));
const layoutUrl = url((await readFile(new URL('../src/revealPaperLayout.ts', import.meta.url), 'utf8')).replace("'./cardRevealData'",JSON.stringify(dataUrl)));
let runtimeSource = await readFile(new URL('../src/kioskScreenRuntime.ts', import.meta.url), 'utf8');
runtimeSource = runtimeSource.replace("'three'", JSON.stringify(import.meta.resolve('three')))
  .replace("'./revealPaperLayout'", JSON.stringify(layoutUrl)).replace("'./cardRevealData'", JSON.stringify(dataUrl))
  .replaceAll('import.meta.env', "({DEV:true, BASE_URL:'/'})");
const ctx = new Proxy({}, { get: (o,k) => o[k] ?? (() => {}), set:(o,k,v) => (o[k]=v,true) });
globalThis.document = { createElement: () => ({width:0,height:0,getContext: () => ctx}) };
globalThis.window = { location: {search:'?kioskStep=1'} };
globalThis.Image = class {};
const { KioskScreenRuntime } = await import(url(runtimeSource));
let step = -1, started = 0;
const runtime = new KioskScreenRuntime({
  onClose(){}, onComplete(){}, onPrinted(){}, onStepChange: s => {step=s;}, onRevealViewChange(){},
  getSelectedItem: () => null, onInsertCard:async()=>false, onTakeCard(){},
  onStartBreath: () => { if(runtime.beginBreathTest()) started++; },
});
const next = () => runtime.handlePointer(.91,.93,'up');
next(); assert.equal(step,1, 'Cannot proceed before testing');
runtime.completeBreathTest(); next(); assert.equal(step,1,'Completion without actual start must be ignored');
runtime.handlePointer(698/1024,250/618,'up');
assert.equal(started,1, 'Screen start button triggers actual device action');
assert.equal(runtime.beginBreathTest(),false, 'Rapid repeat cannot reset moving sensor');
runtime.cancelBreathTest(); runtime.completeBreathTest(); next(); assert.equal(step,1,'Cancelled test must not pass');
runtime.handlePointer(698/1024,250/618,'up'); runtime.completeBreathTest();
assert.equal(runtime.beginBreathTest(),false,'Passed test need not restart');
next(); assert.equal(step,2,'Completed alcohol test progresses to document selection');
assert.equal(runtime.beginBreathTest(),false,'Cannot start in other steps');
console.log('PASS: screen + sensor viewport fit, closest-surface clicks, step gate, real start button, repeat/cancel protection, next step.');
