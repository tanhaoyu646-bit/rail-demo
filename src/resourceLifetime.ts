import * as THREE from 'three';

/** Dispose an instance's owned resources, never a cached/shared hand template. */
export function disposeOwnedObject(root: THREE.Object3D): void {
  root.removeFromParent();
  if (root.userData.resourcesDisposed) return;
  root.userData.resourcesDisposed = true;
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<{ close?: () => void }>();
  const visit = (object: THREE.Object3D): void => {
    if (object.userData.sharedResources) return;
    if (object instanceof THREE.Mesh) {
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    }
    object.children.forEach(visit);
  };
  visit(root);
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.userData.disposed = true;
    if (texture.image) images.add(texture.image);
    texture.dispose();
  }
  // GLTFLoader uses ImageBitmap: release decoded pixels as well as the GPU copy.
  for (const image of images) image.close?.();
  for (const geometry of geometries) geometry.dispose();
  root.clear();
}
