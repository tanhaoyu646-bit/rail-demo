import * as THREE from 'three';
import type { HeldItemVariant, InventoryItemId } from './sceneProps';

const asset = (path: string) => `${import.meta.env.BASE_URL}assets/${path}`;

let handTexturePromise: Promise<THREE.Texture> | undefined;

function configure(texture: THREE.Texture): THREE.Texture {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function loadHandTexture(): Promise<THREE.Texture> {
  handTexturePromise ??= new THREE.TextureLoader().loadAsync(asset('hands/right-hand-pinch-reference.png')).then(configure);
  return handTexturePromise;
}

function cropTexture(source: THREE.Texture, x: number, y: number, width: number, height: number): THREE.Texture {
  const image = source.image as HTMLImageElement;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建手部遮挡图层。');
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  return configure(new THREE.CanvasTexture(canvas));
}

function photoPlane(texture: THREE.Texture, width: number, height: number, renderOrder: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.03, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  mesh.renderOrder = renderOrder;
  return mesh;
}

/**
 * Uses the supplied transparent right-hand photograph in two layers. The full hand
 * is drawn behind the held item; a small thumb crop is drawn over it. This keeps
 * the index finger hidden by the object while the thumb visibly pinches its edge.
 */
export async function createPhotoFpsHand(id: InventoryItemId, variant: HeldItemVariant = 'default'): Promise<THREE.Group> {
  const texture = await loadHandTexture();
  const image = texture.image as HTMLImageElement;
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const handWidth = id === 'recorder' ? 0.46 : 0.52;
  const handHeight = handWidth * sourceHeight / sourceWidth;
  const positions: Partial<Record<InventoryItemId, [number, number]>> = {
    recorder: [0.09, -0.16],
    notebook: [0.12, -0.19],
    'ic-card': [0.10, -0.17],
    'delivery-reveal': [0.16, -0.20],
    documents: [0.15, -0.20],
  };
  const [x, y] = positions[id] ?? [0.11, -0.18];
  const hand = new THREE.Group();
  hand.name = '右手握持';
  hand.userData.photoFpsHand = true;

  const behind = photoPlane(texture, handWidth, handHeight, -2);
  behind.name = '右手照片（物品后方）';
  behind.position.set(x, y, -0.055);
  hand.add(behind);

  // Crop only the thumb/pinch pad. It remains in front of the held object;
  // all index-finger pixels stay in the behind layer and are therefore occluded.
  const cropX = Math.round(sourceWidth * 0.16);
  const cropY = Math.round(sourceHeight * 0.055);
  const cropWidth = Math.round(sourceWidth * 0.30);
  const cropHeight = Math.round(sourceHeight * 0.30);
  const thumbTexture = cropTexture(texture, cropX, cropY, cropWidth, cropHeight);
  const thumb = photoPlane(thumbTexture, handWidth * cropWidth / sourceWidth, handHeight * cropHeight / sourceHeight, 2);
  thumb.name = '右手拇指（物品前方）';
  thumb.position.set(
    x + ((cropX + cropWidth / 2) / sourceWidth - 0.5) * handWidth,
    y + (0.5 - (cropY + cropHeight / 2) / sourceHeight) * handHeight,
    0.06,
  );
  hand.add(thumb);
  hand.rotation.z = id === 'ic-card' ? -0.04 : -0.08;
  hand.userData.restPosition = hand.position.clone();
  hand.userData.restQuaternion = hand.quaternion.clone();
  hand.userData.restRotationZ = hand.rotation.z;
  hand.userData.source = 'right-hand-pinch-reference.png';
  hand.userData.variant = variant;
  return hand;
}
