import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';

async function importSource(name) {
  let source=await readFile(new URL(`../src/${name}.ts`,import.meta.url),'utf8');
  source=source.replace(/'(three(?:\/[^']+)?)'/g,(_,specifier)=>JSON.stringify(import.meta.resolve(specifier)));
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const {createRefinedFpsHand,gripFingers}=await importSource('refinedFpsHand');
for(const kind of ['recorder','notebook','ic-card']) {
  const before=performance.now(), hand=createRefinedFpsHand(kind);
  const surface=hand.getObjectByName('连续手掌与五指皮肤');
  assert.ok(surface?.isMesh,'Palm and all finger roots use one skin mesh');
  const geometry=surface.geometry, positions=geometry.getAttribute('position'), indices=geometry.getIndex();
  assert.equal(hand.userData.fingerCount,5);
  assert.equal(hand.userData.handedness,'right');
  const fingers=gripFingers(kind).slice(0,4);
  const lengths=fingers.map(f=>f.points.slice(1).reduce((sum,p,i)=>sum+new THREE.Vector3(...p).distanceTo(new THREE.Vector3(...f.points[i])),0));
  assert.ok(lengths[1]>lengths[2]&&lengths[2]>lengths[0]&&lengths[0]>lengths[3],'Middle > ring > index > little in this model');
  for(let i=1;i<4;i++)assert.ok(fingers[i-1].points[0][1]>fingers[i].points[0][1],'Index through little follow a closed gripping arc');
  for(const finger of fingers)assert.ok(finger.points.at(-1)[2]<finger.points[0][2],'Fingers flex toward palm, not backward through dorsum');
  assert.equal(hand.children.filter(c=>c.name.endsWith('指甲')).length,5);
  assert.ok(indices,'Welded indexed normals, not flat triangle normals');
  assert.ok(indices.count/3<42000,'Hand triangle budget');
  for(const n of positions.array) assert.ok(Number.isFinite(n));
  const parent=Array.from({length:positions.count},(_,i)=>i);
  const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  for(let i=0;i<indices.count;i+=3) {
    const a=find(indices.getX(i)),b=find(indices.getX(i+1)),c=find(indices.getX(i+2)); parent[b]=a;parent[c]=a;
  }
  const islands=new Set(parent.map((_,i)=>find(i)));
  assert.equal(islands.size,1,'No detached fingers or separate thumb/palm islands');
  const clone=createRefinedFpsHand(kind);
  assert.equal(clone.getObjectByName(surface.name).geometry,geometry,'Repeated pickup reuses geometry');
  console.log(`${kind}: ${positions.count} vertices, ${indices.count/3} triangles, one connected skin, initial generation ${(performance.now()-before).toFixed(0)}ms.`);
}
const gradient={addColorStop(){}};
const ctx=new Proxy({}, {get:(o,k)=>o[k]??(k==='createRadialGradient'?()=>gradient:()=>{}),set:(o,k,v)=>(o[k]=v,true)});
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>ctx})};
const {createRoomFurniture,decorateRoom,createSeatedDeputy}=await importSource('sceneEnvironment');
const furniture=createRoomFurniture(), room=new THREE.Group();
room.add(...Object.entries(furniture).filter(([key])=>key!=='deskTop').map(([,value])=>value));
room.add(createSeatedDeputy()); decorateRoom(room,new THREE.Group());
let meshes=0,triangles=0;
room.traverse(obj=>{
  if(!obj.isMesh)return; meshes++;
  const p=obj.geometry.getAttribute('position');for(const n of p.array)assert.ok(Number.isFinite(n));
  triangles+=(obj.geometry.index?.count??p.count)/3;
});
assert.ok(triangles<150000,'Room geometry stays within budget');
for(const [key,maxX,maxZ] of [['desk',6.25,2.56],['cabinet',1.7,.65],['bench',2.6,.75],['chair',.7,.7],['stool',.7,.7],['backpack',.5,.37]]) {
  const size=new THREE.Box3().setFromObject(furniture[key]).getSize(new THREE.Vector3());
  assert.ok(size.x<=maxX&&size.z<=maxZ,`${key} stays within reserved furniture footprint`);
}
console.log(`PASS: furniture footprint bounds, finite geometry, ${meshes} visible meshes / ${triangles} triangles (without source GLBs).`);
