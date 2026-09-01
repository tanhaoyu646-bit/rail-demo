import * as THREE from 'three';

export const kioskSlotWidth = 0.15;
export const kioskSlotHeight = 0.018;

// Runtime detail layer: leave the accepted/generated kiosk source intact.
export function createKioskCardSlot(reader: THREE.Mesh): THREE.Group {
  const slot = new THREE.Group();
  slot.name = 'IC卡槽入口';
  const depth = reader.userData.sculptComponent?.dimensions?.depth ?? 0.055;
  slot.position.set(0, 0, depth / 2 + 0.004);
  const black = new THREE.MeshStandardMaterial({ color: 0x101b18, roughness: 0.7 });
  const rim = new THREE.MeshStandardMaterial({ color: 0x738781, metalness: 0.45, roughness: 0.4 });
  const make = (name: string, w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.name = name; mesh.position.set(x, y, z); slot.add(mesh);
  };
  make('卡槽暗部', kioskSlotWidth, kioskSlotHeight, 0.004, 0, 0, 0, black);
  make('上导轨', kioskSlotWidth + 0.014, 0.005, 0.008, 0, kioskSlotHeight / 2 + 0.0025, 0.004, rim);
  make('下导轨', kioskSlotWidth + 0.014, 0.005, 0.008, 0, -kioskSlotHeight / 2 - 0.0025, 0.004, rim);
  make('左导轨', 0.007, kioskSlotHeight, 0.008, -(kioskSlotWidth + 0.007) / 2, 0, 0.004, rim);
  make('右导轨', 0.007, kioskSlotHeight, 0.008, (kioskSlotWidth + 0.007) / 2, 0, 0.004, rim);
  reader.add(slot);
  return slot;
}

export type CardInsertionLayout = { width: number; tip: THREE.Vector3; pivotQuaternion: THREE.Quaternion; greenLength: number };

export function cardDockPose(slot: THREE.Object3D, layout: CardInsertionLayout, tipDistance: number) {
  const slotQuaternion = slot.getWorldQuaternion(new THREE.Quaternion());
  // Local -Y is green; rotate it into the slot's -Z and keep the contact face up (+Y).
  const flatCard = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI));
  const quaternion = slotQuaternion.clone().multiply(flatCard).multiply(layout.pivotQuaternion.clone().invert());
  const scale = (kioskSlotWidth - 0.014) / layout.width;
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(slotQuaternion);
  const position = slot.getWorldPosition(new THREE.Vector3()).addScaledVector(normal, tipDistance)
    .sub(layout.tip.clone().multiplyScalar(scale).applyQuaternion(quaternion));
  return { position, quaternion, scale };
}

type InsertionMotion = {
  item: THREE.Group; elapsed: number; resolve: (ok: boolean) => void;
  startPosition: THREE.Vector3; startQuaternion: THREE.Quaternion; startScale: number;
  aligned: ReturnType<typeof cardDockPose>; docked: ReturnType<typeof cardDockPose>;
  restPosition: THREE.Vector3; restQuaternion: THREE.Quaternion; restScale: THREE.Vector3;
};

export class KioskCardInsertion {
  private motion: InsertionMotion | null = null;
  private mounted: InsertionMotion | null = null;
  constructor(readonly slot: THREE.Group, private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera, private readonly viewRoot: THREE.Group) {}

  get busy(): boolean { return !!this.motion; }
  get hasCard(): boolean { return !!this.mounted; }

  insert(item: THREE.Group): Promise<boolean> {
    const layout = item.userData.cardInsertion as CardInsertionLayout | undefined;
    if (!layout || this.motion || this.mounted) return Promise.resolve(false);
    const restPosition = item.position.clone();
    const restQuaternion = item.quaternion.clone();
    const restScale = item.scale.clone();
    // A short, clear view of the physical slot. This is not a screen overlay.
    const slotPosition = this.slot.getWorldPosition(new THREE.Vector3());
    const slotQuaternion = this.slot.getWorldQuaternion(new THREE.Quaternion());
    this.camera.position.copy(slotPosition).add(new THREE.Vector3(0, 0.19, 0.62).applyQuaternion(slotQuaternion));
    this.camera.lookAt(slotPosition);
    this.camera.updateMatrixWorld(true);
    // The FPS prop sits at 0.88 m, farther than this close-up's slot. Transfer it
    // to the camera side of the cabinet, preserving its apparent size, before alignment.
    const handoffScale = 0.36 / Math.max(0.01, Math.abs(item.position.z));
    item.position.multiplyScalar(handoffScale);
    item.scale.multiplyScalar(handoffScale);
    item.updateMatrix();
    // Both cameras have the same FOV. Transfer the held pose into the world for real occlusion.
    const world = new THREE.Matrix4().multiplyMatrices(this.camera.matrixWorld, item.matrix);
    this.scene.add(item);
    world.decompose(item.position, item.quaternion, item.scale);
    const aligned = cardDockPose(this.slot, layout, 0.065);
    const docked = cardDockPose(this.slot, layout, -layout.greenLength * aligned.scale);
    return new Promise(resolve => {
      this.motion = { item, elapsed: 0, resolve, startPosition: item.position.clone(),
        startQuaternion: item.quaternion.clone(), startScale: item.scale.x,
        aligned, docked, restPosition, restQuaternion, restScale };
    });
  }

  update(delta: number): boolean {
    const motion = this.motion;
    if (!motion) return false;
    motion.elapsed += delta;
    const { item, aligned, docked } = motion;
    if (motion.elapsed < 0.8) {
      const t = THREE.MathUtils.smoothstep(motion.elapsed / 0.8, 0, 1);
      item.position.lerpVectors(motion.startPosition, aligned.position, t);
      item.quaternion.slerpQuaternions(motion.startQuaternion, aligned.quaternion, t);
      item.scale.setScalar(THREE.MathUtils.lerp(motion.startScale, aligned.scale, t));
    } else {
      const t = THREE.MathUtils.smoothstep((motion.elapsed - 0.95) / 0.9, 0, 1);
      item.position.lerpVectors(aligned.position, docked.position, t);
      item.quaternion.copy(docked.quaternion); item.scale.setScalar(docked.scale);
    }
    if (motion.elapsed < 2.15) return false;
    const hand = item.getObjectByName('右手握持');
    if (hand) hand.visible = false;
    this.mounted = motion; this.motion = null;
    motion.resolve(true);
    return true;
  }

  cancel(): void {
    if (!this.motion) return;
    const motion = this.motion; this.motion = null;
    this.restore(motion); motion.resolve(false);
  }

  takeBack(): THREE.Group | null {
    if (!this.mounted) return null;
    const mounted = this.mounted; this.mounted = null;
    // Inventory loading owns the new held instance; remove the world-mounted copy.
    mounted.item.removeFromParent();
    return mounted.item;
  }

  private restore(motion: InsertionMotion): void {
    this.viewRoot.add(motion.item);
    motion.item.position.copy(motion.restPosition);
    motion.item.quaternion.copy(motion.restQuaternion);
    motion.item.scale.copy(motion.restScale);
  }
}
