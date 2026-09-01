import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
globalThis.ProgressEvent ??= class ProgressEvent extends Event { constructor(type,init={}) { super(type); Object.assign(this,init); } };
export async function loadGeometry(path) {
  const bytes=await readFile(path), length=bytes.readUInt32LE(12);
  const json=JSON.parse(bytes.subarray(20,20+length));
  json.buffers[0].uri=`data:application/octet-stream;base64,${bytes.subarray(28+length).toString('base64')}`;
  delete json.images; delete json.textures; delete json.materials;
  json.meshes.forEach(m=>m.primitives.forEach(p=>delete p.material));
  const {scene}=await new GLTFLoader().parseAsync(JSON.stringify(json),'');
  scene.traverse(o=>{if(o.isMesh)o.material.side=THREE.DoubleSide;});
  return scene;
}
export async function normalizedProp(file,height) {
  const root=await loadGeometry(`public/assets/models/props/${file}`);
  root.updateMatrixWorld(true);
  const initial=new THREE.Box3().setFromObject(root);
  root.scale.setScalar(height/initial.getSize(new THREE.Vector3()).y);
  root.updateMatrixWorld(true);
  const center=new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  root.position.sub(center);root.updateMatrixWorld(true);
  return root;
}
for(const [file,height] of [['work-card-lite.glb',.34],['driver-notebook-closed-lite.glb',.39],['recorder-lite.glb',.205]]) {
  const root=await normalizedProp(file,height), box=new THREE.Box3().setFromObject(root), ray=new THREE.Raycaster();
  console.log(file,'size',box.getSize(new THREE.Vector3()).toArray());
  for(const [x,y] of [[0,0],[.05,-.1],[.08,-.1],[.1,-.1],[.025,-.025],[-.015,-.04],[0,-.04],[.025,-.04],[0,-.015],[.01,-.015],[.01,.01]]) {
    ray.set(new THREE.Vector3(x,y,1),new THREE.Vector3(0,0,-1));
    console.log('surfaces at',x,y,ray.intersectObject(root,true).map(h=>+h.point.z.toFixed(6)).slice(0,8));
  }
}
