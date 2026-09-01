import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
globalThis.ProgressEvent ??= class ProgressEvent extends Event { constructor(type,init={}) { super(type); Object.assign(this,init); } };

const bytes=await readFile(new URL('../public/assets/models/hands/uploaded-hand-20260831.glb',import.meta.url));
const jsonLength=bytes.readUInt32LE(12);
const json=JSON.parse(bytes.subarray(20,20+jsonLength));
assert.equal(json.skins?.length??0,0,'Static source: never pretend it has finger bones');
assert.equal(json.animations?.length??0,0);
assert.equal(json.images.length,3,'Original color, normal and packed PBR textures retained');
assert.ok(json.materials[0].pbrMetallicRoughness.baseColorTexture);
assert.ok(bytes.length<12_000_000);
const triangles=json.meshes.reduce((sum,m)=>sum+m.primitives.reduce((n,p)=>n+json.accessors[p.indices].count/3,0),0);
assert.equal(triangles,60_000);
// Load the real exported vertices/transforms in Node without browser image APIs.
const binStart=20+jsonLength+8;
json.buffers[0].uri=`data:application/octet-stream;base64,${bytes.subarray(binStart).toString('base64')}`;
delete json.images;delete json.textures;delete json.materials;
json.meshes.forEach(m=>m.primitives.forEach(p=>delete p.material));
const {scene}=await new GLTFLoader().parseAsync(JSON.stringify(json),'');
let source=await readFile(new URL('../src/uploadedFpsHand.ts',import.meta.url),'utf8');
source=source.replace(/'(three(?:\/[^']+)?)'/g,(_,s)=>JSON.stringify(import.meta.resolve(s)));
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {placeUploadedHand, workCardGripReference, gripSurfaces, recorderGripSlope, recorderGripPivot}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
for(const id of ['recorder','notebook','ic-card','delivery-reveal','documents','backpack']) {
  const hand=placeUploadedHand(scene.clone(true),id);
  hand.updateMatrixWorld(true);
  assert.equal(hand.name,'右手握持');
  assert.equal(hand.userData.staticGrip,true);
  const size=new THREE.Box3().setFromObject(hand,true).getSize(new THREE.Vector3());
  assert.ok(size.y>.25&&size.y<.70,`${id}: appropriate viewmodel length (${size.y})`);
  hand.traverse(obj=>assert.ok(obj.matrixWorld.determinant()>0,'No negative scale mirroring or joint warping'));
  console.log(id,size.toArray().map(n=>n.toFixed(3)).join(' × '));
}
// The accepted work-card is the geometry baseline, not a descriptive userData
// label. Compare every source vertex in the front/right/bottom contact frame.
const reference=placeUploadedHand(scene.clone(true),'documents');
reference.updateMatrixWorld(true);
const referenceMeshes=[];reference.traverse(o=>{if(o.isMesh)referenceMeshes.push(o);});
const contactFrame=surface=>new THREE.Matrix4().makeTranslation(-surface.right,-surface.bottom,-surface.front);
for(const [id,variant,key] of [
  ['notebook','default','notebook'],['notebook','active','notebook-open'],
  ['delivery-reveal','default','delivery-reveal'],['recorder','default','recorder'],
]) {
  const hand=placeUploadedHand(scene.clone(true),id,variant); hand.updateMatrixWorld(true);
  assert.equal(hand.userData.gripStyle,'work-card-contact');
  const undoSurface=new THREE.Matrix4();
  if(variant==='active') {
    undoSurface.compose(new THREE.Vector3(.14,0,0),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-.08),new THREE.Vector3(1,1,1)).invert();
  } else if(id==='recorder') {
    const pivot=recorderGripPivot;
    undoSurface.makeTranslation(pivot.x,pivot.y,pivot.z)
      .multiply(new THREE.Matrix4().makeRotationX(-recorderGripSlope))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
  }
  let meshIndex=0, maxError=0, checked=0;
  const a=new THREE.Vector3(), b=new THREE.Vector3();
  hand.traverse(mesh=>{
    if(!mesh.isMesh)return;
    const base=referenceMeshes[meshIndex++];
    assert.equal(mesh.geometry,base.geometry,'Rigid contact calibration must not deform the hand mesh');
    const baseMatrix=contactFrame(workCardGripReference).multiply(base.matrixWorld);
    const targetMatrix=contactFrame(gripSurfaces[key]).multiply(undoSurface).multiply(mesh.matrixWorld);
    const positions=mesh.geometry.attributes.position;
    for(let i=0;i<positions.count;i++) {
      a.fromBufferAttribute(positions,i).applyMatrix4(baseMatrix);
      b.fromBufferAttribute(positions,i).applyMatrix4(targetMatrix);
      maxError=Math.max(maxError,a.distanceTo(b)); checked++;
    }
  });
  assert.ok(checked>10000,'Validate actual exported mesh, not an empty group');
  assert.ok(maxError<1e-7,`${id}/${variant}: preserve work-card thumb and fingers relative to the contact surface (${maxError})`);
  console.log(`${id}/${variant}: ${checked} vertices retain work-card contact; max error ${maxError.toExponential(2)}`);
}
const propsSource=await readFile(new URL('../src/sceneProps.ts',import.meta.url),'utf8');
assert.doesNotMatch(propsSource,/prioritizeHeldObject|depthTest\s*=\s*false|depthWrite\s*=\s*false/,
  'Do not cover the thumb by disabling normal depth testing on held items');
scene.updateMatrixWorld(true);
for(const [x,y] of [[-.24,.78],[-.19,.76],[-.15,.79],[-.10,.70]]) {
 const ray=new THREE.Raycaster(new THREE.Vector3(x,y,2),new THREE.Vector3(0,0,-1));
 console.log('source surface',x,y,ray.intersectObject(scene,true).map(h=>h.point.z.toFixed(3)).slice(0,4));
}
const original=await readFile('E:/010工作台/谷歌浏览器下载文件/7e7e65457f59feae54839b8a8ca3afd6 (1).glb');
assert.equal(createHash('sha256').update(original).digest('hex').toUpperCase(),'9BD6C5B289CAB81F2622D3AD2EB0FFD7BCEABDB4A48543F5B7F7336C599D0696');
console.log('PASS: source hash unchanged, textured 60k-triangle derivative, six non-mirrored static poses.');
