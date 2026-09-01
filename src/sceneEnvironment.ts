import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

type V3 = [number, number, number];
export const deputyForwardOffset = 1.15;
export const counterBounds = { minX: -.27, maxX: 5.97, minZ: -3.99, maxZ: -1.44 };
export const dispatcherPosition: V3 = [2.75, .12, -2.92];
export const rearDoorPosition: V3 = [0,1.25,7.96];
const materials = {
  enamel: new THREE.MeshStandardMaterial({ color: 0xc4cec8, roughness: .6 }),
  edge: new THREE.MeshStandardMaterial({ color: 0x354942, roughness: .6 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x899795, roughness: .38, metalness: .7 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x202b2c, roughness: .72 }),
  fabric: new THREE.MeshStandardMaterial({ color: 0x48665f, roughness: .95 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x927c5e, roughness: .76 }),
  paper: new THREE.MeshStandardMaterial({ color: 0xf1ebdc, roughness: .9 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x56777d, roughness: .22, metalness: .25 }),
  skin: new THREE.MeshStandardMaterial({ color: 0xc29a7c, roughness: .78 }),
  shirt: new THREE.MeshStandardMaterial({ color: 0xa6bccb, roughness: .86 }),
  navy: new THREE.MeshStandardMaterial({ color: 0x24354b, roughness: .9 }),
};
type Mat = keyof typeof materials;
function box(parent: THREE.Object3D, name: string, size: V3, pos: V3, mat: Mat, radius = .014): THREE.Mesh {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(...size, 2, Math.min(radius, ...size.map(n => n*.45))), materials[mat]);
  mesh.position.set(...pos); mesh.name = name; parent.add(mesh); return mesh;
}
function oval(parent: THREE.Object3D, name: string, scale: V3, pos: V3, mat: Mat): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), materials[mat]);
  mesh.scale.set(...scale); mesh.position.set(...pos); mesh.name = name; parent.add(mesh); return mesh;
}
function rod(parent: THREE.Object3D, name: string, a: V3, b: V3, radius: number, mat: Mat): THREE.Mesh {
  const p = new THREE.Vector3(...a), q = new THREE.Vector3(...b), delta=q.clone().sub(p);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), 12), materials[mat]);
  mesh.position.copy(p.add(q).multiplyScalar(.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());
  mesh.name=name; parent.add(mesh); return mesh;
}
function label(parent: THREE.Object3D, text: string, width: number, height: number, pos: V3, background='#f2f0e7', foreground='#294c43'): THREE.Mesh {
  const canvas=document.createElement('canvas'); canvas.width=1024; canvas.height=Math.max(128,Math.round(1024*height/width));
  const ctx=canvas.getContext('2d')!;
  ctx.fillStyle=background; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle=foreground; ctx.font=`600 ${Math.round(canvas.height*.47)}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(text,512,canvas.height*.52,970);
  const texture=new THREE.CanvasTexture(canvas); texture.colorSpace=THREE.SRGBColorSpace;
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,height),new THREE.MeshBasicMaterial({map:texture}));
  mesh.position.set(...pos); mesh.name=text; parent.add(mesh); return mesh;
}
function group(name: string, position: V3): THREE.Group {
  const result=new THREE.Group(); result.name=name; result.position.set(...position); return result;
}

function marbleMaterial(): THREE.MeshStandardMaterial {
  const canvas=document.createElement('canvas'); canvas.width=1024; canvas.height=256;
  const ctx=canvas.getContext('2d')!;
  ctx.fillStyle='#d7d4cd';ctx.fillRect(0,0,1024,256);
  for(let vein=0;vein<16;vein++) {
    ctx.beginPath();ctx.lineWidth=vein%3===0?1.8:.7;ctx.strokeStyle=vein%3===0?'rgba(86,92,87,.16)':'rgba(255,255,255,.40)';
    for(let x=0;x<=1024;x+=8){const y=vein*27-90+x*.1+Math.sin(x*.016+vein*1.9)*16+Math.sin(x*.041+vein)*3;if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
    ctx.stroke();
  }
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
  return new THREE.MeshStandardMaterial({map:texture,roughness:.34,metalness:0});
}

/** Closed service counter; its reserved footprint is also the staff-only area. */
export function createRoomFurniture() {
  const desk=group('封闭出勤台',[2.85,0,-1.96]);
  const marble=marbleMaterial();
  box(desk,'全封闭前柜体',[6.08,1.02,.94],[0,.55,0],'enamel',.012);
  box(desk,'通长踢脚',[6.02,.13,.88],[0,.075,-.01],'dark',.003);
  const deskTop=box(desk,'大理石通长台面',[6.20,.085,1.04],[0,1.1025,0],'paper',.013);deskTop.material=marble;
  box(desk,'前沿金属收口',[6.18,.018,.018],[0,1.055,.505],'steel',.003);
  for(const x of [-2.05,-1.03,0,1.03,2.05])box(desk,'柜面竖向接缝',[.009,.88,.003],[x,.57,.472],'edge',.001);
  // Returns join the back wall/right wall. No open knee well, legs or drawers.
  for(const x of [-2.89,2.89]) {
    box(desk,'侧向封闭围台',[.42,1.02,1.53],[x,.55,-1.25],'enamel',.008);
    const top=box(desk,'大理石侧向台面',[.44,.085,1.54],[x,1.1025,-1.25],'paper',.01);top.material=marble;
    box(desk,'围台踢脚',[.40,.13,1.52],[x,.075,-1.25],'dark',.003);
  }
  box(desk,'工作垫',[.9,.008,.42],[-.10,1.151,-.01],'edge');
  box(desk,'报单夹',[.28,.012,.32],[-.86,1.156,.03],'dark');
  box(desk,'报单纸张',[.25,.007,.29],[-.86,1.166,.04],'paper');
  box(desk,'电话底座',[.26,.055,.21],[.83,1.177,0],'dark');
  const handset=box(desk,'电话听筒',[.31,.052,.065],[.83,1.221,.015],'dark',.024);handset.rotation.y=.12;
  for(let i=0;i<3;i++)rod(desk,'签字笔',[-.40+i*.035,1.166,.13],[-.38+i*.035,1.166,-.04],.004,'dark');
  const nameplate=label(desk,'出勤调度员',.46,.09,[-.10,1.218,.43]);nameplate.rotation.x=-.16;

  const cabinet=group('资料柜',[4.8,0,-3.62]);
  box(cabinet,'钢制柜身',[1.6,1.85,.48],[0,.925,0],'enamel');
  box(cabinet,'柜底踢脚',[1.5,.10,.44],[0,.05,0],'dark');
  for(const x of [-.397,.397]) {
    box(cabinet,'柜门',[.775,1.7,.025],[x,.95,.251],'enamel');
    box(cabinet,'上半部玻璃窗',[.65,.78,.018],[x,1.30,.269],'glass');
    for(let i=0;i<6;i++) box(cabinet,'资料夹书脊',[.064,.25,.02],[x-.24+i*.093,1.10,.281],i%2?'edge':'navy',.002);
    box(cabinet,'内部横隔板',[.65,.018,.018],[x,.96,.29],'steel');
    rod(cabinet,'柜门拉手',[x+(x<0?.29:-.29),.77,.29],[x+(x<0?.29:-.29),.99,.29],.011,'steel');
    label(cabinet,x<0?'作业资料':'规章档案',.38,.055,[x,1.76,.276]);
  }

  const bench=group('候班长椅',[2.7,0,1.15+deputyForwardOffset]);
  box(bench,'长椅钢梁',[2.35,.07,.10],[0,.34,0],'steel');
  for(const x of [-.99,.99]) for(const z of [-.22,.22]) rod(bench,'长椅支腿',[x,.06,z],[x,.43,z],.022,'steel');
  for(const x of [-.82,0,.82]) {
    box(bench,'独立坐垫',[.76,.12,.61],[x,.51,0],'fabric',.05);
    const back=box(bench,'靠背软垫',[.76,.50,.08],[x,.82,-.267],'fabric',.035); back.rotation.x=.10;
    rod(bench,'靠背支架',[x,.33,-.25],[x,1.03,-.29],.015,'steel');
  }
  for(const x of [-1.22,1.22]) {
    rod(bench,'扶手支柱',[x,.34,.17],[x,.74,.17],.017,'steel');
    box(bench,'扶手垫',[.065,.04,.40],[x,.76,0],'dark');
  }

  const chair=group('调度员座椅',[3.85,0,-3.23]);
  box(chair,'座椅坐垫',[.59,.12,.59],[0,.56,0],'fabric',.06);
  box(chair,'弧形靠背',[.56,.65,.11],[0,.96,.23],'fabric',.05);
  rod(chair,'升降柱',[0,.12,0],[0,.53,0],.034,'steel');
  for(let i=0;i<5;i++) {
    const x=Math.cos(i*Math.PI*.4)*.28,z=Math.sin(i*Math.PI*.4)*.28;
    rod(chair,'五星底脚',[0,.14,0],[x,.07,z],.022,'dark');
    oval(chair,'脚轮',[.032,.032,.024],[x,.035,z],'dark');
  }
  for(const x of [-.29,.29]) {
    rod(chair,'扶手架',[x,.48,0],[x,.77,0],.015,'steel');
    box(chair,'扶手',[.055,.038,.34],[x,.79,0],'dark');
  }
  const stool=group('候班圆凳',[4.35,0,.95+deputyForwardOffset]);
  const stoolSeat=new THREE.Mesh(new THREE.CylinderGeometry(.32,.32,.10,32),materials.fabric);
  stoolSeat.position.y=.49; stool.add(stoolSeat);
  for(const x of [-.21,.21]) for(const z of [-.21,.21]) rod(stool,'圆凳支腿',[x,.03,z],[x*.82,.44,z*.82],.016,'steel');
  const ring=new THREE.Mesh(new THREE.TorusGeometry(.235,.011,8,32),materials.steel);
  ring.rotation.x=Math.PI/2; ring.position.y=.20; stool.add(ring);

  const backpack=group('地面背包',[4.75,0,1.62+deputyForwardOffset]);
  box(backpack,'织物包身',[.45,.56,.25],[0,.30,0],'edge',.065);
  box(backpack,'前置口袋',[.35,.22,.06],[0,.22,.143],'fabric',.035);
  box(backpack,'顶部翻盖',[.42,.17,.06],[0,.49,.135],'fabric',.035);
  for(const x of [-.12,.12]) {
    box(backpack,'织带',[.036,.31,.01],[x,.33,.178],'dark',.003);
    box(backpack,'塑料扣具',[.047,.045,.025],[x,.37,.19],'dark',.009);
  }
  const handle=new THREE.Mesh(new THREE.TorusGeometry(.08,.012,8,20,Math.PI),materials.dark);
  handle.position.y=.58; backpack.add(handle);
  rod(backpack,'口袋拉链',[-.13,.29,.178],[.13,.29,.178],.003,'steel');
  return {desk,deskTop,cabinet,bench,chair,stool,backpack};
}

export function decorateRoom(room: THREE.Group, doorPivot: THREE.Group): void {
  // Baked-style contact shading: one small shared texture, no realtime shadow maps.
  const shadowCanvas=document.createElement('canvas'); shadowCanvas.width=shadowCanvas.height=128;
  const shadowContext=shadowCanvas.getContext('2d')!;
  const gradient=shadowContext.createRadialGradient(64,64,8,64,64,64);
  gradient.addColorStop(0,'rgba(27,39,33,.30)'); gradient.addColorStop(.58,'rgba(27,39,33,.12)'); gradient.addColorStop(1,'rgba(27,39,33,0)');
  shadowContext.fillStyle=gradient; shadowContext.fillRect(0,0,128,128);
  const shadowMaterial=new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(shadowCanvas),transparent:true,depthWrite:false});
  const footprints: [number,number,number,number][]=[[-3.1,-2.55,1.8,1.25],[2.85,-1.96,6.35,1.3],[4.8,-3.62,1.85,.85],[2.7,1.15+deputyForwardOffset,2.9,1.2],[3.85,-3.23,.95,.95],[4.35,.95+deputyForwardOffset,.9,.9],[4.75,1.62+deputyForwardOffset,.75,.6]];
  footprints.forEach(([x,z,w,d])=>{
    const shadow=new THREE.Mesh(new THREE.PlaneGeometry(w,d),shadowMaterial);
    shadow.name='静态接触阴影'; shadow.rotation.x=-Math.PI/2; shadow.position.set(x,.004,z); room.add(shadow);
  });
  // Skirting, chair rail and ceiling perimeter use the existing walls, without changing navigation.
  for(const x of [-5.925,5.925]) {
    box(room,'墙脚保护条',[.025,.14,12],[x,.075,2],'edge',.003);
    box(room,'墙面分色压条',[.025,.035,12],[x,1.05,2],'enamel',.003);
  }
  box(room,'后墙踢脚',[10.02,.14,.024],[.99,.075,-3.924],'edge',.002);
  for(const x of [-5.22,-4.04]) box(room,'门框立柱',[.055,2.29,.11],[x,1.145,-3.9],'steel');
  box(room,'门框横梁',[1.24,.065,.11],[-4.63,2.27,-3.9],'steel');
  label(room,'出 勤 室',.82,.15,[-4.61,2.48,-3.92],'#e0e4de','#294c43');
  box(doorPivot,'观察窗外框',[.62,.68,.023],[.55,1.48,.064],'steel');
  box(doorPivot,'观察窗玻璃',[.54,.60,.024],[.55,1.48,.079],'glass');
  rod(doorPivot,'门把手',[.86,.96,.11],[1.00,.96,.11],.016,'steel');
  box(doorPivot,'下部防踢板',[.98,.25,.015],[.55,.18,.047],'steel');
  label(doorPivot,'出 勤 室',.37,.13,[.55,1.02,.042]);
  box(room,'揭示栏铝框',[3.85,1.45,.06],[.6,2.05,-3.91],'steel');
  box(room,'揭示栏底板',[3.75,1.35,.028],[.6,2.05,-3.868],'edge');
  label(room,'乘务出勤 · 安全信息栏',3.54,.20,[.6,2.59,-3.845],'#284d43','#eef1e6');
  ['出勤作业流程','运行揭示管理','天气与风险提示','班组学习安排'].forEach((title,index)=>{
    const x=-.76+index*.91;
    box(room,'栏内纸张',[.80,.89,.007],[x,1.96,-3.843],'paper',.001);
    label(room,title,.75,.075,[x,2.32,-3.836]);
    for(let line=0;line<7;line++) box(room,'示意排版线',[line%3===0?.59:.68,.009,.003],[x,2.18-line*.080,-3.836],'enamel',.001);
    label(room,'教学场景示意',.57,.060,[x,1.60,-3.835]);
  });
  const clock=group('挂钟',[3.30,2.67,-3.9]);
  const rim=new THREE.Mesh(new THREE.CylinderGeometry(.225,.225,.04,48),materials.steel); rim.rotation.x=Math.PI/2; clock.add(rim);
  const face=new THREE.Mesh(new THREE.CircleGeometry(.204,48),materials.paper); face.position.z=.023; clock.add(face);
  for(let i=0;i<12;i++) {
    const angle=i*Math.PI/6;
    const tick=box(clock,'时钟刻度',[.010,i%3===0?.034:.023,.004],[Math.sin(angle)*.177,Math.cos(angle)*.177,.027],'dark',.001);
    tick.rotation.z=-angle;
  }
  const hour=box(clock,'时针',[.010,.102,.004],[.025,.042,.032],'dark',.002); hour.rotation.z=-.55;
  const minute=box(clock,'分针',[.007,.15,.004],[-.044,.051,.035],'dark',.002); minute.rotation.z=.71;
  room.add(clock);
  for(const x of [-3.6,0,3.6]) for(const z of [-.2,4.6]) {
    box(room,'吸顶灯框',[2.25,.065,.56],[x,3.32,z],'enamel');
    const panel=box(room,'柔光灯板',[2.12,.012,.44],[x,3.28,z],'paper');
    panel.material=new THREE.MeshBasicMaterial({color:0xfff8e8});
  }
}

/** Deliberately generic seated deputy. Not an identity reconstruction. */
export function createSeatedDeputy(): THREE.Group {
  const person=group('副司机（坐姿）',[2.05,0,1.12+deputyForwardOffset]);
  person.userData.interactionLabel='副司机：配合填写司机手帐与出乘预想';
  box(person,'制服衬衫',[.43,.51,.28],[0,.91,0],'shirt',.065);
  box(person,'腰带',[.41,.044,.29],[0,.661,0],'dark');
  box(person,'肩章左',[.115,.022,.073],[-.16,1.16,0],'navy');
  box(person,'肩章右',[.115,.022,.073],[.16,1.16,0],'navy');
  for(const x of [-.11,.11]) box(person,'衬衫口袋',[.105,.105,.008],[x,1.00,.146],'shirt',.006);
  for(let y=.74;y<1.14;y+=.075) oval(person,'衬衫纽扣',[.006,.006,.004],[0,y,.148],'dark');
  const collarL=box(person,'左衣领',[.085,.085,.018],[-.046,1.14,.14],'shirt'); collarL.rotation.z=-.40;
  const collarR=box(person,'右衣领',[.085,.085,.018],[.046,1.14,.14],'shirt'); collarR.rotation.z=.40;
  rod(person,'颈部',[0,1.13,0],[0,1.26,0],.067,'skin');
  oval(person,'头部',[.128,.163,.115],[0,1.40,.008],'skin');
  oval(person,'下颌',[.102,.085,.10],[0,1.31,.035],'skin');
  oval(person,'短发',[.131,.078,.119],[0,1.508,-.008],'dark');
  for(const x of [-.13,.13]) oval(person,'耳朵',[.024,.042,.022],[x,1.39,0],'skin');
  oval(person,'鼻梁',[.017,.034,.026],[0,1.396,.120],'skin');
  for(const x of [-.044,.044]) {
    oval(person,'眼白',[.020,.008,.006],[x,1.426,.112],'paper');
    oval(person,'瞳孔',[.007,.007,.004],[x,1.426,.118],'dark');
    box(person,'眉毛',[.039,.005,.008],[x,1.448,.110],'dark',.002);
  }
  box(person,'嘴唇',[.038,.006,.005],[0,1.345,.125],'wood',.002);
  for(const side of [-1,1]) {
    const x=side*.115;
    rod(person,'坐姿大腿',[x,.60,0],[x,.57,.42],.092,'navy');
    oval(person,'膝盖',[.088,.091,.087],[x,.56,.42],'navy');
    rod(person,'小腿',[x,.54,.42],[x,.14,.43],.061,'navy');
    box(person,'皮鞋',[.15,.11,.28],[x,.071,.50],'dark',.042);
    rod(person,'短袖',[side*.20,1.08,0],[side*.26,.92,.05],.086,'shirt');
    rod(person,'上臂',[side*.26,.93,.05],[side*.28,.75,.15],.053,'skin');
    oval(person,'肘部',[.053,.053,.053],[side*.28,.75,.15],'skin');
    rod(person,'前臂',[side*.28,.75,.15],[side*.14,.68,.34],.041,'skin');
    oval(person,'搭在膝上的手',[.053,.027,.078],[side*.14,.66,.38],'skin');
    for(let i=0;i<4;i++) rod(person,'放松的手指',[side*.14+(i-1.5)*.019,.66,.39],[side*.14+(i-1.5)*.019,.64,.455],.008,'skin');
  }
  return person;
}

export function createFloorMaterial(): THREE.MeshStandardMaterial {
  const canvas=document.createElement('canvas'); canvas.width=canvas.height=512;
  const ctx=canvas.getContext('2d')!;
  ctx.fillStyle='#b8b9b2'; ctx.fillRect(0,0,512,512);
  ctx.fillStyle='#d4d3cb'; ctx.fillRect(2,2,508,508);
  // Deterministic fine aggregate; no source photograph is modified.
  let seed=19;
  for(let i=0;i<12000;i++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0; const x=seed%508+2;
    seed=(Math.imul(seed,1664525)+1013904223)>>>0; const y=seed%508+2;
    ctx.fillStyle=i%2?'rgba(100,110,105,.07)':'rgba(255,255,255,.16)'; ctx.fillRect(x,y,1,1);
  }
  const texture=new THREE.CanvasTexture(canvas); texture.colorSpace=THREE.SRGBColorSpace;
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping; texture.repeat.set(15,15); texture.anisotropy=4;
  return new THREE.MeshStandardMaterial({map:texture,roughness:.82,metalness:0});
}

export function createRearDoorDetails(room: THREE.Group, pivot: THREE.Group): void {
  for(const x of [-.69,.69])box(room,'派班室后门门框',[.06,2.29,.14],[x,1.145,7.94],'steel');
  box(room,'派班室后门上框',[1.44,.065,.14],[0,2.27,7.94],'steel');
  for(const direction of [-1,1]) {
    box(pivot,'后门观察窗外框',[.65,.68,.02],[.65,1.48,direction*.056],'steel');
    box(pivot,'后门观察窗',[.57,.60,.02],[.65,1.48,direction*.072],'glass');
    rod(pivot,'后门把手',[1.02,.96,direction*.10],[1.16,.96,direction*.10],.016,'steel');
    box(pivot,'后门防踢板',[1.18,.25,.016],[.65,.18,direction*.046],'steel');
    const sign=label(pivot,'派 班 室',.38,.13,[.65,1.03,direction*.048]);
    if(direction<0)sign.rotation.y=Math.PI;
  }
  for(const x of [-3.35,3.35])box(room,'入口墙踢脚',[5.28,.14,.024],[x,.075,7.924],'edge',.002);
}
