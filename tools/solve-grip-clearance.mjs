import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
const b=await readFile(new URL('../public/assets/models/hands/uploaded-hand-20260831.glb',import.meta.url)),jl=b.readUInt32LE(12),g=JSON.parse(b.subarray(20,20+jl)),base=28+jl;
const p=g.meshes[0].primitives[0];
function accessor(id){const a=g.accessors[id],v=g.bufferViews[a.bufferView],offset=base+(v.byteOffset??0)+(a.byteOffset??0);return a.componentType===5126?new Float32Array(b.buffer,b.byteOffset+offset,a.count*3):a.componentType===5125?new Uint32Array(b.buffer,b.byteOffset+offset,a.count):new Uint16Array(b.buffer,b.byteOffset+offset,a.count);}
const pos=accessor(p.attributes.POSITION),ix=accessor(p.indices),source=new Float64Array(pos.length),v=new THREE.Vector3(),q=new THREE.Quaternion(...g.nodes[0].rotation);
for(let i=0;i<pos.length;i+=3){v.fromArray(pos,i).applyQuaternion(q).sub(new THREE.Vector3(-.16,.77,-.1)).multiplyScalar(.6).toArray(source,i);}
for(const kind of ['paper','closed','open']){
 const edge=kind==='paper'?.23:kind==='closed'?.135:.273,height=kind==='paper'?.1625:.195,y=kind==='closed'?-.07:-.10;
 const thick=kind==='paper'?.006:kind==='closed'?.011:.012;
 const best=[];
 for(const rx of [-1.2,-.8,-.4,0,.4,.8,1.2])for(const ry of [-1.2,-.8,-.4,0,.4,.8,1.2])for(const rz of [-.3,.1,.5])for(const z of [-.07,-.035,0,.035,.07]){
  const m=new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx,ry,rz)).elements,vertices=new Float64Array(source.length);
  for(let i=0;i<source.length;i+=3){const x=source[i],yy=source[i+1],zz=source[i+2];vertices[i]=m[0]*x+m[4]*yy+m[8]*zz;vertices[i+1]=m[1]*x+m[5]*yy+m[9]*zz+y;vertices[i+2]=m[2]*x+m[6]*yy+m[10]*zz+z;}
  let cutMin=Infinity;
  for(let i=0;i<ix.length;i+=3){
   const a=ix[i]*3,c=ix[i+1]*3,d=ix[i+2]*3;
   if(Math.min(vertices[a+2],vertices[c+2],vertices[d+2])>thick||Math.max(vertices[a+2],vertices[c+2],vertices[d+2])< -thick)continue;
   for(const [j,k] of [[a,c],[c,d],[d,a]]){
    if(Math.abs(vertices[j+2])<=thick)cutMin=Math.min(cutMin,vertices[j]);
    for(const plane of [-thick,thick]){const t=(plane-vertices[j+2])/(vertices[k+2]-vertices[j+2]);if(t>=0&&t<=1)cutMin=Math.min(cutMin,vertices[j]+t*(vertices[k]-vertices[j]));}
   }
  }
  if(!Number.isFinite(cutMin))continue;
  const x=edge-cutMin+.001;
  if(x<edge-.025||x>edge+.13)continue;
  let front=Infinity,back=Infinity,cover=0;
  for(let i=0;i<vertices.length;i+=3){const px=vertices[i]+x,py=vertices[i+1],pz=vertices[i+2];
   if(px>edge-.08&&px<edge-.005&&py>y-.07&&py<y+.07&&Math.abs(py)<height){
    if(pz>thick)front=Math.min(front,pz-thick);
    if(pz< -thick)back=Math.min(back,-thick-pz);
    cover++;
   }
  }
  if(Number.isFinite(front+back))best.push({position:[x,y,z],rotation:[rx,ry,rz],front,back,cover,score:front+back+Math.abs(rx)*.002+Math.abs(ry)*.002});
 }
 best.sort((a,b)=>a.score-b.score);console.log(kind,JSON.stringify(best.slice(0,5),null,2));
}
