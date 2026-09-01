import * as THREE from 'three';
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Vec = [number, number, number];
type Segment = { a: Vec; b: Vec; r0: number; r1: number };
type Finger = { name: string; points: Vec[]; radius: number };
const templates = new Map<string, THREE.Group>();
const skin = new THREE.MeshStandardMaterial({ color: 0xc8997c, roughness: 0.67 });
const nailMaterial = new THREE.MeshStandardMaterial({ color: 0xd7b6a2, roughness: 0.42 });

function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function ellipsoid(x: number, y: number, z: number, c: Vec, r: Vec): number {
  return (Math.sqrt(((x-c[0])/r[0])**2 + ((y-c[1])/r[1])**2 + ((z-c[2])/r[2])**2) - 1) * Math.min(...r);
}
function capsule(x: number, y: number, z: number, segment: Segment): number {
  const {a,b,r0,r1} = segment;
  const dx=b[0]-a[0], dy=b[1]-a[1], dz=b[2]-a[2];
  const t=THREE.MathUtils.clamp(((x-a[0])*dx+(y-a[1])*dy+(z-a[2])*dz)/(dx*dx+dy*dy+dz*dz),0,1);
  return Math.hypot(x-a[0]-dx*t,y-a[1]-dy*t,z-a[2]-dz*t) - THREE.MathUtils.lerp(r0,r1,t);
}

export function gripFingers(kind: string): Finger[] {
  const paper = kind === 'notebook' || kind === 'delivery-reveal' || kind === 'documents';
  const card = kind === 'ic-card';
  const fingers: Finger[] = [];
  const names = ['食指','中指','无名指','小指'];
  for (let index=0;index<4;index++) {
    // Closed right-hand grip: the four MCP joints follow the outside edge of
    // the object, index above middle/ring/little. +Z is the dorsum, not the palm.
    const x=[.017,.011,.015,.025][index];
    const y=[.041,.018,-.006,-.029][index];
    const lengths=[.073,.081,.076,.057][index];
    const radius=[.0096,.0104,.0098,.0081][index];
    const points: Vec[] = [[x,y,.018]];
    const angles = paper ? [.27,1.36,2.52] : card ? [.43,1.52,2.60] : [.40,1.33,2.25];
    for(let joint=0;joint<3;joint++) {
      const last=points[points.length-1], length=lengths*[.46,.32,.22][joint];
      const angle=angles[joint]+index*.035;
      points.push([last[0]-length*Math.cos(angle),last[1]-.0015,last[2]-length*Math.sin(angle)]);
    }
    fingers.push({name:names[index],points,radius});
  }
  // Two thumb phalanges oppose the four flexed fingers, rather than extending as a fifth parallel finger.
  fingers.push({name:'拇指',radius:0.013,points:paper
    ? [[.039,-.040,.026],[.014,-.020,.041],[-.012,.005,.044],[-.030,.023,.039]]
    : card
      ? [[.039,-.039,.024],[.014,-.018,.041],[-.006,.009,.046],[-.020,.029,.038]]
      : [[.039,-.040,.025],[.014,-.018,.041],[-.012,.010,.046],[-.026,.031,.039]]});
  return fingers;
}

function createSkinSurface(fingers: Finger[]): THREE.BufferGeometry {
  const segments: Segment[] = [];
  fingers.forEach(f => f.points.slice(1).forEach((point,i) => segments.push({a:f.points[i],b:point,
    r0:f.radius*(1-i*.13),r1:f.radius*(.90-i*.13)})));
  const n=64;
  const marching = new MarchingCubes(n,skin,false,false,42000);
  marching.isolation=0;
  const center:Vec=[.044,.022,.006], half:Vec=[.126,.15,.112];
  for(let z=0;z<n;z++) for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
    const px=center[0]+(2*x/n-1)*half[0], py=center[1]+(2*y/n-1)*half[1], pz=center[2]+(2*z/n-1)*half[2];
    // Narrow wrist, domed metacarpals, thenar and hypothenar pads form one continuous skin mesh.
    let d=ellipsoid(px,py,pz,[.044,-.009,.016],[.038,.057,.020]);
    d=smoothMin(d,ellipsoid(px,py,pz,[.057,-.066,.017],[.026,.030,.019]),.011);
    d=smoothMin(d,ellipsoid(px,py,pz,[.031,-.031,.005],[.025,.031,.016]),.011);
    d=smoothMin(d,ellipsoid(px,py,pz,[.065,-.019,.012],[.018,.035,.014]),.009);
    for(const segment of segments) d=smoothMin(d,capsule(px,py,pz,segment),.004);
    marching.field[x+y*n+z*n*n]=-d;
  }
  marching.update();
  const geometry = new THREE.BufferGeometry();
  const positions=marching.geometry.getAttribute('position');
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions.array.slice(0,marching.count*3),3));
  geometry.scale(...half); geometry.translate(...center);
  const welded=mergeVertices(geometry,.00001); welded.computeVertexNormals(); welded.computeBoundingBox();
  geometry.dispose();
  marching.geometry.dispose();
  return welded;
}

function armSurface(): THREE.BufferGeometry {
  const curve=new THREE.CatmullRomCurve3([
    new THREE.Vector3(.35,-.40,.12),new THREE.Vector3(.23,-.23,.073),
    new THREE.Vector3(.11,-.12,.035),new THREE.Vector3(.062,-.074,.025),
  ]);
  const geometry=new THREE.TubeGeometry(curve,32,1,20,false);
  const positions=geometry.getAttribute('position'), vertex=new THREE.Vector3();
  for(let ring=0;ring<=32;ring++) {
    const t=ring/32,c=curve.getPointAt(t),radius=THREE.MathUtils.lerp(.049,.026,t);
    for(let radial=0;radial<=20;radial++) {
      const i=ring*21+radial;
      vertex.fromBufferAttribute(positions,i).sub(c).multiplyScalar(radius).add(c);
      positions.setXYZ(i,vertex.x,vertex.y,vertex.z);
    }
  }
  geometry.computeVertexNormals(); return geometry;
}

/** Refines the original procedural right-hand baseline. Stylized, not a scanned skin asset. */
export function createRefinedFpsHand(kind: string): THREE.Group {
  const key=['notebook','delivery-reveal','documents'].includes(kind) ? 'notebook' : kind;
  let template=templates.get(key);
  if(!template) {
    template=new THREE.Group();
    const fingers=gripFingers(key);
    const surface=new THREE.Mesh(createSkinSurface(fingers),skin); surface.name='连续手掌与五指皮肤';
    const forearm=new THREE.Mesh(armSurface(),skin); forearm.name='裸露前臂与渐细手腕';
    template.add(surface,forearm);
    fingers.forEach(finger=>{
      const tip=new THREE.Vector3(...finger.points[3]);
      const direction=tip.clone().sub(new THREE.Vector3(...finger.points[2])).normalize();
      const nail=new THREE.Mesh(new THREE.SphereGeometry(1,16,10),nailMaterial);
      nail.name=`${finger.name}指甲`;
      const nailNormal=(finger.name==='拇指' ? new THREE.Vector3(0,0,1).projectOnPlane(direction) : new THREE.Vector3(direction.z,0,-direction.x)).normalize();
      nail.position.copy(tip).addScaledVector(direction,-.004).addScaledVector(nailNormal,finger.radius*.65);
      const lateral=new THREE.Vector3().crossVectors(direction,nailNormal).normalize();
      nail.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(lateral,direction,nailNormal));
      nail.scale.set(finger.radius*.55,finger.radius*.73,.0017);
      template!.add(nail);
    });
    // No palm creases on the camera-facing dorsum of a right hand.
    template.userData.handedness='right';
    template.userData.fingerLengths=[.073,.081,.076,.057];
    template.userData.handBaseline='right-grip-v2-20260831';
    template.userData.fingerCount=5;
    template.userData.gripKind=key;
    templates.set(key,template);
  }
  return template.clone(true);
}
