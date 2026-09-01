import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { revealPaperRows, revealPaperSize, drawPaperReveal } from './revealPaperLayout';
import { createRefinedFpsHand } from './refinedFpsHand';
import { createUploadedFpsHand } from './uploadedFpsHand';
import { disposeOwnedObject } from './resourceLifetime';

export type InventoryItemId = 'recorder' | 'notebook' | 'ic-card' | 'delivery-reveal' | 'documents' | 'backpack';
export type HeldItemVariant = 'default' | 'active';

const asset = (path: string) => `${import.meta.env.BASE_URL}assets/${path}`;
const textureLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
const fpsHandUrl = asset('models/hands/right-hand-fps-lite.glb');
let fpsHandTemplatePromise: Promise<THREE.Group> | null = null;

type HeldModelConfig = {
  url: string;
  targetHeight: number;
  rotation?: [number, number, number];
};

const heldModelConfigs: Partial<Record<InventoryItemId, HeldModelConfig>> = {
  recorder: { url: asset('models/props/recorder-lite.glb'), targetHeight: 0.205 },
  notebook: { url: asset('models/props/driver-notebook-closed-lite.glb'), targetHeight: 0.39 },
  'ic-card': { url: asset('models/props/ic-card-lite.glb'), targetHeight: 0.24, rotation: [Math.PI / 2, 0, 0] },
  documents: { url: asset('models/props/work-card-lite.glb'), targetHeight: 0.34 },
};

const activeHeldModelConfigs: Partial<Record<InventoryItemId, HeldModelConfig>> = {};

function material(color: number, roughness = 0.62, metalness = 0.02): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function imageFace(url: string, width: number, height: number, z: number, trimTransparentPadding = false): THREE.Mesh {
  const map = textureLoader.load(url, texture => {
    if (texture.userData.disposed) return;
    if (!trimTransparentPadding) return;
    // Change UV sampling, not source pixels: the upright covers contain transparent margins.
    const source = texture.image as HTMLImageElement;
    const probe = document.createElement('canvas');
    probe.width = source.naturalWidth; probe.height = source.naturalHeight;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    let left = probe.width, right = -1, top = probe.height, bottom = -1;
    for (let y = 0; y < probe.height; y++) for (let x = 0; x < probe.width; x++) {
      if (data[(y * probe.width + x) * 4 + 3] < 128) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    if (right < left || bottom < top) return;
    texture.offset.set(left / probe.width, (probe.height - bottom - 1) / probe.height);
    texture.repeat.set((right - left + 1) / probe.width, (bottom - top + 1) / probe.height);
    texture.needsUpdate = true;
  });
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.04, side: THREE.DoubleSide }),
  );
  plane.position.z = z;
  return plane;
}

function canvasFace(canvas: HTMLCanvasElement, width: number, height: number, z: number): THREE.Mesh {
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide }),
  );
  plane.position.z = z;
  return plane;
}

function notebookCoverFace(width: number, height: number, z: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#e6d071');
  gradient.addColorStop(1, '#cbb653');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#a1412d';
  ctx.fillRect(0, 0, 24, canvas.height);
  ctx.fillStyle = '#303126';
  ctx.textAlign = 'center';
  ctx.font = '700 40px "Microsoft YaHei", sans-serif';
  ctx.fillText('机统—142', 590, 175);
  ctx.font = '700 92px "Microsoft YaHei", sans-serif';
  ctx.fillText('司 机 手 账', 384, 380);
  ctx.font = '600 34px "Microsoft YaHei", sans-serif';
  ctx.fillText('中国铁路广州局集团有限公司', 384, 690);
  ctx.fillText('机车______型______号', 384, 825);
  ctx.fillText('______车间______队别', 384, 910);
  ctx.fillText('______机班', 384, 995);
  return canvasFace(canvas, width, height, z);
}

function notebookPageFace(side: 'left' | 'right', width: number, height: number, z: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.fillStyle = '#f6f1dc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#39896b';
  ctx.lineWidth = 3;
  for (let y = 92; y < 980; y += 58) {
    ctx.beginPath(); ctx.moveTo(24, y); ctx.lineTo(696, y); ctx.stroke();
  }
  for (let x = 24; x <= 696; x += 112) {
    ctx.beginPath(); ctx.moveTo(x, 92); ctx.lineTo(x, 980); ctx.stroke();
  }
  ctx.fillStyle = '#276d56';
  ctx.textAlign = 'center';
  ctx.font = '700 34px "Microsoft YaHei", sans-serif';
  ctx.fillText(side === 'left' ? '出乘预想、退乘总结及重要记事' : '运行记录', 360, 62);
  if (side === 'left') {
    ctx.fillStyle = '#3c4d46';
    ctx.textAlign = 'left';
    ctx.font = '30px "KaiTi", "Microsoft YaHei", sans-serif';
    ctx.fillText('天气：　线路：　重点区段：', 42, 150);
    ctx.fillText('预想内容：', 42, 266);
  }
  return canvasFace(canvas, width, height, z);
}

function createRecorder(): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.088, 0.205, 0.024, 3, 0.008), material(0x111413, 0.54));
  group.add(body, imageFace(asset('props/recorder.png'), 0.084, 0.198, 0.013));
  return group;
}

function createNotebook(): THREE.Group {
  const group = new THREE.Group();
  const cover = new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.39, 0.018, 3, 0.007), material(0xd1b95a, 0.72));
  group.add(cover, notebookCoverFace(0.255, 0.375, 0.010));
  return group;
}

function createOpenNotebook(): THREE.Group {
  const group = new THREE.Group();
  const binding = new THREE.Mesh(new RoundedBoxGeometry(0.025, 0.39, 0.032, 2, 0.008), material(0xa33d2f, 0.72));
  group.add(binding);
  (['left', 'right'] as const).forEach((side) => {
    const direction = side === 'left' ? -1 : 1;
    const page = new THREE.Group();
    const backing = new THREE.Mesh(new RoundedBoxGeometry(0.265, 0.39, 0.018, 2, 0.007), material(0xefe8ce, 0.9));
    page.add(backing, notebookPageFace(side, 0.254, 0.376, 0.011));
    page.position.x = direction * 0.14;
    page.rotation.y = direction * -0.08;
    group.add(page);
  });
  group.rotation.x = -0.05;
  return group;
}

function createIcCard(): THREE.Group {
  const group = new THREE.Group();
  const sleeve = new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.19, 0.025, 3, 0.018), material(0x26343b, 0.52));
  group.add(sleeve, imageFace(asset('props/ic-card.png'), 0.285, 0.197, 0.015));
  return group;
}

function createReveal(): THREE.Group {
  const group = new THREE.Group();
  const paper = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.325, 0.008), material(0xf7f4e9, 0.9));
  const paperCanvas=document.createElement('canvas');
  paperCanvas.width=revealPaperSize.imageWidth; paperCanvas.height=revealPaperSize.imageHeight;
  drawPaperReveal(paperCanvas.getContext('2d')!);
  const print = canvasFace(paperCanvas, 0.45, 0.316, 0.005);
  paper.name = '交付揭示纸面';
  print.name = '交付揭示印刷内容';
  (print.material as THREE.MeshBasicMaterial).toneMapped = false;
  const paperMap = (print.material as THREE.MeshBasicMaterial).map;
  if (paperMap) paperMap.anisotropy = 8;
  print.position.z = 0.005;
  group.add(paper, print);
  revealPaperRows.forEach((row, index) => {
    const underline = new THREE.Mesh(
      new THREE.PlaneGeometry(row.width / revealPaperSize.imageWidth * revealPaperSize.width, 0.0014),
      new THREE.MeshBasicMaterial({ color: 0xb02f2a, side: THREE.DoubleSide, toneMapped: false }),
    );
    underline.name = `纸质揭示下划线-${index}`;
    underline.position.set(
      ((row.x + row.width / 2) / revealPaperSize.imageWidth - 0.5) * revealPaperSize.width,
      (0.5 - row.underlineY / revealPaperSize.imageHeight) * revealPaperSize.height,
      0.006,
    );
    underline.visible = false;
    group.add(underline);
  });
  return group;
}

function createDocumentStack(): THREE.Group {
  const group = new THREE.Group();
  const colors = [0x395d87, 0x6f1f24, 0x54366b];
  colors.forEach((color, index) => {
    const book = new THREE.Mesh(new RoundedBoxGeometry(0.25, 0.34, 0.025, 2, 0.006), material(color, 0.66));
    book.position.set(index * 0.018, index * 0.012, index * 0.025);
    book.rotation.z = (index - 1) * 0.045;
    group.add(book);
  });
  return group;
}

function createDocumentFan(): THREE.Group {
  const group = new THREE.Group();
  group.name = '规章证件扇形组';
  const covers = [
    { file: 'certificate-work.png', width: 0.14, height: 0.20, x: -0.38, y: 0.00, rotation: 0.24 },
    { file: 'certificate-driver.png', width: 0.15, height: 0.21, x: -0.28, y: 0.05, rotation: 0.16 },
    { file: 'certificate-training.png', width: 0.16, height: 0.22, x: -0.17, y: 0.09, rotation: 0.08 },
    { file: 'book-technical-rules.png', width: 0.23, height: 0.32, x: -0.04, y: 0.12, rotation: 0.0 },
    { file: 'book-locomotive-operation.png', width: 0.23, height: 0.32, x: 0.13, y: 0.09, rotation: -0.10 },
    { file: 'book-operation-organization.png', width: 0.23, height: 0.32, x: 0.30, y: 0.02, rotation: -0.21 },
  ];
  covers.forEach((cover, index) => {
    const card = new THREE.Group();
    card.name = `规章证件-${index + 1}`;
    const coverColor = [0x6f242e, 0x242825, 0x794994, 0x184b86, 0x527ab3, 0x446c80][index];
    const backing = new THREE.Mesh(new RoundedBoxGeometry(cover.width, cover.height, 0.004, 2, 0.001), material(coverColor, 0.72));
    card.add(backing, imageFace(asset(`documents/upright/${cover.file}`), cover.width, cover.height, 0.0025, true));
    card.position.set(index * 0.004, index * 0.003, -index * 0.006);
    card.userData.fanIndex = index;
    card.userData.closedPosition = card.position.clone();
    card.userData.openPosition = new THREE.Vector3(cover.x, cover.y, index * 0.008);
    card.userData.closedRotationZ = 0;
    card.userData.openRotationZ = cover.rotation;
    group.add(card);
  });
  return group;
}

function createBackpack(): THREE.Group {
  const group = new THREE.Group();
  const bag = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.4, 0.17, 4, 0.055), material(0x263a32, 0.82));
  const pocket = new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.17, 0.06, 3, 0.025), material(0x314c40, 0.84));
  pocket.position.set(0, -0.075, 0.105);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.013, 8, 20, Math.PI), material(0x1c2924, 0.88));
  handle.rotation.z = Math.PI;
  handle.position.y = 0.22;
  group.add(bag, pocket, handle);
  return group;
}

function createFallbackFpsHand(
  side: 'left' | 'right',
  id: InventoryItemId,
  variant: HeldItemVariant,
): THREE.Group {
  const hand = new THREE.Group();
  const mirror = side === 'left' ? -1 : 1;
  const skinMaterial = material(0xc79270, 0.72);
  // Restore the 2026-08-30 release hand's palm placement and diagonal arm silhouette.
  // A continuous tapered surface replaces the visible cuff and separate joint balls.
  const surface = (points: number[][], radius: (t: number) => number, name: string) => {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x * mirror, y, z)));
    const geometry = new THREE.TubeGeometry(curve, 32, 1, 24, false);
    const positions = geometry.getAttribute('position');
    const vertex = new THREE.Vector3();
    for (let ring = 0; ring <= 32; ring += 1) {
      const t = ring / 32;
      const center = curve.getPointAt(t);
      for (let radial = 0; radial <= 24; radial += 1) {
        const index = ring * 25 + radial;
        vertex.fromBufferAttribute(positions, index).sub(center).multiplyScalar(radius(t)).add(center);
        positions.setXYZ(index, vertex.x, vertex.y, vertex.z);
      }
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, skinMaterial);
    mesh.name = name;
    hand.add(mesh);
    return mesh;
  };
  surface([[0.37, -0.40, 0.12], [0.22, -0.20, 0.09], [0.105, -0.095, 0.06], [0.070, -0.057, 0.045]],
    t => THREE.MathUtils.lerp(0.058, 0.037, t), '原版裸露前臂与腕部');
  const palm = new THREE.Mesh(new RoundedBoxGeometry(0.115, 0.145, 0.06, 6, 0.025), skinMaterial);
  palm.position.set(mirror * 0.055, -0.015, 0.045);
  palm.rotation.z = mirror * -0.18;
  hand.add(palm);
  for (let index = 0; index < 4; index += 1) {
    const x = 0.012 + index * 0.024;
    const baseY = 0.031 - index * 0.006;
    const length = [0.077, 0.087, 0.081, 0.065][index];
    // Roots extend inside the palm; each finger is one smooth, rounded surface.
    surface([[x, baseY, 0.042], [x - 0.002, baseY + length * 0.38, 0.039],
      [x - 0.006, baseY + length * 0.78, 0.027], [x - 0.008, baseY + length, 0.013]],
    t => (0.014 - 0.0025 * t) * (t > 0.78 ? Math.sqrt(Math.max(0.001, 1 - ((t - 0.78) / 0.22) ** 2)) : 1),
    `原版手指-${index + 1}`);
  }
  surface([[0.040, -0.025, 0.048], [0.014, -0.005, 0.067], [-0.004, 0.020, 0.072], [-0.009, 0.037, 0.061]],
    t => (0.025 - 0.013 * t) * (t > 0.8 ? Math.sqrt(Math.max(0.001, 1 - ((t - 0.8) / 0.2) ** 2)) : 1), '拇指与掌根连续过渡');
  hand.userData.handBaseline = 'release-current/2026-08-30-15:07';
  return hand;
}

function addFallbackFpsHands(group: THREE.Group, id: InventoryItemId, variant: HeldItemVariant = 'default'): void {
  const right = createRefinedFpsHand(id);
  right.name = '右手握持';
  const grip: Record<InventoryItemId, { position: [number, number, number]; rotation: number; scale: number }> = {
    recorder: { position: [0.056, 0.014, 0.008], rotation: -0.12, scale: 1.04 },
    notebook: { position: [0.105, -0.17, 0.02], rotation: -0.28, scale: 1.0 },
    'ic-card': { position: [0.015, 0.022, 0.02], rotation: -0.3, scale: 0.72 },
    'delivery-reveal': { position: [0.19, -0.19, 0.015], rotation: -0.32, scale: 1.0 },
    documents: { position: [0.15, -0.18, 0.015], rotation: -0.28, scale: 0.86 },
    backpack: { position: [0.15, -0.2, 0.02], rotation: -0.3, scale: 0.9 },
  };
  const pose = grip[id];
  right.position.set(...pose.position);
  right.rotation.z = pose.rotation;
  right.scale.setScalar(pose.scale);
  right.userData.restPosition = right.position.clone();
  right.userData.restRotationZ = right.rotation.z;
  group.add(right);
  if (id === 'notebook' && variant === 'active') {
    right.position.set(0.245, -0.19, 0.02);
    right.rotation.z = -0.28;
    right.scale.setScalar(0.78);
    right.userData.restPosition = right.position.clone();
    right.userData.restRotationZ = right.rotation.z;
  }
}

async function loadFpsHandTemplate(): Promise<THREE.Group> {
  fpsHandTemplatePromise ??= gltfLoader.loadAsync(fpsHandUrl).then((gltf) => {
    const template = gltf.scene;
    const skin = new THREE.MeshStandardMaterial({
      color: 0xc58e6d,
      roughness: 0.72,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    template.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        if (!object.geometry.getAttribute('normal')) object.geometry.computeVertexNormals();
        object.geometry.computeBoundingSphere();
        object.material = skin;
        object.castShadow = false;
        object.receiveShadow = false;
        object.frustumCulled = false;
      }
    });
    template.name = '骨骼右手模板';
    return template;
  });
  return fpsHandTemplatePromise;
}

type RiggedHandSide = 'left' | 'right';

function configureFingerGrip(
  hand: THREE.Object3D,
  id: InventoryItemId,
  variant: HeldItemVariant,
  side: RiggedHandSide,
): void {
  const grip = id === 'recorder' ? 0.94
    : id === 'ic-card' ? 0.58
      : id === 'notebook' && variant === 'active' ? 0.08
        : id === 'delivery-reveal' ? 0.54
          : id === 'documents' ? 0.62
            : 0.7;
  const fingerFactors: Record<string, number> = {
    Index: id === 'ic-card' ? 0.32 : 0.82,
    Middle: 1,
    Ring: 1.08,
    Pinky: 1.14,
  };
  const lateralDirection = side === 'left' || id === 'recorder' || id === 'ic-card' ? -1 : 1;
  const lateralAmount = id === 'notebook' && variant === 'active' ? 0 : 1;
  for (const [finger, factor] of Object.entries(fingerFactors)) {
    const prox = hand.getObjectByName(`${finger}_Prox`);
    const inter = hand.getObjectByName(`${finger}_Inter`);
    const dist = hand.getObjectByName(`${finger}_Dist`);
    if (prox) prox.rotation.x += grip * factor * 0.62;
    if (inter) inter.rotation.x += grip * factor * 0.78;
    if (dist) dist.rotation.x += grip * factor * 0.5;
    if (prox) prox.rotation.z += lateralDirection * lateralAmount * grip * factor * 0.28;
    if (inter) inter.rotation.z += lateralDirection * lateralAmount * grip * factor * 0.36;
    if (dist) dist.rotation.z += lateralDirection * lateralAmount * grip * factor * 0.2;
  }
  const thumbMeta = hand.getObjectByName('Thumb_Meta');
  const thumbProx = hand.getObjectByName('Thumb_Prox');
  const thumbDist = hand.getObjectByName('Thumb_Dist');
  if (thumbMeta) thumbMeta.rotation.z -= id === 'ic-card' ? 0.32 : 0.48;
  if (thumbProx) thumbProx.rotation.x += id === 'recorder' ? 0.14 : 0.34;
  if (thumbDist) thumbDist.rotation.x += id === 'recorder' ? 0.08 : 0.24;
  hand.traverse((object) => {
    if (!(object instanceof THREE.Bone)) return;
    object.userData.gripQuaternion = object.quaternion.clone();
  });
}

async function createRiggedFpsHand(
  side: RiggedHandSide,
  id: InventoryItemId,
  variant: HeldItemVariant,
): Promise<THREE.Group> {
  const template = await loadFpsHandTemplate();
  const cloned = cloneSkeleton(template) as THREE.Group;
  cloned.scale.setScalar(0.001);
  cloned.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(cloned);
  const center = bounds.getCenter(new THREE.Vector3());
  cloned.position.sub(center);

  const mirrorRoot = new THREE.Group();
  mirrorRoot.name = side === 'right' ? '右手骨骼模型' : '镜像左手骨骼模型';
  mirrorRoot.scale.x = side === 'left' ? -1 : 1;
  mirrorRoot.add(cloned);

  const hand = new THREE.Group();
  hand.name = side === 'right' ? '右手握持' : '左手辅助';
  hand.userData.riggedFpsHand = true;
  hand.add(mirrorRoot);
  configureFingerGrip(hand, id, variant, side);

  const openNotebook = id === 'notebook' && variant === 'active';
  const positions: Record<InventoryItemId, [number, number, number]> = {
    recorder: [0.315, -0.075, 0.032],
    notebook: [0.285, 0.015, 0.026],
    'ic-card': [0.35, -0.075, 0.032],
    'delivery-reveal': [0.30, 0.0, 0.022],
    documents: [0.29, 0.0, 0.022],
    backpack: [0.24, -0.04, 0.018],
  };
  const [x, y, z] = positions[id];
  hand.position.set(side === 'left' ? -Math.abs(x) : Math.abs(x), y, z);
  if (openNotebook) hand.position.set(side === 'left' ? -0.46 : 0.46, 0.015, 0.07);
  hand.rotation.set(
    0.04,
    side === 'left' ? -0.12 : 0.12,
    side === 'left' ? 0.08 : -0.08,
  );
  hand.scale.setScalar(openNotebook ? 0.78 : id === 'recorder' ? 0.9 : 0.84);
  hand.userData.restPosition = hand.position.clone();
  hand.userData.restQuaternion = hand.quaternion.clone();
  hand.userData.restRotationZ = hand.rotation.z;
  return hand;
}

async function addFpsHands(group: THREE.Group, id: InventoryItemId, variant: HeldItemVariant = 'default'): Promise<void> {
  // Factories also provide a synchronous fallback: remove it before replacement
  // so a scanned forearm is never drawn on top of a second procedural arm.
  const previous = group.getObjectByName('右手握持');
  if (previous) disposeOwnedObject(previous);
  if (new URLSearchParams(window.location.search).get('hand') !== 'procedural') {
    try {
      group.add(await createUploadedFpsHand(id, variant));
      group.userData.handSource = 'uploaded-hand-20260831';
      return;
    } catch (error) {
      console.warn('上传手模加载失败，保留备用手部。', error);
    }
  }
  addFallbackFpsHands(group, id, variant);
  group.userData.handSource = 'optimized-original-procedural-fps-hand';
}

export function createHeldItem(id: InventoryItemId, withFallbackHand = true): THREE.Group {
  const factories: Record<InventoryItemId, () => THREE.Group> = {
    recorder: createRecorder,
    notebook: createNotebook,
    'ic-card': createIcCard,
    'delivery-reveal': createReveal,
    documents: createDocumentStack,
    backpack: createBackpack,
  };
  const group = factories[id]();
  if (withFallbackHand) addFallbackFpsHands(group, id);
  group.name = `held-${id}`;
  group.position.set(0.22, 0.08, -1.15);
  group.rotation.set(-0.18, -0.28, -0.08);
  group.scale.setScalar(id === 'delivery-reveal' ? 1.05 : 0.9);
  group.userData.itemId = id;
  return group;
}

function prepareImportedHeldModel(model: THREE.Object3D, id: InventoryItemId, config: HeldModelConfig): THREE.Group {
  const oriented = new THREE.Group();
  oriented.add(model);
  if (config.rotation) model.rotation.set(...config.rotation);
  oriented.updateMatrixWorld(true);
  const before = new THREE.Box3().setFromObject(oriented);
  const size = before.getSize(new THREE.Vector3());
  const scale = config.targetHeight / Math.max(size.y, 0.001);
  model.scale.setScalar(scale);
  oriented.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(oriented);
  const center = after.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.y -= center.y;
  model.position.z -= center.z;
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = false;
    object.receiveShadow = false;
    object.frustumCulled = true;
  });
  oriented.name = `imported-${id}`;
  return oriented;
}

export async function loadHeldItem(id: InventoryItemId, variant: HeldItemVariant = 'default'): Promise<THREE.Group> {
  if (id === 'notebook' && variant === 'active') {
    // The supplied "open notebook" scan is actually a purple training certificate.
    // Use an accurate two-page driver-notebook reconstruction for the opened state.
    const group = createOpenNotebook();
    await addFpsHands(group, id, variant);
    group.name = `held-${id}`;
    group.position.set(0, -0.25, -1.02);
    group.rotation.set(-0.05, 0, 0);
    group.scale.setScalar(0.9);
    group.userData.restPosition = group.position.clone();
    group.userData.restScale = group.scale.x;
    group.userData.itemId = id;
    group.userData.variant = variant;
    group.userData.source = 'procedural-open-driver-notebook';
    return group;
  }
  const config = variant === 'active' ? activeHeldModelConfigs[id] ?? heldModelConfigs[id] : heldModelConfigs[id];
  if (!config) {
    const group = createHeldItem(id, false);
    await addFpsHands(group, id, variant);
    return group;
  }
  try {
    const gltf = await gltfLoader.loadAsync(config.url);
    const group = prepareImportedHeldModel(gltf.scene, id, config);
    if (id === 'ic-card') {
      group.updateMatrixWorld(true);
      const cardBounds = new THREE.Box3().setFromObject(group);
      const cardSize = cardBounds.getSize(new THREE.Vector3());
      // Scan the actual leading-edge vertices: the green PCB is offset relative
      // to the thick black handle, so the whole-object depth centre is not its centre.
      const leadingEdge = new THREE.Box3();
      const vertex = new THREE.Vector3();
      group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const positions = object.geometry.getAttribute('position');
        if (!positions) return;
        for (let i = 0; i < positions.count; i++) {
          vertex.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
          if (vertex.y <= cardBounds.min.y + cardSize.y * 0.02) leadingEdge.expandByPoint(vertex);
        }
      });
      const leadingCenter = leadingEdge.isEmpty() ? new THREE.Vector3(0, cardBounds.min.y, 0)
        : leadingEdge.getCenter(new THREE.Vector3());
      leadingCenter.y = cardBounds.min.y;
      const cardModel = group.children[0];
      const gripPivot = new THREE.Group();
      gripPivot.name = 'IC卡黑色握持端';
      gripPivot.position.set(0, 0.065, 0);
      group.remove(cardModel);
      cardModel.position.y -= gripPivot.position.y;
      gripPivot.add(cardModel);
      // Green is -Y in the scan. Aim it toward -Z with the printed/contact face upward.
      gripPivot.rotation.set(-1.16, 0, Math.PI);
      group.add(gripPivot);
      group.userData.insertionDirection = [0, 0, -1];
      group.userData.cardInsertion = {
        width: cardSize.x,
        // Capture the green leading edge in held-group coordinates, before the FPS pose.
        tip: leadingCenter.clone().sub(new THREE.Vector3(0, 0.065, 0))
          .applyQuaternion(gripPivot.quaternion).add(gripPivot.position),
        pivotQuaternion: gripPivot.quaternion.clone(),
        greenLength: cardSize.y * 0.45,
      };
    }
    if (id === 'documents') {
      const importedDocument = group.children[0];
      if (importedDocument) importedDocument.userData.documentBase = true;
      const documentFan = createDocumentFan();
      documentFan.position.set(-0.04, -0.02, 0.01);
      group.add(documentFan);
    }
    if (id === 'notebook' && variant === 'default') {
      // The scan is only ~0.0163 deep after normalization. Keep the print on its
      // front cover, not floating 18 mm forward into the fingers.
      const coverOverlay = notebookCoverFace(0.255, 0.375, 0.010);
      coverOverlay.name = '司机手账高清封面';
      group.add(coverOverlay);
    }
    if (id === 'recorder') {
      const actionButton = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 6), material(0xb92d2d, 0.48));
      actionButton.name = '录音按键';
      actionButton.position.set(0, 0.025, 0.022);
      actionButton.userData.restZ = actionButton.position.z;
      group.add(actionButton);
    }
    await addFpsHands(group, id, variant);
    group.name = `held-${id}`;
    if (id === 'ic-card') {
      group.position.set(0.25, -0.17, -0.88);
      group.rotation.set(-0.08, -0.12, -0.04);
    } else {
      group.position.set(id === 'delivery-reveal' ? 0.38 : 0.32, id === 'delivery-reveal' ? -0.22 : -0.29, -1.08);
      group.rotation.set(-0.13, -0.2, id === 'delivery-reveal' ? 0.03 : -0.04);
    }
    const viewScale: Partial<Record<InventoryItemId, number>> = {
      recorder: 0.68,
      notebook: 0.74,
      'ic-card': 0.92,
      'delivery-reveal': 0.84,
      documents: 0.7,
    };
    group.scale.setScalar(viewScale[id] ?? 0.72);
    group.userData.restPosition = group.position.clone();
    group.userData.restScale = group.scale.x;
    if (id === 'documents') {
      group.userData.openPosition = new THREE.Vector3(0.02, -0.045, -0.74);
      group.userData.openScale = 0.94;
    }
    group.userData.itemId = id;
    group.userData.variant = variant;
    group.userData.source = config.url;
    return group;
  } catch (error) {
    console.warn(`手持物品 ${id} 的轻量GLB加载失败，改用程序化备用模型。`, error);
    const fallback = id === 'notebook' && variant === 'active' ? createOpenNotebook() : createHeldItem(id, false);
    if (id === 'notebook' && variant === 'active') {
      addFallbackFpsHands(fallback, id, variant);
      fallback.name = `held-${id}`;
      fallback.position.set(0.32, -0.29, -1.08);
      fallback.rotation.set(-0.13, -0.2, -0.04);
      fallback.scale.setScalar(0.74);
      fallback.userData.itemId = id;
      fallback.userData.variant = variant;
    }
    await addFpsHands(fallback, id, variant);
    return fallback;
  }
}

function applyRiggedHandAction(group: THREE.Group, id: InventoryItemId, progress: number): void {
  const hand = group.getObjectByName('右手握持');
  if (!hand?.userData.riggedFpsHand) return;
  hand.traverse((object) => {
    if (!(object instanceof THREE.Bone)) return;
    const base = object.userData.gripQuaternion as THREE.Quaternion | undefined;
    if (base) object.quaternion.copy(base);
  });
  if (id === 'recorder') {
    const thumbProx = hand.getObjectByName('Thumb_Prox');
    const thumbDist = hand.getObjectByName('Thumb_Dist');
    if (thumbProx) thumbProx.rotateX(progress * 0.22);
    if (thumbDist) thumbDist.rotateX(progress * 0.16);
  } else if (id === 'ic-card') {
    const indexProx = hand.getObjectByName('Index_Prox');
    const thumbProx = hand.getObjectByName('Thumb_Prox');
    if (indexProx) indexProx.rotateX(progress * 0.1);
    if (thumbProx) thumbProx.rotateX(progress * 0.1);
  }
}

export function setHeldItemActionPose(group: THREE.Group, id: InventoryItemId, progress: number): void {
  const eased = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(progress, 0, 1), 0, 1);
  applyRiggedHandAction(group, id, eased);
  if (id === 'documents') {
    const restPosition = group.userData.restPosition as THREE.Vector3 | undefined;
    const openPosition = group.userData.openPosition as THREE.Vector3 | undefined;
    if (restPosition && openPosition) group.position.lerpVectors(restPosition, openPosition, eased);
    const restScale = Number(group.userData.restScale ?? 0.7);
    const openScale = Number(group.userData.openScale ?? 1.08);
    group.scale.setScalar(THREE.MathUtils.lerp(restScale, openScale, eased));
    group.traverse((object) => {
      if (object.userData.documentBase) object.visible = eased < 0.15;
      if (typeof object.userData.fanIndex !== 'number') return;
      object.visible = eased > 0.025;
      const closed = object.userData.closedPosition as THREE.Vector3;
      const open = object.userData.openPosition as THREE.Vector3;
      object.position.lerpVectors(closed, open, eased);
      object.rotation.z = THREE.MathUtils.lerp(Number(object.userData.closedRotationZ), Number(object.userData.openRotationZ), eased);
    });
    const hand = group.getObjectByName('右手握持');
    if (hand) {
      const rest = hand.userData.restPosition as THREE.Vector3;
      hand.position.lerpVectors(rest, new THREE.Vector3(0.04, -0.30, 0.055), eased);
    }
  }
  if (id === 'recorder') {
    const button = group.getObjectByName('录音按键');
    if (button) button.position.z = Number(button.userData.restZ ?? 0.035) - eased * 0.014;
    const hand = group.getObjectByName('右手握持');
    if (hand) {
      const rest = hand.userData.restPosition as THREE.Vector3;
      hand.position.copy(rest);
      hand.rotation.z = Number(hand.userData.restRotationZ ?? -0.08);
    }
  }
}

export function markDeliveryRevealPaperLine(group: THREE.Group, index: number): void {
  const underline = group.getObjectByName(`纸质揭示下划线-${index}`);
  if (underline) underline.visible = true;
}

export function syncDeliveryRevealPaperMarks(group: THREE.Group, marks: readonly number[]): void {
  revealPaperRows.forEach((_, index) => {
    const underline = group.getObjectByName(`纸质揭示下划线-${index}`);
    if (underline) underline.visible = marks.includes(index);
  });
}

export function setDeliveryRevealViewPose(group: THREE.Group, closeProgress: number, hideProgress: number): void {
  const close = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(closeProgress, 0, 1), 0, 1);
  const hide = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(hideProgress, 0, 1), 0, 1);
  const restPosition = group.userData.revealRestPosition as THREE.Vector3 | undefined
    ?? (group.userData.revealRestPosition = group.position.clone());
  const restQuaternion = group.userData.revealRestQuaternion as THREE.Quaternion | undefined
    ?? (group.userData.revealRestQuaternion = group.quaternion.clone());
  const restScale = Number(group.userData.revealRestScale ?? (group.userData.revealRestScale = group.scale.x));
  const closePosition = new THREE.Vector3(0.08, -0.035, -0.62);
  const hiddenPosition = new THREE.Vector3(1.55, -0.16, -0.88);
  const closeQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.015, -0.025, 0.015));

  group.position.lerpVectors(restPosition, closePosition, close);
  group.quaternion.slerpQuaternions(restQuaternion, closeQuaternion, close);
  group.scale.setScalar(THREE.MathUtils.lerp(restScale, 1.22, close));
  if (hide > 0) {
    group.position.lerp(hiddenPosition, hide);
    group.scale.setScalar(THREE.MathUtils.lerp(group.scale.x, restScale * 0.88, hide));
  }
  group.visible = hide < 0.985;
}

export function setNotebookInspectionPose(group: THREE.Group, progress: number): void {
  const close = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(progress, 0, 1), 0, 1);
  const restPosition = group.userData.notebookRestPosition as THREE.Vector3 | undefined
    ?? (group.userData.notebookRestPosition = group.position.clone());
  const restQuaternion = group.userData.notebookRestQuaternion as THREE.Quaternion | undefined
    ?? (group.userData.notebookRestQuaternion = group.quaternion.clone());
  const restScale = Number(group.userData.notebookRestScale ?? (group.userData.notebookRestScale = group.scale.x));
  const closePosition = new THREE.Vector3(0.01, -0.055, -0.69);
  const closeQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.02, -0.015, 0));
  group.position.lerpVectors(restPosition, closePosition, close);
  group.quaternion.slerpQuaternions(restQuaternion, closeQuaternion, close);
  group.scale.setScalar(THREE.MathUtils.lerp(restScale, 1.06, close));
}

export async function loadDispatcherModel(): Promise<THREE.Group> {
  const gltf = await gltfLoader.loadAsync(asset('models/railway-uniform-dispatcher-lite.glb'));
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const scale = 1.60 / Math.max(size.y, 0.001);
  const center = bounds.getCenter(new THREE.Vector3());
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = false;
    object.receiveShadow = false;
    object.frustumCulled = true;
  });
  const root = new THREE.Group();
  root.name = '铁路制服出勤调度员';
  root.userData.interactionLabel = '出勤调度员：开始人人核对';
  root.add(model);
  return root;
}

export function softenKioskGeometry(kiosk: THREE.Object3D): void {
  const radii: Record<string, number> = {
    root: 0.055,
    'upper-shell': 0.05,
    'interface-fascia': 0.022,
    worktop: 0.026,
    'main-screen': 0.022,
    'recognition-bay': 0.018,
    'recognition-arm': 0.012,
    'card-reader': 0.014,
    'top-camera': 0.018,
    keyboard: 0.008,
  };
  kiosk.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const component = object.userData.sculptComponent as { id?: string; dimensions?: { width?: number; height?: number; depth?: number } } | undefined;
    const id = component?.id;
    if (!id || !(id in radii)) return;
    const width = component?.dimensions?.width;
    const height = component?.dimensions?.height;
    const depth = component?.dimensions?.depth;
    if (!width || !height || !depth) return;
    object.geometry.dispose();
    object.geometry = new RoundedBoxGeometry(width, height, depth, 3, Math.min(radii[id], width / 4, height / 4, depth / 4));
  });
}
