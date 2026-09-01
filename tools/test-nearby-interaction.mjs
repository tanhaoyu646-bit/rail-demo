import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { Euler, Vector3 } from 'three';

const source = await readFile(new URL('../src/nearbyInteraction.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { nearestInteraction } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const target = (id, distance, visible = true) => ({ id, distance, radius: 2, visible });
assert.equal(nearestInteraction([target('kiosk', 6), target('dispatcher', 5)]), null);
assert.equal(nearestInteraction([target('kiosk', 1.4), target('dispatcher', 0.8)]).id, 'dispatcher');
assert.equal(nearestInteraction([target('kiosk', 0.4, false), target('notebook', 1.3)]).id, 'notebook');
assert.equal(nearestInteraction([target('notebook', NaN), target('door', 0.6)]).id, 'door');
assert.equal(nearestInteraction([target('kiosk', 2.01)]), null);

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const keyHandler = main.slice(main.indexOf("event.code === 'KeyE'"), main.indexOf("event.code === 'ShiftLeft'"));
assert.ok(keyHandler.includes('interactNearby()'));
assert.ok(!keyHandler.includes('activeStation'), 'Task selection must not choose E target');
assert.ok(main.includes("!typing && !event.repeat && event.code === 'KeyE'"));

const props = await readFile(new URL('../src/sceneProps.ts', import.meta.url), 'utf8');
assert.ok(props.includes('gripPivot.rotation.set(-1.16, 0, Math.PI)'));
const greenDirection = new Vector3(0, -1, 0).applyEuler(new Euler(-1.16, 0, Math.PI));
assert.ok(greenDirection.z < -0.9, 'Green insertion end must face camera-forward -Z');
const printedFaceNormal = new Vector3(0, 0, 1).applyEuler(new Euler(-1.16, 0, Math.PI));
assert.ok(printedFaceNormal.y > 0.9, 'Printed/contact face must face upward');
console.log('PASS: nearby distance, closest object, wall visibility, empty range, E-key routing, IC forward/up orientation.');
