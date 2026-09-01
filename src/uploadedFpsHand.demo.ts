import type * as THREE from 'three';
import type { HeldItemVariant, InventoryItemId } from './sceneProps';

/** Public build guard: the supplied scanned hand and its asset URL stay private. */
export async function createUploadedFpsHand(
  _id: InventoryItemId,
  _variant: HeldItemVariant,
): Promise<THREE.Group> {
  throw new Error('Scanned hand is unavailable in the public demo.');
}
