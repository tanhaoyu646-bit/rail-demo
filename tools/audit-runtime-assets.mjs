import { readFile } from 'node:fs/promises';
const files=['hands/uploaded-hand-20260831.glb','railway-uniform-dispatcher-lite.glb','props/recorder-lite.glb','props/driver-notebook-closed-lite.glb','props/ic-card-lite.glb','props/work-card-lite.glb'];
function dimensions(b) {
  if(b[0]===137&&b.toString('ascii',1,4)==='PNG')return [b.readUInt32BE(16),b.readUInt32BE(20)];
  if(b[0]===255&&b[1]===216)for(let i=2;i+9<b.length;) {
    if(b[i++]!==255)continue;
    const marker=b[i++];if(marker===0xd9||marker===0xda)break;
    if(marker===0xff||marker===0xd8||(marker>=0xd0&&marker<=0xd7))continue;
    const size=b.readUInt16BE(i);if(size<2)break;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return [b.readUInt16BE(i+5),b.readUInt16BE(i+3)];
    i+=size;
  }
  return [0,0];
}
for(const file of files) {
  let bytes;
  try{bytes=await readFile(new URL(`../public/assets/models/${file}`,import.meta.url));}
  catch{bytes=await readFile(new URL(`../public/assets/models/characters/${file}`,import.meta.url));}
  const n=bytes.readUInt32LE(12),gltf=JSON.parse(bytes.subarray(20,20+n)),bin=bytes.subarray(28+n);
  const images=(gltf.images??[]).map(image=>{const view=gltf.bufferViews[image.bufferView];return dimensions(bin.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength));});
  const triangles=gltf.meshes.reduce((sum,m)=>sum+m.primitives.reduce((t,p)=>t+(gltf.accessors[p.indices??p.attributes.POSITION].count/3),0),0);
  console.log(JSON.stringify({file,downloadMiB:+(bytes.length/1048576).toFixed(2),triangles,images,RGBA8WithMipmapsMiB:+(images.reduce((s,[w,h])=>s+w*h*4*4/3,0)/1048576).toFixed(1)}));
}
