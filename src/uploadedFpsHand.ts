import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { InventoryItemId, HeldItemVariant } from './sceneProps';

// An independent decimated copy; the supplied 1.5M-triangle original is untouched.
export const uploadedHandAsset = 'assets/models/hands/uploaded-hand-20260831.glb';
let templatePromise: Promise<THREE.Group> | undefined;

async function loadTemplate(): Promise<THREE.Group> {
  templatePromise ??= new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}${uploadedHandAsset}`)
    .then(({ scene }) => {
      const unusedMaps = new Set<THREE.Texture>();
      const originalMaterials = new Set<THREE.Material>();
      scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        // The supplied material defaults to metallic=1 and specularColor=2.
        // Skin is dielectric: keep its color/normal maps but avoid a bronze arm
        // under the simulation's hemisphere lighting. Source GLB remains intact.
        const tuneSkin = (original: THREE.Material): THREE.Material => {
          originalMaterials.add(original);
          const material = original.clone();
          if (material instanceof THREE.MeshStandardMaterial) {
            material.metalness = 0;
            material.roughness = 0.78;
            if (material.metalnessMap) unusedMaps.add(material.metalnessMap);
            if (material.roughnessMap) unusedMaps.add(material.roughnessMap);
            // With metalness=0 this packed map cannot change the rendered skin.
            material.metalnessMap = null;
            material.roughnessMap = null;
          }
          if (material instanceof THREE.MeshPhysicalMaterial) {
            material.specularColor.set(0xffffff);
            material.specularIntensity = 0.35;
          }
          return material;
        };
        object.material = Array.isArray(object.material) ? object.material.map(tuneSkin) : tuneSkin(object.material);
        object.castShadow = false;
        object.receiveShadow = false;
        object.frustumCulled = false;
      });
      // Release only maps unused by every tuned material; keep color and normal maps.
      scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          for (const value of Object.values(material)) if(value instanceof THREE.Texture)unusedMaps.delete(value);
      });
      originalMaterials.forEach(material=>material.dispose());
      unusedMaps.forEach(texture=>{texture.dispose();texture.image?.close?.();});
      return scene;
    }).catch(error => {
      templatePromise = undefined;
      throw error;
    });
  return templatePromise;
}

export function preloadUploadedFpsHand(): Promise<void> {
  return loadTemplate().then(() => undefined);
}

// Measured on the accepted work-card view, after target-height normalization.
// Transfer all three contact offsets, not its centre or its bounding-box depth.
export const workCardGripReference = {
  right: 0.113049697150508, bottom: -0.17, front: 0.025,
  position: [0.08, -0.10, 0.005] as const,
  rotationZ: 0.10,
};

export const gripSurfaces = {
  recorder: { right: 0.047575981773816, bottom: -0.1025, front: 0.024 },
  notebook: { right: 0.134149888141821, bottom: -0.195, front: 0.010 },
  'delivery-reveal': { right: 0.23, bottom: -0.1625, front: 0.005 },
  'notebook-open': { right: 0.1325, bottom: -0.195, front: 0.011 },
};

// Recorder scan front-face samples: the upper contact area recedes in depth.
// Align the reference grasp to that measured slope about the thumb contact,
// so its curled index does not emerge through the recessed device face.
export const recorderGripSlope = Math.atan2(0.006971 - 0.024235, 0.01 - (-0.04));
export const recorderGripPivot = new THREE.Vector3(0, -0.04, 0.024235);

export function referenceGripPosition(surface: { right: number; bottom: number; front: number }): THREE.Vector3 {
  const reference = workCardGripReference;
  return new THREE.Vector3(
    reference.position[0] + surface.right - reference.right,
    reference.position[1] + surface.bottom - reference.bottom,
    reference.position[2] + surface.front - reference.front,
  );
}

export function placeUploadedHand(
  source: THREE.Object3D, id: InventoryItemId, variant: HeldItemVariant = 'default',
): THREE.Group {
  // Preserve the source node's glTF transform and all finger geometry. The anchor
  // is the pinch aperture measured in glTF world axes (+Y up, +Z toward the viewer).
  const anchor = new THREE.Vector3(-0.16, 0.77, -0.10);
  const normalized = new THREE.Group();
  const sourceRoot = new THREE.Group();
  sourceRoot.add(source);
  sourceRoot.position.copy(anchor).negate();
  normalized.add(sourceRoot);
  normalized.scale.setScalar(id === 'ic-card' ? 0.48 : 0.60);

  const hand = new THREE.Group();
  hand.name = '右手握持';
  hand.add(normalized);
  const grips: Record<InventoryItemId, [number, number, number]> = {
    recorder: [0, 0, 0], // derived below from the same accepted work-card grip
    notebook: [0, 0, 0],
    'ic-card': [0.018, 0.063, 0.018],
    'delivery-reveal': [0, 0, 0],
    documents: [0.08, -0.10, 0.005],
    backpack: [0.16, 0.08, 0],
  };
  hand.position.set(...grips[id]);
  hand.rotation.z = workCardGripReference.rotationZ;
  if (id === 'recorder' || id === 'notebook' || id === 'delivery-reveal') {
    hand.position.copy(referenceGripPosition(gripSurfaces[id]));
  }
  if (id === 'recorder') {
    const surfaceRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), recorderGripSlope);
    hand.position.sub(recorderGripPivot).applyQuaternion(surfaceRotation).add(recorderGripPivot);
    hand.quaternion.premultiply(surfaceRotation);
  }
  if (id === 'notebook' && variant === 'active') {
    // Same contact offsets in the folded right page's coordinate system.
    const pageRotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-.08);
    hand.position.copy(referenceGripPosition(gripSurfaces['notebook-open']))
      .applyQuaternion(pageRotation).add(new THREE.Vector3(.14,0,0));
    hand.quaternion.premultiply(pageRotation);
  }
  hand.userData.restPosition = hand.position.clone();
  hand.userData.restRotationZ = hand.rotation.z;
  hand.userData.restQuaternion = hand.quaternion.clone();
  hand.userData.handSource = 'uploaded-hand-20260831';
  hand.userData.staticGrip = true;
  hand.userData.gripStyle = ['recorder', 'notebook', 'delivery-reveal'].includes(id)
    ? 'work-card-contact' : 'edge-pinch';
  return hand;
}

export async function createUploadedFpsHand(id: InventoryItemId, variant: HeldItemVariant): Promise<THREE.Group> {
  const template = await loadTemplate();
  const hand = placeUploadedHand(template.clone(true), id, variant);
  hand.userData.sharedResources = true;
  return hand;
}
