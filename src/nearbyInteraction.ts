export type NearbyCandidate = { id: string; distance: number; radius: number; visible?: boolean };

// Task navigation is intentionally not an input: E is determined by the physical scene.
export function nearestInteraction<T extends NearbyCandidate>(candidates: readonly T[]): T | null {
  let nearest: T | null = null;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.distance) || candidate.distance > candidate.radius || candidate.visible === false) continue;
    if (!nearest || candidate.distance < nearest.distance) nearest = candidate;
  }
  return nearest;
}
