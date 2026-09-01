import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
globalThis.ProgressEvent??=class extends Event{constructor(type,init){super(type);Object.assign(this,init)}};
const bytes=await readFile(new URL('../public/assets/models/hands/uploaded-hand-20260831.glb',import.meta.url));
const len=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+len));
json.buffers[0].uri=`data:application/octet-stream;base64,${bytes.subarray(28+len).toString('base64')}`;
delete json.images;delete json.textures;delete json.materials;
json.meshes.forEach(m=>m.primitives.forEach(p=>delete p.material));
const {scene}=await new GLTFLoader().parseAsync(JSON.stringify(json),'');scene.updateMatrixWorld(true);
const triangles=[];
scene.traverse(m=>{if(!m.isMesh)return;const p=m.geometry.attributes.position,ix=m.geometry.index;
 for(let i=0;i<ix.count;i+=3){const tri=[];for(let j=0;j<3;j++)tri.push(new THREE.Vector3().fromBufferAttribute(p,ix.getX(i+j)).applyMatrix4(m.matrixWorld).sub(new THREE.Vector3(-.16,.77,-.10)).multiplyScalar(.60));triangles.push(tri);}});
function intersections(position,rotation,halfWidth,halfHeight,zMin,zMax){
 const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation));
 let hits=0,minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,frontGap=Infinity,backGap=Infinity;
 for(const source of triangles){
  const t=source.map(v=>v.clone().applyQuaternion(q).add(new THREE.Vector3(...position)));
  for(const p of t)if(p.x<halfWidth&&p.x>halfWidth-.08&&p.y>position[1]-.055&&p.y<position[1]+.05){
    if(p.z>=zMax)frontGap=Math.min(frontGap,p.z-zMax);
    if(p.z<=zMin)backGap=Math.min(backGap,zMin-p.z);
  }
  if(t.every(p=>p.x>halfWidth)||t.every(p=>p.x< -halfWidth)||t.every(p=>p.y>halfHeight)||t.every(p=>p.y< -halfHeight)||t.every(p=>p.z>zMax)||t.every(p=>p.z<zMin))continue;
  // Triangle/axis-aligned box SAT rather than a vertex-only overlap estimate.
  const tri=new THREE.Triangle(...t),box=new THREE.Box3(new THREE.Vector3(-halfWidth,-halfHeight,zMin),new THREE.Vector3(halfWidth,halfHeight,zMax));
  if(box.intersectsTriangle(tri)){hits++;for(const p of t){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}}
 }
 return {hits,minX,maxX,minY,maxY,frontGap,backGap};
}
for(const id of ['paper','notebook','open']){
 const config=id==='paper'?[.23,.1625,-.004,.006]:id==='notebook'?[.135,.195,-.025,.027]:[.2725,.195,-.025,.025];
 const x0=id==='paper'?.205:id==='notebook'?.115:.245,y=id==='paper'?-.115:id==='notebook'?-.07:-.125;
 console.log(id,'baseline',intersections([x0,y,id==='paper'?-.005:.015],[0,0,.10],...config));
 const results=[];
 for(const z of [-.06,-.03,0,.03,.06])for(const ry of [-1.2,-.9,-.6,0,.6,.9,1.2])for(const shift of [.02,.035,.05,.065,.08]) {
 const pos=[x0+shift,y,z],rot=[0,ry,.10],r=intersections(pos,rot,...config);
 results.push({pos,rot,...r});
 }
 results.sort((a,b)=>a.hits-b.hits||Math.min(10,a.frontGap+a.backGap)-Math.min(10,b.frontGap+b.backGap));
 console.log(id,'best',results.slice(0,4));
}
