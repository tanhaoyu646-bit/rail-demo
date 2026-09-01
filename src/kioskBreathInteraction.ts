import * as THREE from 'three';

// Fit the real accessory as well as the screen, using the screen's orientation.
// This is only for the alcohol-test step; notice-reading keeps its close screen view.
export function fitScreenAndAccessory(camera: THREE.PerspectiveCamera, screen: THREE.Object3D, accessory: THREE.Object3D): void {
  const rotation = screen.getWorldQuaternion(new THREE.Quaternion());
  const inverseRotation = rotation.clone().invert();
  const bounds = new THREE.Box3();
  const corners: THREE.Vector3[] = [];
  for (const object of [screen, accessory]) {
    const box = new THREE.Box3().setFromObject(object);
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const point = new THREE.Vector3(x, y, z).applyQuaternion(inverseRotation);
      bounds.expandByPoint(point); corners.push(point);
    }
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanX = tanY * camera.aspect;
  const margin = 1.13;
  const z = Math.max(...corners.map(point => point.z + Math.max(
    Math.abs(point.x - center.x) * margin / tanX,
    Math.abs(point.y - center.y) * margin / tanY,
    camera.near + 0.05,
  )));
  camera.position.set(center.x, center.y, z).applyQuaternion(rotation);
  camera.quaternion.copy(rotation);
  camera.updateMatrixWorld(true);
}

export function nearestKioskSurface(raycaster: THREE.Raycaster, screen: THREE.Object3D, analyzer: THREE.Object3D | null, alcoholStep: boolean): THREE.Intersection | undefined {
  // A foreground analyzer must not lose its click to the screen behind it.
  return raycaster.intersectObjects(alcoholStep && analyzer ? [screen, analyzer] : [screen], false)[0];
}
