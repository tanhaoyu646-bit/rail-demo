import type { HeldItemVariant, InventoryItemId } from './sceneProps';

// The public training demo intentionally ships only its lightweight fallback hand.
export async function createPhotoFpsHand(_id: InventoryItemId, _variant: HeldItemVariant): Promise<never> {
  throw new Error('公开演示版不包含原始手部照片资源。');
}
