import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Railway Attendance Kiosk
// Sculpt build pass: structural-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createRailwayAttendanceKioskModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Railway Attendance Kiosk";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {"schemaVersion": 1, "status": "proceed", "registry": "C:\\Users\\Tan\\.codex\\skills\\img2threejs\\docs\\materials\\material-reference.json", "analysisArtifact": "E:\\100-工作\\110-课程建设\\crew-training-3d\\models\\attendance-kiosk\\material-analysis.json", "targetThreshold": 0.7, "unresolvedNotObservedMaterials": [], "regions": [{"componentId": "upper-shell", "regionId": "shell-white", "specMaterialId": "shell-white", "profileId": "coating.painted-metal", "status": "proceed"}, {"componentId": "main-screen", "regionId": "screen-glass", "specMaterialId": "screen-glass", "profileId": "glass.clear", "status": "proceed"}, {"componentId": "worktop", "regionId": "worktop-glass", "specMaterialId": "worktop-glass", "profileId": "plastic.glossy", "status": "proceed"}, {"componentId": "interface-fascia", "regionId": "fascia-gray", "specMaterialId": "fascia-gray", "profileId": "plastic.matte", "status": "proceed"}, {"componentId": "card-reader", "regionId": "dark-plastic", "specMaterialId": "dark-plastic", "profileId": "plastic.matte", "status": "proceed"}, {"componentId": "blue-connectors", "regionId": "blue-plastic", "specMaterialId": "blue-plastic", "profileId": "plastic.matte", "status": "proceed"}, {"componentId": "keyboard", "regionId": "metal-keyboard", "specMaterialId": "metal-keyboard", "profileId": "metal.steel-brushed", "status": "proceed"}], "controlledViewsRequired": ["albedo-unlit", "backlight-transmission", "environment-reflection", "grazing", "neutral-studio", "reference-beauty"]};
  root.userData.materialReferenceRegistry = "C:\\Users\\Tan\\.codex\\skills\\img2threejs\\docs\\materials\\material-reference.json";

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["shell-white"] = createSculptMaterial(
    "shell-white",
    {"id": "shell-white", "name": "Warm White Powder-Coated Shell", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#E8E9E5", "color": "#E8E9E5", "albedo": {"dominant": "#E8E9E5", "secondary": ["#D6D9D6", "#F3F3EF"], "samplingNotes": "Use image-observed local color zones, not a single averaged color."}, "colorVariation": {"palette": ["#E8E9E5", "#D6D9D6", "#F3F3EF"], "pattern": "fine powder-coat value variation", "amplitude": 0.035, "heightCorrelation": 0.08}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.45, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "higher roughness in cavities, lower roughness on worn edges"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.08, "scale": 80.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "shell-white.edge-softening", "region": "exposed chamfer crests", "roughness": 0.54, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Warm-white satin shell with subtle powder-coat highlight breakup.", "referenceMaterialId": "coating.painted-metal", "materialFamily": "coating", "materialSubtype": "paint-over-metal", "materialFinish": "gloss-or-satin", "materialReference": {"registry": "C:\\Users\\Tan\\.codex\\skills\\img2threejs\\docs\\materials\\material-reference.json", "profileId": "coating.painted-metal", "method": "family-subtype-finish", "confidence": 0.86, "sourceRefs": ["three.mesh-physical", "gltf.2", "khronos.gltf-pbr", "adobe.pbr-guide-1", "adobe.pbr-guide-2"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "clearcoatMap", "clearcoatRoughnessMap", "metalnessMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "environment-reflection", "reference-beauty"]}, "clearcoat": {"base": 0.75, "variation": 0.0}, "clearcoatRoughness": {"base": 0.12, "variation": 0.0}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\00-shell-white.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-00-shell-white\\shell-white_albedo.png", "url": "shell-white_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-00-shell-white\\shell-white_roughness.png", "url": "shell-white_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-00-shell-white\\shell-white_height.png", "url": "shell-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-00-shell-white\\shell-white_normal.png", "url": "shell-white_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-00-shell-white\\shell-white_ao.png", "url": "shell-white_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 190, "sourceHeight": 280, "mapSize": 512, "cropBBoxPixels": {"x": 16, "y": 0, "width": 174, "height": 191}, "mask": {"backgroundColor": "#AAB1B8", "backgroundNoise": 45.222, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1339}, "mapStats": {"valueRange": 0.3784, "heightP90Gradient": 0.05698, "roughnessBase": 0.68, "roughnessVariation": 0.079, "normalStrength": 0.223, "blurRadius": 10}, "palette": ["#393D3D", "#202525", "#101618", "#59615B", "#CBC3C1"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "worn-composite", "recipe": {"metalness": 0.0, "roughness": 0.9, "clearcoat": 0.0, "clearcoatRoughness": 0.0, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.5, "anisotropy": 0.0, "procedural": "mottle"}, "palette": ["#323531", "#747979", "#C7D0CF", "#C6D0CF", "#BEC7C9"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 171.5, "meanSaturation": 0.072, "gradientStrength": 0.652, "mottle": 0.027, "streakRatio": 0.75, "hueSpread": 0.132, "specularFraction": 0.009}}, "materialEvidence": {"componentId": "upper-shell", "regionId": "shell-white", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\00-shell-white.png", "bbox": {"x": 0, "y": 280, "width": 190, "height": 280}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0618}, "observations": ["near-neutral colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "upper-shell", "regionId": "shell-white", "materialId": null, "family": "coating", "subtype": "paint-over-metal", "finish": "gloss-or-satin", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["screen-glass"] = createSculptMaterial(
    "screen-glass",
    {"id": "screen-glass", "name": "Dark Screen Glass", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#101716", "color": "#101716", "albedo": {"dominant": "#101716", "secondary": ["#162522", "#060908"], "samplingNotes": "Use synthetic UI beneath glass; do not project photographed text."}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "one stable texel scale across the screen footprint"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.05, "role": "broad reflection"}, {"id": "meso", "frequency": 8, "amplitude": 0.01, "role": "clean glass variation"}, {"id": "micro", "frequency": 64, "amplitude": 0.005, "role": "subtle highlight breakup"}], "roughness": {"base": 0.05, "variation": 0.035, "map": "independent-procedural-field", "localResponse": "lowest roughness at broad reflection band"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "none", "strength": 0.0, "scale": 1, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1}, "ambientOcclusion": {"cavityStrength": 0.12, "contactShadowBias": 0.18, "notes": "darken bezel contact only"}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.02, "cavityBias": 0.0, "color": "#0A0C0B"}, "localOverrides": [{"id": "screen-glass.reflection-band", "region": "upper-right visible footprint", "roughness": 0.1, "clearcoat": 0.9, "clearcoatRoughness": 0.08, "evidenceRefs": ["full-object"]}], "notes": "Low-roughness glass-like panel with controlled reflection.", "referenceMaterialId": "glass.clear", "materialFamily": "glass", "materialSubtype": "clear", "materialFinish": "polished", "materialReference": {"registry": "C:\\Users\\Tan\\.codex\\skills\\img2threejs\\docs\\materials\\material-reference.json", "profileId": "glass.clear", "method": "family-subtype-finish", "confidence": 0.793, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "thicknessMap"], "optionalMaps": ["map", "normalMap", "transmissionMap"], "validationViews": ["neutral-studio", "environment-reflection", "backlight-transmission", "reference-beauty"]}, "transmission": {"base": 1.0, "variation": 0.0}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\01-screen-glass.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.793, "estimatedFidelity": 0.793, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-01-screen-glass\\screen-glass_albedo.png", "url": "screen-glass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-01-screen-glass\\screen-glass_roughness.png", "url": "screen-glass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-01-screen-glass\\screen-glass_height.png", "url": "screen-glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-01-screen-glass\\screen-glass_normal.png", "url": "screen-glass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-01-screen-glass\\screen-glass_ao.png", "url": "screen-glass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 490, "sourceHeight": 360, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 53, "width": 488, "height": 307}, "mask": {"backgroundColor": "#606867", "backgroundNoise": 120.71, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.0646}, "mapStats": {"valueRange": 0.4301, "heightP90Gradient": 0.01438, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.173, "blurRadius": 10}, "palette": ["#59675E", "#1D2224", "#151B1E", "#5E7D76", "#609289"]}, "warnings": ["foreground mask is very small", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "worn-composite", "recipe": {"metalness": 0.0, "roughness": 0.9, "clearcoat": 0.0, "clearcoatRoughness": 0.0, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.5, "anisotropy": 0.0, "procedural": "mottle"}, "palette": ["#6B7171", "#6D706C", "#727771", "#6C7571", "#7B8484"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 113.8, "meanSaturation": 0.076, "gradientStrength": 0.232, "mottle": 0.032, "streakRatio": 0.96, "hueSpread": 0.084, "specularFraction": 0.005}}, "materialEvidence": {"componentId": "main-screen", "regionId": "screen-glass", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\01-screen-glass.png", "bbox": {"x": 230, "y": 80, "width": 490, "height": 360}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.2048}, "observations": ["near-neutral colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "main-screen", "regionId": "screen-glass", "materialId": null, "family": "glass", "subtype": "clear", "finish": "polished", "aliases": [], "confidence": 0.793, "source": "vision"}, "alternatives": []}, "needsEnvironment": true},
    options
  );
  materialMap["worktop-glass"] = createSculptMaterial(
    "worktop-glass",
    {"id": "worktop-glass", "name": "Gloss Black Worktop", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#111715", "color": "#111715", "albedo": {"dominant": "#111715", "secondary": ["#1B2421", "#070A09"], "samplingNotes": "Reference shows broad room-light reflections."}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "stable object-space detail across the worktop slab"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.06, "role": "broad reflection"}, {"id": "meso", "frequency": 10, "amplitude": 0.015, "role": "handled surface variation"}, {"id": "micro", "frequency": 72, "amplitude": 0.008, "role": "fine highlight breakup"}], "roughness": {"base": 0.28, "variation": 0.05, "map": "independent-procedural-field", "localResponse": "slightly rougher near operator edge"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "fine handling marks", "strength": 0.03, "scale": 56, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.3, "notes": "ground keyboard and props"}, "wear": {"edgeWear": 0.02, "scratches": [], "chips": []}, "dirt": {"amount": 0.025, "cavityBias": 0.1, "color": "#080A09"}, "localOverrides": [{"id": "worktop-glass.operator-reflection", "region": "operator-facing half", "roughness": 0.16, "clearcoat": 0.75, "clearcoatRoughness": 0.12, "evidenceRefs": ["full-object"]}], "notes": "Gloss black work surface distinct from screen glass.", "referenceMaterialId": "plastic.glossy", "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "glossy", "materialReference": {"registry": "C:\\Users\\Tan\\.codex\\skills\\img2threejs\\docs\\materials\\material-reference.json", "profileId": "plastic.glossy", "method": "family-subtype-finish", "confidence": 0.829, "sourceRefs": ["three.mesh-physical", "three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "clearcoatMap"], "validationViews": ["neutral-studio", "grazing", "environment-reflection", "reference-beauty"]}, "clearcoat": {"base": 0.2, "variation": 0.0}, "clearcoatRoughness": {"base": 0.18, "variation": 0.0}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\02-worktop-glass.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-02-worktop-glass\\worktop-glass_albedo.png", "url": "worktop-glass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-02-worktop-glass\\worktop-glass_roughness.png", "url": "worktop-glass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-02-worktop-glass\\worktop-glass_height.png", "url": "worktop-glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-02-worktop-glass\\worktop-glass_normal.png", "url": "worktop-glass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-02-worktop-glass\\worktop-glass_ao.png", "url": "worktop-glass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 200, "sourceHeight": 190, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 200, "height": 190}, "mask": {"backgroundColor": "#1C272C", "backgroundNoise": 26.019, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.998}, "mapStats": {"valueRange": 0.7413, "heightP90Gradient": 0.07283, "roughnessBase": 0.706, "roughnessVariation": 0.141, "normalStrength": 0.242, "blurRadius": 10}, "palette": ["#101C1F", "#7F9A8B", "#AACCBE", "#213032", "#5A6D63"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#222A2D", "#40534D", "#526862", "#79958C", "#384A47"], "paletteHueRisk": [{"stop": "#222A2D", "hueRisk": "blue-collapse", "suggestedRgb": [45, 42, 34]}], "gradientAxis": "horizontal", "stats": {"meanLum": 93.5, "meanSaturation": 0.327, "gradientStrength": 0.483, "mottle": 0.058, "streakRatio": 1.13, "hueSpread": 0.043, "specularFraction": 0.0}}, "materialEvidence": {"componentId": "worktop", "regionId": "worktop-glass", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\02-worktop-glass.png", "bbox": {"x": 520, "y": 950, "width": 200, "height": 190}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0441}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "worktop", "regionId": "worktop-glass", "materialId": null, "family": "plastic", "subtype": "generic-polymer", "finish": "glossy", "aliases": [], "confidence": 0.829, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["fascia-gray"] = createSculptMaterial(
    "fascia-gray",
    {"id": "fascia-gray", "name": "Cool Gray Interface Fascia", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#BFC4C3", "color": "#BFC4C3", "albedo": {"dominant": "#BFC4C3", "secondary": ["#AEB5B3", "#D1D4D2"], "samplingNotes": "Neutral cool-gray front panel."}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "uniform molded-grain density across fascia panels"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.04, "role": "panel value separation"}, {"id": "meso", "frequency": 18, "amplitude": 0.025, "role": "molded surface"}, {"id": "micro", "frequency": 80, "amplitude": 0.015, "role": "fine texture"}], "roughness": {"base": 0.68, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "higher roughness around vents"}, "metalness": {"base": 0.0, "variation": 0.02}, "normal": {"pattern": "fine molded grain", "strength": 0.07, "scale": 70, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1}, "ambientOcclusion": {"cavityStrength": 0.32, "contactShadowBias": 0.34, "notes": "darken port and vent cavities"}, "wear": {"edgeWear": 0.01, "scratches": [], "chips": []}, "dirt": {"amount": 0.02, "cavityBias": 0.4, "color": "#66706D"}, "localOverrides": [{"id": "fascia-gray.port-cavity-mask", "region": "port and vent cavities", "roughness": 0.66, "evidenceRefs": ["full-object"]}], "notes": "Satin cool-gray interface panel.", "referenceMaterialId": "plastic.matte", "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "matte", "materialReference": {"registry": "C:\\Users\\Tan\\.codex\\skills\\img2threejs\\docs\\materials\\material-reference.json", "profileId": "plastic.matte", "method": "family-subtype-finish", "confidence": 0.86, "sourceRefs": ["three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "aoMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing"]}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\03-fascia-gray.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-03-fascia-gray\\fascia-gray_albedo.png", "url": "fascia-gray_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-03-fascia-gray\\fascia-gray_roughness.png", "url": "fascia-gray_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-03-fascia-gray\\fascia-gray_height.png", "url": "fascia-gray_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-03-fascia-gray\\fascia-gray_normal.png", "url": "fascia-gray_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-03-fascia-gray\\fascia-gray_ao.png", "url": "fascia-gray_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 285, "sourceHeight": 175, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 285, "height": 175}, "mask": {"backgroundColor": "#A8B2B5", "backgroundNoise": 31.209, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.421}, "mapStats": {"valueRange": 0.7396, "heightP90Gradient": 0.06016, "roughnessBase": 0.686, "roughnessVariation": 0.104, "normalStrength": 0.227, "blurRadius": 10}, "palette": ["#393F46", "#50565D", "#252E36", "#988586", "#D5E4F0"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "worn-composite", "recipe": {"metalness": 0.0, "roughness": 0.9, "clearcoat": 0.0, "clearcoatRoughness": 0.0, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.5, "anisotropy": 0.0, "procedural": "mottle"}, "palette": ["#ABB6BA", "#899297", "#6C747D", "#8F959F", "#ACAFB5"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 145.4, "meanSaturation": 0.147, "gradientStrength": 0.281, "mottle": 0.042, "streakRatio": 1.05, "hueSpread": 0.483, "specularFraction": 0.002}}, "materialEvidence": {"componentId": "interface-fascia", "regionId": "fascia-gray", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\03-fascia-gray.png", "bbox": {"x": 20, "y": 535, "width": 285, "height": 175}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0579}, "observations": ["near-neutral colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "interface-fascia", "regionId": "fascia-gray", "materialId": null, "family": "plastic", "subtype": "generic-polymer", "finish": "matte", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["dark-plastic"] = createSculptMaterial(
    "dark-plastic",
    {"id": "dark-plastic", "name": "Dark Interface Plastic", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#171D1B", "color": "#171D1B", "albedo": {"dominant": "#171D1B", "secondary": ["#242C29", "#080B0A"], "samplingNotes": "Recognition recess, bezels, ports and card reader."}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "uniform molded-grain density across all dark plastic modules"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.04, "role": "part separation"}, {"id": "meso", "frequency": 16, "amplitude": 0.025, "role": "mold grain"}, {"id": "micro", "frequency": 74, "amplitude": 0.012, "role": "highlight breakup"}], "roughness": {"base": 0.68, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "cavities up to 0.7"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "fine molded grain", "strength": 0.06, "scale": 64, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1}, "ambientOcclusion": {"cavityStrength": 0.35, "contactShadowBias": 0.32, "notes": "strongest in slot and sensor recess"}, "wear": {"edgeWear": 0.015, "scratches": [], "chips": []}, "dirt": {"amount": 0.02, "cavityBias": 0.45, "color": "#080A09"}, "localOverrides": [{"id": "dark-plastic.cavity-darkening", "region": "recess and slot interiors", "roughness": 0.68, "evidenceRefs": ["full-object"]}], "notes": "Dark molded parts, not metallic.", "referenceMaterialId": "plastic.matte", "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "matte", "materialReference": {"registry": "C:\\Users\\Tan\\.codex\\skills\\img2threejs\\docs\\materials\\material-reference.json", "profileId": "plastic.matte", "method": "family-subtype-finish", "confidence": 0.829, "sourceRefs": ["three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "aoMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing"]}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\04-dark-plastic.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-04-dark-plastic\\dark-plastic_albedo.png", "url": "dark-plastic_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-04-dark-plastic\\dark-plastic_roughness.png", "url": "dark-plastic_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-04-dark-plastic\\dark-plastic_height.png", "url": "dark-plastic_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-04-dark-plastic\\dark-plastic_normal.png", "url": "dark-plastic_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-04-dark-plastic\\dark-plastic_ao.png", "url": "dark-plastic_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 265, "sourceHeight": 150, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 265, "height": 150}, "mask": {"backgroundColor": "#1D2226", "backgroundNoise": 47.35, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9676}, "mapStats": {"valueRange": 0.8204, "heightP90Gradient": 0.03719, "roughnessBase": 0.684, "roughnessVariation": 0.05, "normalStrength": 0.2, "blurRadius": 10}, "palette": ["#D9E3E4", "#0B151D", "#C0CACC", "#1B2126", "#373F44"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#191D22", "#B3BABD", "#C6D0D2", "#2D363E", "#141E26"], "paletteHueRisk": [{"stop": "#191D22", "hueRisk": "blue-collapse", "suggestedRgb": [34, 29, 25]}, {"stop": "#2D363E", "hueRisk": "blue-collapse", "suggestedRgb": [62, 54, 45]}, {"stop": "#141E26", "hueRisk": "blue-collapse", "suggestedRgb": [38, 30, 20]}], "gradientAxis": "vertical", "stats": {"meanLum": 116.1, "meanSaturation": 0.261, "gradientStrength": 0.769, "mottle": 0.015, "streakRatio": 0.49, "hueSpread": 0.003, "specularFraction": 0.003}}, "materialEvidence": {"componentId": "card-reader", "regionId": "dark-plastic", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\04-dark-plastic.png", "bbox": {"x": 345, "y": 455, "width": 265, "height": 150}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0461}, "observations": ["chromatic base-colour response", "directional surface frequency", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "card-reader", "regionId": "dark-plastic", "materialId": null, "family": "plastic", "subtype": "generic-polymer", "finish": "matte", "aliases": [], "confidence": 0.829, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["blue-plastic"] = createSculptMaterial(
    "blue-plastic",
    {"id": "blue-plastic", "name": "Cyan-Blue Connector Plastic", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#1594B5", "color": "#1594B5", "albedo": {"dominant": "#1594B5", "secondary": ["#087B9A", "#38A9C4"], "samplingNotes": "Paired connector caps are the strongest color accent."}, "textureResolution": 1024, "textureProjection": {"mode": "cylindrical", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "stable density around both connector cap circumferences"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.06, "role": "cap value variation"}, {"id": "meso", "frequency": 14, "amplitude": 0.03, "role": "molded ribs"}, {"id": "micro", "frequency": 68, "amplitude": 0.015, "role": "plastic highlight breakup"}], "roughness": {"base": 0.68, "variation": 0.07, "map": "independent-procedural-field", "localResponse": "lower on raised ribs"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "radial molded texture", "strength": 0.08, "scale": 48, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1}, "ambientOcclusion": {"cavityStrength": 0.26, "contactShadowBias": 0.28, "notes": "darken rib valleys"}, "wear": {"edgeWear": 0.01, "scratches": [], "chips": []}, "dirt": {"amount": 0.01, "cavityBias": 0.35, "color": "#075B6F"}, "localOverrides": [{"id": "blue-plastic.rib-highlight", "region": "radial grip rib crests", "roughness": 0.38, "evidenceRefs": ["full-object"]}], "notes": "Cyan-blue molded connector caps.", "referenceMaterialId": "plastic.matte", "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "matte", "materialReference": {"registry": "C:\\Users\\Tan\\.codex\\skills\\img2threejs\\docs\\materials\\material-reference.json", "profileId": "plastic.matte", "method": "family-subtype-finish", "confidence": 0.86, "sourceRefs": ["three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "aoMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing"]}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\05-blue-plastic.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-05-blue-plastic\\blue-plastic_albedo.png", "url": "blue-plastic_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-05-blue-plastic\\blue-plastic_roughness.png", "url": "blue-plastic_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-05-blue-plastic\\blue-plastic_height.png", "url": "blue-plastic_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-05-blue-plastic\\blue-plastic_normal.png", "url": "blue-plastic_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-05-blue-plastic\\blue-plastic_ao.png", "url": "blue-plastic_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 210, "sourceHeight": 170, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 210, "height": 170}, "mask": {"backgroundColor": "#B9C4CA", "backgroundNoise": 245.955, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.2443}, "mapStats": {"valueRange": 0.5132, "heightP90Gradient": 0.05094, "roughnessBase": 0.68, "roughnessVariation": 0.075, "normalStrength": 0.216, "blurRadius": 10}, "palette": ["#0B141D", "#1D6486", "#404955", "#8197A6", "#222A35"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#353E46", "#939DA3", "#869198", "#7692A1", "#77767F"], "paletteHueRisk": [{"stop": "#353E46", "hueRisk": "blue-collapse", "suggestedRgb": [70, 62, 53]}, {"stop": "#7692A1", "hueRisk": "blue-collapse", "suggestedRgb": [161, 146, 118]}], "gradientAxis": "vertical", "stats": {"meanLum": 135.6, "meanSaturation": 0.219, "gradientStrength": 0.411, "mottle": 0.029, "streakRatio": 0.8, "hueSpread": 0.047, "specularFraction": 0.0}}, "materialEvidence": {"componentId": "blue-connectors", "regionId": "blue-plastic", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\05-blue-plastic.png", "bbox": {"x": 300, "y": 610, "width": 210, "height": 170}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0414}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "blue-connectors", "regionId": "blue-plastic", "materialId": null, "family": "plastic", "subtype": "generic-polymer", "finish": "matte", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["metal-keyboard"] = createSculptMaterial(
    "metal-keyboard",
    {"id": "metal-keyboard", "name": "Brushed Metal Keyboard", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#9B9F9C", "color": "#9B9F9C", "albedo": {"dominant": "#9B9F9C", "secondary": ["#747A77", "#BABDBA"], "samplingNotes": "Keyboard deck and raised keycaps."}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "stable brushing density across deck and keycaps"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.05, "role": "deck value separation"}, {"id": "meso", "frequency": 20, "amplitude": 0.035, "role": "brushed direction"}, {"id": "micro", "frequency": 96, "amplitude": 0.015, "role": "anisotropic highlight breakup"}], "roughness": {"base": 0.35, "variation": 0.07, "map": "independent-procedural-field", "localResponse": "keycaps slightly rougher than deck"}, "metalness": {"base": 1.0, "variation": 0.12}, "normal": {"pattern": "directional brushing", "strength": 0.08, "scale": 92, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.34, "notes": "darken key gaps"}, "wear": {"edgeWear": 0.025, "scratches": [], "chips": []}, "dirt": {"amount": 0.015, "cavityBias": 0.45, "color": "#4B504E"}, "localOverrides": [{"id": "metal-keyboard.key-gap-mask", "region": "between keycaps", "roughness": 0.58, "evidenceRefs": ["full-object"]}], "notes": "Brushed metal keyboard with bounded key repetition.", "referenceMaterialId": "metal.steel-brushed", "materialFamily": "metal", "materialSubtype": "steel", "materialFinish": "brushed", "materialReference": {"registry": "C:\\Users\\Tan\\.codex\\skills\\img2threejs\\docs\\materials\\material-reference.json", "profileId": "metal.steel-brushed", "method": "family-subtype-finish", "confidence": 0.86, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.gltf-pbr", "adobe.pbr-guide-2", "google.filament-pbr"], "requiredMaps": ["map", "roughnessMap", "normalMap", "anisotropyMap"], "optionalMaps": ["metalnessMap"], "validationViews": ["neutral-studio", "grazing", "environment-reflection", "reference-beauty"]}, "anisotropy": {"base": 0.85, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\06-metal-keyboard.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-06-metal-keyboard\\metal-keyboard_albedo.png", "url": "metal-keyboard_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-06-metal-keyboard\\metal-keyboard_roughness.png", "url": "metal-keyboard_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-06-metal-keyboard\\metal-keyboard_height.png", "url": "metal-keyboard_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-06-metal-keyboard\\metal-keyboard_normal.png", "url": "metal-keyboard_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\pbr-06-metal-keyboard\\metal-keyboard_ao.png", "url": "metal-keyboard_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 470, "sourceHeight": 250, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 470, "height": 250}, "mask": {"backgroundColor": "#3F4C55", "backgroundNoise": 106.283, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.62}, "mapStats": {"valueRange": 0.4497, "heightP90Gradient": 0.06023, "roughnessBase": 0.7, "roughnessVariation": 0.094, "normalStrength": 0.227, "blurRadius": 10}, "palette": ["#1B2429", "#0B090F", "#491D28", "#3C4248", "#90A296"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#4C434D", "#392B31", "#3E4446", "#545B5C", "#575F63"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 70.1, "meanSaturation": 0.287, "gradientStrength": 0.236, "mottle": 0.071, "streakRatio": 1.12, "hueSpread": 0.622, "specularFraction": 0.002}}, "materialEvidence": {"componentId": "keyboard", "regionId": "metal-keyboard", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\06-metal-keyboard.png", "bbox": {"x": 100, "y": 805, "width": 470, "height": 250}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.1364}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "keyboard", "regionId": "metal-keyboard", "materialId": null, "family": "metal", "subtype": "steel", "finish": "brushed", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}, "needsEnvironment": true},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Kiosk Root Cabinet__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Kiosk Root Cabinet", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid lower cabinet with countable planar faces; a beveled box is structurally appropriate.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.3, "height": 1.2, "depth": 0.56, "units": "meters-approximate", "confidence": 0.62}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-white", "materialLayers": ["shell-white"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 229, 1)", "secondaryAlbedo": "rgba(214, 217, 214, 1)", "materialClass": "metal", "materialClassConfidence": 0.72, "baseColor": "#E8E9E5", "roughness": 0.62, "metalness": 0.05, "finish": "satin powder-coated shell"}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "shell.edge-chamfers", "kind": "bevel", "bevelRadius": 0.025, "segments": 1, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.3, 1.2, 0.56);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["shell-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Kiosk Root Cabinet";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Kiosk Root Cabinet", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.7, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid lower cabinet with countable planar faces; a beveled box is structurally appropriate.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.3, "height": 1.2, "depth": 0.56, "units": "meters-approximate", "confidence": 0.62}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-white", "materialLayers": ["shell-white"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 229, 1)", "secondaryAlbedo": "rgba(214, 217, 214, 1)", "materialClass": "metal", "materialClassConfidence": 0.72, "baseColor": "#E8E9E5", "roughness": 0.62, "metalness": 0.05, "finish": "satin powder-coated shell"}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "shell.edge-chamfers", "kind": "bevel", "bevelRadius": 0.025, "segments": 1, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_upper_shell_1 = makeAttachmentEndpoint(null);
  const node_upper_shell_1 = new THREE.Group();
  node_upper_shell_1.name = "Sloped Upper Screen Housing__pivot";
  node_upper_shell_1.scale.set(1, 1, 1);
  if (endpoint_upper_shell_1) {
    node_upper_shell_1.position.copy(endpoint_upper_shell_1.start);
    node_upper_shell_1.rotation.set(-0.2, 0.0, 0.0);
  } else {
    node_upper_shell_1.position.set(0.0, 1.03, 0.14);
    node_upper_shell_1.rotation.set(-0.2, 0.0, 0.0);
  }
  node_upper_shell_1.userData.sculptComponent = {"id": "upper-shell", "name": "Sloped Upper Screen Housing", "level": "macro", "role": "shell", "importance": 0.96, "confidence": 0.78, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid sloped housing with planar faces and a shallow front bevel.", "geometryDescriptor": {"topologyIntent": "beveled hard-surface housing", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "root", "attachment": {"parentSocket": "root-upper-front", "contactType": "overlap", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.12], "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01}, "dimensions": {"width": 1.34, "height": 0.86, "depth": 0.34, "units": "meters-approximate", "confidence": 0.68}, "transform": {"position": [0, 1.03, 0.14], "rotation": [-0.2, 0, 0], "scale": [1, 1, 1]}, "material": "shell-white", "materialLayers": ["shell-white"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 229, 1)", "secondaryAlbedo": "rgba(214, 217, 214, 1)", "materialClass": "metal", "materialClassConfidence": 0.72, "baseColor": "#E8E9E5", "roughness": 0.62, "metalness": 0.05, "finish": "satin powder coat"}, "localFeatures": [{"id": "upper-shell.edge-chamfers", "kind": "bevel", "bevelRadius": 0.03, "segments": 1, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "shell-white"}, "materialRegions": [{"regionId": "shell-white", "materialId": "shell-white", "profileId": "coating.painted-metal", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\00-shell-white.png", "bbox": {"x": 0, "y": 280, "width": 190, "height": 280}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0618}}]};
  node_upper_shell_1.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_upper_shell_1);
  nodes["upper-shell"] = node_upper_shell_1;
  const mesh_upper_shell_1Geometry = endpoint_upper_shell_1
    ? new THREE.CylinderGeometry(endpoint_upper_shell_1.endRadius, endpoint_upper_shell_1.baseRadius, endpoint_upper_shell_1.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_upper_shell_1) {
    mesh_upper_shell_1Geometry.scale(1.34, 0.86, 0.34);
  }
  const mesh_upper_shell_1 = new THREE.Mesh(
    mesh_upper_shell_1Geometry,
    materialMap["shell-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_shell_1.name = "Sloped Upper Screen Housing";
  if (endpoint_upper_shell_1) {
    mesh_upper_shell_1.position.copy(endpoint_upper_shell_1.midpoint);
    mesh_upper_shell_1.quaternion.copy(endpoint_upper_shell_1.quaternion);
  }
  mesh_upper_shell_1.castShadow = options.castShadow ?? true;
  mesh_upper_shell_1.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_shell_1.userData.sculptComponent = {"id": "upper-shell", "name": "Sloped Upper Screen Housing", "level": "macro", "role": "shell", "importance": 0.96, "confidence": 0.78, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid sloped housing with planar faces and a shallow front bevel.", "geometryDescriptor": {"topologyIntent": "beveled hard-surface housing", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "root", "attachment": {"parentSocket": "root-upper-front", "contactType": "overlap", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.12], "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01}, "dimensions": {"width": 1.34, "height": 0.86, "depth": 0.34, "units": "meters-approximate", "confidence": 0.68}, "transform": {"position": [0, 1.03, 0.14], "rotation": [-0.2, 0, 0], "scale": [1, 1, 1]}, "material": "shell-white", "materialLayers": ["shell-white"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 229, 1)", "secondaryAlbedo": "rgba(214, 217, 214, 1)", "materialClass": "metal", "materialClassConfidence": 0.72, "baseColor": "#E8E9E5", "roughness": 0.62, "metalness": 0.05, "finish": "satin powder coat"}, "localFeatures": [{"id": "upper-shell.edge-chamfers", "kind": "bevel", "bevelRadius": 0.03, "segments": 1, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "shell-white"}, "materialRegions": [{"regionId": "shell-white", "materialId": "shell-white", "profileId": "coating.painted-metal", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\00-shell-white.png", "bbox": {"x": 0, "y": 280, "width": 190, "height": 280}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0618}}]};
  node_upper_shell_1.add(mesh_upper_shell_1);
  meshes["upper-shell"] = mesh_upper_shell_1;
  colliders["upper-shell"] = {};

  const endpoint_interface_fascia_2 = makeAttachmentEndpoint(null);
  const node_interface_fascia_2 = new THREE.Group();
  node_interface_fascia_2.name = "Gray Connector Fascia__pivot";
  node_interface_fascia_2.scale.set(1, 1, 1);
  if (endpoint_interface_fascia_2) {
    node_interface_fascia_2.position.copy(endpoint_interface_fascia_2.start);
    node_interface_fascia_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_interface_fascia_2.position.set(0.0, 0.7, 0.34);
    node_interface_fascia_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_interface_fascia_2.userData.sculptComponent = {"id": "interface-fascia", "name": "Gray Connector Fascia", "level": "macro", "role": "interface-panel", "importance": 0.86, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid recessed panel with planar face and discrete openings.", "geometryDescriptor": {"topologyIntent": "thin hard-surface panel", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "root", "attachment": {"parentSocket": "root-mid-front", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.08], "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.008}, "dimensions": {"width": 1.24, "height": 0.28, "depth": 0.08, "units": "meters-approximate", "confidence": 0.72}, "transform": {"position": [0, 0.7, 0.34], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "fascia-gray", "materialLayers": ["fascia-gray", "dark-plastic", "blue-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(191, 196, 195, 1)", "secondaryAlbedo": "rgba(174, 181, 179, 1)", "materialClass": "plastic", "materialClassConfidence": 0.68, "baseColor": "#BFC4C3", "roughness": 0.52, "metalness": 0.08, "finish": "satin molded fascia"}, "localFeatures": [{"id": "interface-fascia.vent-grid", "kind": "hole", "pattern": "two bounded grids", "evidenceRefs": ["full-object"]}, {"id": "interface-fascia.circular-ports", "kind": "hole", "count": 3, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "fascia-gray"}, "materialRegions": [{"regionId": "fascia-gray", "materialId": "fascia-gray", "profileId": "plastic.matte", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\03-fascia-gray.png", "bbox": {"x": 20, "y": 535, "width": 285, "height": 175}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0579}}]};
  node_interface_fascia_2.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_interface_fascia_2);
  nodes["interface-fascia"] = node_interface_fascia_2;
  const mesh_interface_fascia_2Geometry = endpoint_interface_fascia_2
    ? new THREE.CylinderGeometry(endpoint_interface_fascia_2.endRadius, endpoint_interface_fascia_2.baseRadius, endpoint_interface_fascia_2.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_interface_fascia_2) {
    mesh_interface_fascia_2Geometry.scale(1.24, 0.28, 0.08);
  }
  const mesh_interface_fascia_2 = new THREE.Mesh(
    mesh_interface_fascia_2Geometry,
    materialMap["fascia-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_interface_fascia_2.name = "Gray Connector Fascia";
  if (endpoint_interface_fascia_2) {
    mesh_interface_fascia_2.position.copy(endpoint_interface_fascia_2.midpoint);
    mesh_interface_fascia_2.quaternion.copy(endpoint_interface_fascia_2.quaternion);
  }
  mesh_interface_fascia_2.castShadow = options.castShadow ?? true;
  mesh_interface_fascia_2.receiveShadow = options.receiveShadow ?? true;
  mesh_interface_fascia_2.userData.sculptComponent = {"id": "interface-fascia", "name": "Gray Connector Fascia", "level": "macro", "role": "interface-panel", "importance": 0.86, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid recessed panel with planar face and discrete openings.", "geometryDescriptor": {"topologyIntent": "thin hard-surface panel", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "root", "attachment": {"parentSocket": "root-mid-front", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.08], "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.008}, "dimensions": {"width": 1.24, "height": 0.28, "depth": 0.08, "units": "meters-approximate", "confidence": 0.72}, "transform": {"position": [0, 0.7, 0.34], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "fascia-gray", "materialLayers": ["fascia-gray", "dark-plastic", "blue-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(191, 196, 195, 1)", "secondaryAlbedo": "rgba(174, 181, 179, 1)", "materialClass": "plastic", "materialClassConfidence": 0.68, "baseColor": "#BFC4C3", "roughness": 0.52, "metalness": 0.08, "finish": "satin molded fascia"}, "localFeatures": [{"id": "interface-fascia.vent-grid", "kind": "hole", "pattern": "two bounded grids", "evidenceRefs": ["full-object"]}, {"id": "interface-fascia.circular-ports", "kind": "hole", "count": 3, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "fascia-gray"}, "materialRegions": [{"regionId": "fascia-gray", "materialId": "fascia-gray", "profileId": "plastic.matte", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\03-fascia-gray.png", "bbox": {"x": 20, "y": 535, "width": 285, "height": 175}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0579}}]};
  node_interface_fascia_2.add(mesh_interface_fascia_2);
  meshes["interface-fascia"] = mesh_interface_fascia_2;
  colliders["interface-fascia"] = {};

  const endpoint_worktop_3 = makeAttachmentEndpoint(null);
  const node_worktop_3 = new THREE.Group();
  node_worktop_3.name = "Black Operator Worktop__pivot";
  node_worktop_3.scale.set(1, 1, 1);
  if (endpoint_worktop_3) {
    node_worktop_3.position.copy(endpoint_worktop_3.start);
    node_worktop_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_worktop_3.position.set(0.0, 0.54, 0.44);
    node_worktop_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_worktop_3.userData.sculptComponent = {"id": "worktop", "name": "Black Operator Worktop", "level": "macro", "role": "work-surface", "importance": 0.9, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Independent glossy slab with rigid planar faces and projecting front edge.", "geometryDescriptor": {"topologyIntent": "thin beveled slab", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.018, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "root", "attachment": {"parentSocket": "root-worktop", "contactType": "overlap", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.1], "embedDepth": 0.02, "overlap": 0.03, "gapTolerance": 0.008}, "dimensions": {"width": 1.32, "height": 0.06, "depth": 0.6, "units": "meters-approximate", "confidence": 0.7}, "transform": {"position": [0, 0.54, 0.44], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "worktop-glass", "materialLayers": ["worktop-glass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 23, 21, 1)", "secondaryAlbedo": "rgba(27, 36, 33, 1)", "materialClass": "glass", "materialClassConfidence": 0.76, "baseColor": "#111715", "roughness": 0.2, "metalness": 0.02, "clearcoat": 0.72, "finish": "gloss black worktop"}, "localFeatures": [], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "worktop-glass"}, "materialRegions": [{"regionId": "worktop-glass", "materialId": "worktop-glass", "profileId": "plastic.glossy", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\02-worktop-glass.png", "bbox": {"x": 520, "y": 950, "width": 200, "height": 190}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0441}}]};
  node_worktop_3.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_worktop_3);
  nodes["worktop"] = node_worktop_3;
  const mesh_worktop_3Geometry = endpoint_worktop_3
    ? new THREE.CylinderGeometry(endpoint_worktop_3.endRadius, endpoint_worktop_3.baseRadius, endpoint_worktop_3.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_worktop_3) {
    mesh_worktop_3Geometry.scale(1.32, 0.06, 0.6);
  }
  const mesh_worktop_3 = new THREE.Mesh(
    mesh_worktop_3Geometry,
    materialMap["worktop-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_worktop_3.name = "Black Operator Worktop";
  if (endpoint_worktop_3) {
    mesh_worktop_3.position.copy(endpoint_worktop_3.midpoint);
    mesh_worktop_3.quaternion.copy(endpoint_worktop_3.quaternion);
  }
  mesh_worktop_3.castShadow = options.castShadow ?? true;
  mesh_worktop_3.receiveShadow = options.receiveShadow ?? true;
  mesh_worktop_3.userData.sculptComponent = {"id": "worktop", "name": "Black Operator Worktop", "level": "macro", "role": "work-surface", "importance": 0.9, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Independent glossy slab with rigid planar faces and projecting front edge.", "geometryDescriptor": {"topologyIntent": "thin beveled slab", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.018, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"}, "parent": "root", "attachment": {"parentSocket": "root-worktop", "contactType": "overlap", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.1], "embedDepth": 0.02, "overlap": 0.03, "gapTolerance": 0.008}, "dimensions": {"width": 1.32, "height": 0.06, "depth": 0.6, "units": "meters-approximate", "confidence": 0.7}, "transform": {"position": [0, 0.54, 0.44], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "worktop-glass", "materialLayers": ["worktop-glass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 23, 21, 1)", "secondaryAlbedo": "rgba(27, 36, 33, 1)", "materialClass": "glass", "materialClassConfidence": 0.76, "baseColor": "#111715", "roughness": 0.2, "metalness": 0.02, "clearcoat": 0.72, "finish": "gloss black worktop"}, "localFeatures": [], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "worktop-glass"}, "materialRegions": [{"regionId": "worktop-glass", "materialId": "worktop-glass", "profileId": "plastic.glossy", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\02-worktop-glass.png", "bbox": {"x": 520, "y": 950, "width": 200, "height": 190}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0441}}]};
  node_worktop_3.add(mesh_worktop_3);
  meshes["worktop"] = mesh_worktop_3;
  colliders["worktop"] = {};

  const endpoint_main_screen_4 = makeAttachmentEndpoint(null);
  const node_main_screen_4 = new THREE.Group();
  node_main_screen_4.name = "Main Touch Screen__pivot";
  node_main_screen_4.scale.set(1, 1, 1);
  if (endpoint_main_screen_4) {
    node_main_screen_4.position.copy(endpoint_main_screen_4.start);
    node_main_screen_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_main_screen_4.position.set(0.14, 0.01, 0.2);
    node_main_screen_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_main_screen_4.userData.sculptComponent = {"id": "main-screen", "name": "Main Touch Screen", "level": "macro", "role": "interactive-screen", "importance": 1.0, "confidence": 0.94, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid glass panel and bezel inset into the upper housing.", "parent": "upper-shell", "attachment": {"parentSocket": "upper-shell-screen", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.04], "embedDepth": 0.018, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.96, "height": 0.58, "depth": 0.035, "units": "meters-approximate", "confidence": 0.83}, "transform": {"position": [0.14, 0.01, 0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "screen-glass", "materialLayers": ["screen-glass", "dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 23, 22, 1)", "secondaryAlbedo": "rgba(22, 37, 34, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "baseColor": "#101716", "roughness": 0.16, "metalness": 0.0, "clearcoat": 0.9, "finish": "dark display glass"}, "localFeatures": [], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "screen-glass"}, "materialRegions": [{"regionId": "screen-glass", "materialId": "screen-glass", "profileId": "glass.clear", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\01-screen-glass.png", "bbox": {"x": 230, "y": 80, "width": 490, "height": 360}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.2048}}]};
  node_main_screen_4.userData.actionProfile = {};
  (nodes["upper-shell"] ?? root).add(node_main_screen_4);
  nodes["main-screen"] = node_main_screen_4;
  const mesh_main_screen_4Geometry = endpoint_main_screen_4
    ? new THREE.CylinderGeometry(endpoint_main_screen_4.endRadius, endpoint_main_screen_4.baseRadius, endpoint_main_screen_4.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_main_screen_4) {
    mesh_main_screen_4Geometry.scale(0.96, 0.58, 0.035);
  }
  const mesh_main_screen_4 = new THREE.Mesh(
    mesh_main_screen_4Geometry,
    materialMap["screen-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_screen_4.name = "Main Touch Screen";
  if (endpoint_main_screen_4) {
    mesh_main_screen_4.position.copy(endpoint_main_screen_4.midpoint);
    mesh_main_screen_4.quaternion.copy(endpoint_main_screen_4.quaternion);
  }
  mesh_main_screen_4.castShadow = options.castShadow ?? true;
  mesh_main_screen_4.receiveShadow = options.receiveShadow ?? true;
  mesh_main_screen_4.userData.sculptComponent = {"id": "main-screen", "name": "Main Touch Screen", "level": "macro", "role": "interactive-screen", "importance": 1.0, "confidence": 0.94, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid glass panel and bezel inset into the upper housing.", "parent": "upper-shell", "attachment": {"parentSocket": "upper-shell-screen", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.04], "embedDepth": 0.018, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.96, "height": 0.58, "depth": 0.035, "units": "meters-approximate", "confidence": 0.83}, "transform": {"position": [0.14, 0.01, 0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "screen-glass", "materialLayers": ["screen-glass", "dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 23, 22, 1)", "secondaryAlbedo": "rgba(22, 37, 34, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "baseColor": "#101716", "roughness": 0.16, "metalness": 0.0, "clearcoat": 0.9, "finish": "dark display glass"}, "localFeatures": [], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "screen-glass"}, "materialRegions": [{"regionId": "screen-glass", "materialId": "screen-glass", "profileId": "glass.clear", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\01-screen-glass.png", "bbox": {"x": 230, "y": 80, "width": 490, "height": 360}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.2048}}]};
  node_main_screen_4.add(mesh_main_screen_4);
  meshes["main-screen"] = mesh_main_screen_4;
  colliders["main-screen"] = {};

  const endpoint_recognition_bay_5 = makeAttachmentEndpoint(null);
  const node_recognition_bay_5 = new THREE.Group();
  node_recognition_bay_5.name = "Recognition Sensor Bay__pivot";
  node_recognition_bay_5.scale.set(1, 1, 1);
  if (endpoint_recognition_bay_5) {
    node_recognition_bay_5.position.copy(endpoint_recognition_bay_5.start);
    node_recognition_bay_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_recognition_bay_5.position.set(-0.48, 0.02, 0.22);
    node_recognition_bay_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_recognition_bay_5.userData.sculptComponent = {"id": "recognition-bay", "name": "Recognition Sensor Bay", "level": "meso", "role": "sensor-bay", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Tall rigid black module embedded behind the white front shell; low-poly approximation uses overlapping solids.", "parent": "upper-shell", "attachment": {"parentSocket": "upper-shell-sensor-bay", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.05], "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.005}, "dimensions": {"width": 0.19, "height": 0.55, "depth": 0.06, "units": "meters-approximate", "confidence": 0.76}, "transform": {"position": [-0.48, 0.02, 0.22], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(23, 29, 27, 1)", "secondaryAlbedo": "rgba(36, 44, 41, 1)", "materialClass": "plastic", "materialClassConfidence": 0.88, "baseColor": "#171D1B", "roughness": 0.48, "metalness": 0.0, "finish": "matte inset plastic"}, "localFeatures": [{"id": "recognition-bay.perimeter-channel", "kind": "groove", "depth": 0.02, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_recognition_bay_5.userData.actionProfile = {};
  (nodes["upper-shell"] ?? root).add(node_recognition_bay_5);
  nodes["recognition-bay"] = node_recognition_bay_5;
  const mesh_recognition_bay_5Geometry = endpoint_recognition_bay_5
    ? new THREE.CylinderGeometry(endpoint_recognition_bay_5.endRadius, endpoint_recognition_bay_5.baseRadius, endpoint_recognition_bay_5.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_recognition_bay_5) {
    mesh_recognition_bay_5Geometry.scale(0.19, 0.55, 0.06);
  }
  const mesh_recognition_bay_5 = new THREE.Mesh(
    mesh_recognition_bay_5Geometry,
    materialMap["dark-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_recognition_bay_5.name = "Recognition Sensor Bay";
  if (endpoint_recognition_bay_5) {
    mesh_recognition_bay_5.position.copy(endpoint_recognition_bay_5.midpoint);
    mesh_recognition_bay_5.quaternion.copy(endpoint_recognition_bay_5.quaternion);
  }
  mesh_recognition_bay_5.castShadow = options.castShadow ?? true;
  mesh_recognition_bay_5.receiveShadow = options.receiveShadow ?? true;
  mesh_recognition_bay_5.userData.sculptComponent = {"id": "recognition-bay", "name": "Recognition Sensor Bay", "level": "meso", "role": "sensor-bay", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Tall rigid black module embedded behind the white front shell; low-poly approximation uses overlapping solids.", "parent": "upper-shell", "attachment": {"parentSocket": "upper-shell-sensor-bay", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.05], "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.005}, "dimensions": {"width": 0.19, "height": 0.55, "depth": 0.06, "units": "meters-approximate", "confidence": 0.76}, "transform": {"position": [-0.48, 0.02, 0.22], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(23, 29, 27, 1)", "secondaryAlbedo": "rgba(36, 44, 41, 1)", "materialClass": "plastic", "materialClassConfidence": 0.88, "baseColor": "#171D1B", "roughness": 0.48, "metalness": 0.0, "finish": "matte inset plastic"}, "localFeatures": [{"id": "recognition-bay.perimeter-channel", "kind": "groove", "depth": 0.02, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_recognition_bay_5.add(mesh_recognition_bay_5);
  meshes["recognition-bay"] = mesh_recognition_bay_5;
  colliders["recognition-bay"] = {};

  const endpoint_recognition_arm_6 = makeAttachmentEndpoint(null);
  const node_recognition_arm_6 = new THREE.Group();
  node_recognition_arm_6.name = "Articulated Recognition Arm__pivot";
  node_recognition_arm_6.scale.set(1, 1, 1);
  if (endpoint_recognition_arm_6) {
    node_recognition_arm_6.position.copy(endpoint_recognition_arm_6.start);
    node_recognition_arm_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_recognition_arm_6.position.set(0.2, -0.05, 0.06);
    node_recognition_arm_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_recognition_arm_6.userData.sculptComponent = {"id": "recognition-arm", "name": "Articulated Recognition Arm", "level": "meso", "role": "articulated-sensor", "importance": 0.98, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid rectangular arm rotating from a cylindrical pivot socket.", "parent": "recognition-bay", "attachment": {"parentSocket": "recognition-bay-pivot", "contactType": "socket", "localStart": [0, 0, 0], "localEnd": [0.38, 0, 0], "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.006}, "dimensions": {"width": 0.42, "height": 0.055, "depth": 0.065, "units": "meters-approximate", "confidence": 0.74}, "transform": {"position": [0.2, -0.05, 0.06], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic", "metal-keyboard"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 33, 31, 1)", "secondaryAlbedo": "rgba(45, 53, 50, 1)", "materialClass": "plastic", "materialClassConfidence": 0.82, "baseColor": "#1B211F", "roughness": 0.42, "metalness": 0.08, "finish": "matte articulated arm"}, "localFeatures": [{"id": "recognition-arm.pivot-cap", "kind": "fastener", "shape": "cylinder", "count": 1, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_recognition_arm_6.userData.actionProfile = {};
  (nodes["recognition-bay"] ?? root).add(node_recognition_arm_6);
  nodes["recognition-arm"] = node_recognition_arm_6;
  const mesh_recognition_arm_6Geometry = endpoint_recognition_arm_6
    ? new THREE.CylinderGeometry(endpoint_recognition_arm_6.endRadius, endpoint_recognition_arm_6.baseRadius, endpoint_recognition_arm_6.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_recognition_arm_6) {
    mesh_recognition_arm_6Geometry.scale(0.42, 0.055, 0.065);
  }
  const mesh_recognition_arm_6 = new THREE.Mesh(
    mesh_recognition_arm_6Geometry,
    materialMap["dark-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_recognition_arm_6.name = "Articulated Recognition Arm";
  if (endpoint_recognition_arm_6) {
    mesh_recognition_arm_6.position.copy(endpoint_recognition_arm_6.midpoint);
    mesh_recognition_arm_6.quaternion.copy(endpoint_recognition_arm_6.quaternion);
  }
  mesh_recognition_arm_6.castShadow = options.castShadow ?? true;
  mesh_recognition_arm_6.receiveShadow = options.receiveShadow ?? true;
  mesh_recognition_arm_6.userData.sculptComponent = {"id": "recognition-arm", "name": "Articulated Recognition Arm", "level": "meso", "role": "articulated-sensor", "importance": 0.98, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid rectangular arm rotating from a cylindrical pivot socket.", "parent": "recognition-bay", "attachment": {"parentSocket": "recognition-bay-pivot", "contactType": "socket", "localStart": [0, 0, 0], "localEnd": [0.38, 0, 0], "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.006}, "dimensions": {"width": 0.42, "height": 0.055, "depth": 0.065, "units": "meters-approximate", "confidence": 0.74}, "transform": {"position": [0.2, -0.05, 0.06], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic", "metal-keyboard"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 33, 31, 1)", "secondaryAlbedo": "rgba(45, 53, 50, 1)", "materialClass": "plastic", "materialClassConfidence": 0.82, "baseColor": "#1B211F", "roughness": 0.42, "metalness": 0.08, "finish": "matte articulated arm"}, "localFeatures": [{"id": "recognition-arm.pivot-cap", "kind": "fastener", "shape": "cylinder", "count": 1, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_recognition_arm_6.add(mesh_recognition_arm_6);
  meshes["recognition-arm"] = mesh_recognition_arm_6;
  colliders["recognition-arm"] = {};

  const endpoint_card_reader_7 = makeAttachmentEndpoint(null);
  const node_card_reader_7 = new THREE.Group();
  node_card_reader_7.name = "Dual Card Reader Module__pivot";
  node_card_reader_7.scale.set(1, 1, 1);
  if (endpoint_card_reader_7) {
    node_card_reader_7.position.copy(endpoint_card_reader_7.start);
    node_card_reader_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_card_reader_7.position.set(0.26, -0.12, 0.38);
    node_card_reader_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_card_reader_7.userData.sculptComponent = {"id": "card-reader", "name": "Dual Card Reader Module", "level": "meso", "role": "interactive-card-reader", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid black inset module with two recessed slot openings.", "parent": "root", "attachment": {"parentSocket": "root-card-reader", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.06], "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.055, "units": "meters-approximate", "confidence": 0.82}, "transform": {"position": [0.26, -0.12, 0.38], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 23, 22, 1)", "secondaryAlbedo": "rgba(34, 43, 40, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "baseColor": "#111716", "roughness": 0.4, "metalness": 0.0, "finish": "dark molded card reader"}, "localFeatures": [{"id": "card-reader.slot-pair", "kind": "hole", "count": 2, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "dark-plastic"}, "materialRegions": [{"regionId": "dark-plastic", "materialId": "dark-plastic", "profileId": "plastic.matte", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\04-dark-plastic.png", "bbox": {"x": 345, "y": 455, "width": 265, "height": 150}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0461}}]};
  node_card_reader_7.userData.actionProfile = {};
  (nodes["root"] ?? root).add(node_card_reader_7);
  nodes["card-reader"] = node_card_reader_7;
  const mesh_card_reader_7Geometry = endpoint_card_reader_7
    ? new THREE.CylinderGeometry(endpoint_card_reader_7.endRadius, endpoint_card_reader_7.baseRadius, endpoint_card_reader_7.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_card_reader_7) {
    mesh_card_reader_7Geometry.scale(0.42, 0.14, 0.055);
  }
  const mesh_card_reader_7 = new THREE.Mesh(
    mesh_card_reader_7Geometry,
    materialMap["dark-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_card_reader_7.name = "Dual Card Reader Module";
  if (endpoint_card_reader_7) {
    mesh_card_reader_7.position.copy(endpoint_card_reader_7.midpoint);
    mesh_card_reader_7.quaternion.copy(endpoint_card_reader_7.quaternion);
  }
  mesh_card_reader_7.castShadow = options.castShadow ?? true;
  mesh_card_reader_7.receiveShadow = options.receiveShadow ?? true;
  mesh_card_reader_7.userData.sculptComponent = {"id": "card-reader", "name": "Dual Card Reader Module", "level": "meso", "role": "interactive-card-reader", "importance": 0.9, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid black inset module with two recessed slot openings.", "parent": "root", "attachment": {"parentSocket": "root-card-reader", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.06], "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.055, "units": "meters-approximate", "confidence": 0.82}, "transform": {"position": [0.26, -0.12, 0.38], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 23, 22, 1)", "secondaryAlbedo": "rgba(34, 43, 40, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "baseColor": "#111716", "roughness": 0.4, "metalness": 0.0, "finish": "dark molded card reader"}, "localFeatures": [{"id": "card-reader.slot-pair", "kind": "hole", "count": 2, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "dark-plastic"}, "materialRegions": [{"regionId": "dark-plastic", "materialId": "dark-plastic", "profileId": "plastic.matte", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\04-dark-plastic.png", "bbox": {"x": 345, "y": 455, "width": 265, "height": 150}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0461}}]};
  node_card_reader_7.add(mesh_card_reader_7);
  meshes["card-reader"] = mesh_card_reader_7;
  colliders["card-reader"] = {};

  const attachment_blue_connectors_8 = {"parentSocket": "fascia-blue-connectors", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.06], "embedDepth": 0.018, "overlap": 0.02, "gapTolerance": 0.006};
  const endpoint_blue_connectors_8 = makeAttachmentEndpoint(attachment_blue_connectors_8);
  const node_blue_connectors_8 = new THREE.Group();
  node_blue_connectors_8.name = "Blue Industrial Connector Pair__pivot";
  node_blue_connectors_8.scale.set(1, 1, 1);
  if (endpoint_blue_connectors_8) {
    node_blue_connectors_8.position.copy(endpoint_blue_connectors_8.start);
    node_blue_connectors_8.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_blue_connectors_8.position.set(0.14, 0.0, 0.08);
    node_blue_connectors_8.rotation.set(1.5708, 0.0, 0.0);
  }
  node_blue_connectors_8.userData.sculptComponent = {"id": "blue-connectors", "name": "Blue Industrial Connector Pair", "level": "meso", "role": "connector-pair", "importance": 0.78, "confidence": 0.91, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Two rigid cylindrical caps mounted to square bases.", "parent": "interface-fascia", "attachment": {"parentSocket": "fascia-blue-connectors", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.06], "embedDepth": 0.018, "overlap": 0.02, "gapTolerance": 0.006}, "dimensions": {"width": 0.26, "height": 0.1, "depth": 0.08, "units": "meters-approximate", "confidence": 0.8}, "transform": {"position": [0.14, 0, 0.08], "rotation": [1.5708, 0, 0], "scale": [1, 1, 1]}, "material": "blue-plastic", "materialLayers": ["blue-plastic", "metal-keyboard"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(21, 148, 181, 1)", "secondaryAlbedo": "rgba(8, 123, 154, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "baseColor": "#1594B5", "roughness": 0.46, "metalness": 0.0, "finish": "cyan-blue molded caps"}, "localFeatures": [{"id": "blue-connectors.radial-grip-ribs", "kind": "ridge", "count": 12, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "blue-plastic"}, "materialRegions": [{"regionId": "blue-plastic", "materialId": "blue-plastic", "profileId": "plastic.matte", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\05-blue-plastic.png", "bbox": {"x": 300, "y": 610, "width": 210, "height": 170}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0414}}]};
  node_blue_connectors_8.userData.actionProfile = {};
  (nodes["interface-fascia"] ?? root).add(node_blue_connectors_8);
  nodes["blue-connectors"] = node_blue_connectors_8;
  const mesh_blue_connectors_8Geometry = endpoint_blue_connectors_8
    ? new THREE.CylinderGeometry(endpoint_blue_connectors_8.endRadius, endpoint_blue_connectors_8.baseRadius, endpoint_blue_connectors_8.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_blue_connectors_8) {
    mesh_blue_connectors_8Geometry.scale(0.26, 0.1, 0.08);
  }
  const mesh_blue_connectors_8 = new THREE.Mesh(
    mesh_blue_connectors_8Geometry,
    materialMap["blue-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_blue_connectors_8.name = "Blue Industrial Connector Pair";
  if (endpoint_blue_connectors_8) {
    mesh_blue_connectors_8.position.copy(endpoint_blue_connectors_8.midpoint);
    mesh_blue_connectors_8.quaternion.copy(endpoint_blue_connectors_8.quaternion);
  }
  mesh_blue_connectors_8.castShadow = options.castShadow ?? true;
  mesh_blue_connectors_8.receiveShadow = options.receiveShadow ?? true;
  mesh_blue_connectors_8.userData.sculptComponent = {"id": "blue-connectors", "name": "Blue Industrial Connector Pair", "level": "meso", "role": "connector-pair", "importance": 0.78, "confidence": 0.91, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Two rigid cylindrical caps mounted to square bases.", "parent": "interface-fascia", "attachment": {"parentSocket": "fascia-blue-connectors", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.06], "embedDepth": 0.018, "overlap": 0.02, "gapTolerance": 0.006}, "dimensions": {"width": 0.26, "height": 0.1, "depth": 0.08, "units": "meters-approximate", "confidence": 0.8}, "transform": {"position": [0.14, 0, 0.08], "rotation": [1.5708, 0, 0], "scale": [1, 1, 1]}, "material": "blue-plastic", "materialLayers": ["blue-plastic", "metal-keyboard"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(21, 148, 181, 1)", "secondaryAlbedo": "rgba(8, 123, 154, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "baseColor": "#1594B5", "roughness": 0.46, "metalness": 0.0, "finish": "cyan-blue molded caps"}, "localFeatures": [{"id": "blue-connectors.radial-grip-ribs", "kind": "ridge", "count": 12, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "blue-plastic"}, "materialRegions": [{"regionId": "blue-plastic", "materialId": "blue-plastic", "profileId": "plastic.matte", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\05-blue-plastic.png", "bbox": {"x": 300, "y": 610, "width": 210, "height": 170}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.0414}}]};
  node_blue_connectors_8.add(mesh_blue_connectors_8);
  meshes["blue-connectors"] = mesh_blue_connectors_8;
  colliders["blue-connectors"] = {};

  const endpoint_top_camera_9 = makeAttachmentEndpoint(null);
  const node_top_camera_9 = new THREE.Group();
  node_top_camera_9.name = "Top Camera Housing__pivot";
  node_top_camera_9.scale.set(1, 1, 1);
  if (endpoint_top_camera_9) {
    node_top_camera_9.position.copy(endpoint_top_camera_9.start);
    node_top_camera_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_top_camera_9.position.set(0.12, 0.46, -0.03);
    node_top_camera_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_top_camera_9.userData.sculptComponent = {"id": "top-camera", "name": "Top Camera Housing", "level": "meso", "role": "camera", "importance": 0.72, "confidence": 0.78, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small rigid rounded housing mounted on top of the shell.", "parent": "upper-shell", "attachment": {"parentSocket": "upper-shell-top", "contactType": "butt", "localStart": [0, 0, 0], "localEnd": [0, 0.05, 0], "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.006}, "dimensions": {"width": 0.15, "height": 0.055, "depth": 0.06, "units": "meters-approximate", "confidence": 0.7}, "transform": {"position": [0.12, 0.46, -0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic", "screen-glass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(23, 28, 27, 1)", "secondaryAlbedo": "rgba(37, 44, 42, 1)", "materialClass": "plastic", "materialClassConfidence": 0.84, "baseColor": "#171C1B", "roughness": 0.38, "metalness": 0.0, "finish": "matte camera housing"}, "localFeatures": [{"id": "top-camera.lens-cavity", "kind": "hole", "depth": 0.012, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_top_camera_9.userData.actionProfile = {};
  (nodes["upper-shell"] ?? root).add(node_top_camera_9);
  nodes["top-camera"] = node_top_camera_9;
  const mesh_top_camera_9Geometry = endpoint_top_camera_9
    ? new THREE.CylinderGeometry(endpoint_top_camera_9.endRadius, endpoint_top_camera_9.baseRadius, endpoint_top_camera_9.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_top_camera_9) {
    mesh_top_camera_9Geometry.scale(0.15, 0.055, 0.06);
  }
  const mesh_top_camera_9 = new THREE.Mesh(
    mesh_top_camera_9Geometry,
    materialMap["dark-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_top_camera_9.name = "Top Camera Housing";
  if (endpoint_top_camera_9) {
    mesh_top_camera_9.position.copy(endpoint_top_camera_9.midpoint);
    mesh_top_camera_9.quaternion.copy(endpoint_top_camera_9.quaternion);
  }
  mesh_top_camera_9.castShadow = options.castShadow ?? true;
  mesh_top_camera_9.receiveShadow = options.receiveShadow ?? true;
  mesh_top_camera_9.userData.sculptComponent = {"id": "top-camera", "name": "Top Camera Housing", "level": "meso", "role": "camera", "importance": 0.72, "confidence": 0.78, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Small rigid rounded housing mounted on top of the shell.", "parent": "upper-shell", "attachment": {"parentSocket": "upper-shell-top", "contactType": "butt", "localStart": [0, 0, 0], "localEnd": [0, 0.05, 0], "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.006}, "dimensions": {"width": 0.15, "height": 0.055, "depth": 0.06, "units": "meters-approximate", "confidence": 0.7}, "transform": {"position": [0.12, 0.46, -0.03], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic", "screen-glass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(23, 28, 27, 1)", "secondaryAlbedo": "rgba(37, 44, 42, 1)", "materialClass": "plastic", "materialClassConfidence": 0.84, "baseColor": "#171C1B", "roughness": 0.38, "metalness": 0.0, "finish": "matte camera housing"}, "localFeatures": [{"id": "top-camera.lens-cavity", "kind": "hole", "depth": 0.012, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_top_camera_9.add(mesh_top_camera_9);
  meshes["top-camera"] = mesh_top_camera_9;
  colliders["top-camera"] = {};

  const endpoint_keyboard_10 = makeAttachmentEndpoint(null);
  const node_keyboard_10 = new THREE.Group();
  node_keyboard_10.name = "Metal Keyboard__pivot";
  node_keyboard_10.scale.set(1, 1, 1);
  if (endpoint_keyboard_10) {
    node_keyboard_10.position.copy(endpoint_keyboard_10.start);
    node_keyboard_10.rotation.set(0.0, 0.04, 0.0);
  } else {
    node_keyboard_10.position.set(-0.18, 0.05, 0.02);
    node_keyboard_10.rotation.set(0.0, 0.04, 0.0);
  }
  node_keyboard_10.userData.sculptComponent = {"id": "keyboard", "name": "Metal Keyboard", "level": "meso", "role": "interactive-keyboard", "importance": 0.86, "confidence": 0.93, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin rigid keyboard tray with repeated raised keycaps.", "parent": "worktop", "attachment": {"parentSocket": "worktop-keyboard", "contactType": "butt", "localStart": [0, 0, 0], "localEnd": [0, 0.03, 0], "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.008}, "dimensions": {"width": 0.72, "height": 0.03, "depth": 0.24, "units": "meters-approximate", "confidence": 0.78}, "transform": {"position": [-0.18, 0.05, 0.02], "rotation": [0, 0.04, 0], "scale": [1, 1, 1]}, "material": "metal-keyboard", "materialLayers": ["metal-keyboard", "dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 159, 156, 1)", "secondaryAlbedo": "rgba(116, 122, 119, 1)", "materialClass": "metal", "materialClassConfidence": 0.86, "baseColor": "#9B9F9C", "roughness": 0.35, "metalness": 0.55, "finish": "brushed metal keyboard"}, "localFeatures": [{"id": "keyboard.keycap-grid", "kind": "fastener", "count": 84, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "metal-keyboard"}, "materialRegions": [{"regionId": "metal-keyboard", "materialId": "metal-keyboard", "profileId": "metal.steel-brushed", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\06-metal-keyboard.png", "bbox": {"x": 100, "y": 805, "width": 470, "height": 250}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.1364}}]};
  node_keyboard_10.userData.actionProfile = {};
  (nodes["worktop"] ?? root).add(node_keyboard_10);
  nodes["keyboard"] = node_keyboard_10;
  const mesh_keyboard_10Geometry = endpoint_keyboard_10
    ? new THREE.CylinderGeometry(endpoint_keyboard_10.endRadius, endpoint_keyboard_10.baseRadius, endpoint_keyboard_10.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_keyboard_10) {
    mesh_keyboard_10Geometry.scale(0.72, 0.03, 0.24);
  }
  const mesh_keyboard_10 = new THREE.Mesh(
    mesh_keyboard_10Geometry,
    materialMap["metal-keyboard"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_keyboard_10.name = "Metal Keyboard";
  if (endpoint_keyboard_10) {
    mesh_keyboard_10.position.copy(endpoint_keyboard_10.midpoint);
    mesh_keyboard_10.quaternion.copy(endpoint_keyboard_10.quaternion);
  }
  mesh_keyboard_10.castShadow = options.castShadow ?? true;
  mesh_keyboard_10.receiveShadow = options.receiveShadow ?? true;
  mesh_keyboard_10.userData.sculptComponent = {"id": "keyboard", "name": "Metal Keyboard", "level": "meso", "role": "interactive-keyboard", "importance": 0.86, "confidence": 0.93, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin rigid keyboard tray with repeated raised keycaps.", "parent": "worktop", "attachment": {"parentSocket": "worktop-keyboard", "contactType": "butt", "localStart": [0, 0, 0], "localEnd": [0, 0.03, 0], "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.008}, "dimensions": {"width": 0.72, "height": 0.03, "depth": 0.24, "units": "meters-approximate", "confidence": 0.78}, "transform": {"position": [-0.18, 0.05, 0.02], "rotation": [0, 0.04, 0], "scale": [1, 1, 1]}, "material": "metal-keyboard", "materialLayers": ["metal-keyboard", "dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 159, 156, 1)", "secondaryAlbedo": "rgba(116, 122, 119, 1)", "materialClass": "metal", "materialClassConfidence": 0.86, "baseColor": "#9B9F9C", "roughness": 0.35, "metalness": 0.55, "finish": "brushed metal keyboard"}, "localFeatures": [{"id": "keyboard.keycap-grid", "kind": "fastener", "count": 84, "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "metal-keyboard"}, "materialRegions": [{"regionId": "metal-keyboard", "materialId": "metal-keyboard", "profileId": "metal.steel-brushed", "crop": {"path": "E:\\100-工作\\110-课程建设\\crew-training-3d\\evidence\\attendance-kiosk\\materials\\06-metal-keyboard.png", "bbox": {"x": 100, "y": 805, "width": 470, "height": 250}, "sourceWidth": 730, "sourceHeight": 1180, "loaderWarnings": [], "coverage": 0.1364}}]};
  node_keyboard_10.add(mesh_keyboard_10);
  meshes["keyboard"] = mesh_keyboard_10;
  colliders["keyboard"] = {};

  const endpoint_fingerprint_pad_11 = makeAttachmentEndpoint(null);
  const node_fingerprint_pad_11 = new THREE.Group();
  node_fingerprint_pad_11.name = "Fingerprint Interaction Pad__pivot";
  node_fingerprint_pad_11.scale.set(1, 1, 1);
  if (endpoint_fingerprint_pad_11) {
    node_fingerprint_pad_11.position.copy(endpoint_fingerprint_pad_11.start);
    node_fingerprint_pad_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fingerprint_pad_11.position.set(0.46, 0.045, 0.1);
    node_fingerprint_pad_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_fingerprint_pad_11.userData.sculptComponent = {"id": "fingerprint-pad", "name": "Fingerprint Interaction Pad", "level": "meso", "role": "interactive-fingerprint", "importance": 0.72, "confidence": 0.74, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Thin carrier patch on the worktop for a sensing and semantic decal region.", "parent": "worktop", "attachment": {"parentSocket": "worktop-fingerprint", "contactType": "butt", "localStart": [0, 0, 0], "localEnd": [0, 0.01, 0], "embedDepth": 0.005, "overlap": 0.005, "gapTolerance": 0.004}, "dimensions": {"width": 0.16, "height": 0.008, "depth": 0.12, "units": "meters-approximate", "confidence": 0.66}, "transform": {"position": [0.46, 0.045, 0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(21, 32, 29, 1)", "secondaryAlbedo": "rgba(32, 47, 42, 1)", "materialClass": "plastic", "materialClassConfidence": 0.64, "baseColor": "#15201D", "roughness": 0.35, "metalness": 0.0, "finish": "dark sensor patch"}, "localFeatures": [{"id": "fingerprint-pad.semantic-label", "kind": "decal", "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_fingerprint_pad_11.userData.actionProfile = {};
  (nodes["worktop"] ?? root).add(node_fingerprint_pad_11);
  nodes["fingerprint-pad"] = node_fingerprint_pad_11;
  const mesh_fingerprint_pad_11Geometry = endpoint_fingerprint_pad_11
    ? new THREE.CylinderGeometry(endpoint_fingerprint_pad_11.endRadius, endpoint_fingerprint_pad_11.baseRadius, endpoint_fingerprint_pad_11.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_fingerprint_pad_11) {
    mesh_fingerprint_pad_11Geometry.scale(0.16, 0.008, 0.12);
  }
  const mesh_fingerprint_pad_11 = new THREE.Mesh(
    mesh_fingerprint_pad_11Geometry,
    materialMap["dark-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fingerprint_pad_11.name = "Fingerprint Interaction Pad";
  if (endpoint_fingerprint_pad_11) {
    mesh_fingerprint_pad_11.position.copy(endpoint_fingerprint_pad_11.midpoint);
    mesh_fingerprint_pad_11.quaternion.copy(endpoint_fingerprint_pad_11.quaternion);
  }
  mesh_fingerprint_pad_11.castShadow = options.castShadow ?? true;
  mesh_fingerprint_pad_11.receiveShadow = options.receiveShadow ?? true;
  mesh_fingerprint_pad_11.userData.sculptComponent = {"id": "fingerprint-pad", "name": "Fingerprint Interaction Pad", "level": "meso", "role": "interactive-fingerprint", "importance": 0.72, "confidence": 0.74, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Thin carrier patch on the worktop for a sensing and semantic decal region.", "parent": "worktop", "attachment": {"parentSocket": "worktop-fingerprint", "contactType": "butt", "localStart": [0, 0, 0], "localEnd": [0, 0.01, 0], "embedDepth": 0.005, "overlap": 0.005, "gapTolerance": 0.004}, "dimensions": {"width": 0.16, "height": 0.008, "depth": 0.12, "units": "meters-approximate", "confidence": 0.66}, "transform": {"position": [0.46, 0.045, 0.1], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "dark-plastic", "materialLayers": ["dark-plastic"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(21, 32, 29, 1)", "secondaryAlbedo": "rgba(32, 47, 42, 1)", "materialClass": "plastic", "materialClassConfidence": 0.64, "baseColor": "#15201D", "roughness": 0.35, "metalness": 0.0, "finish": "dark sensor patch"}, "localFeatures": [{"id": "fingerprint-pad.semantic-label", "kind": "decal", "evidenceRefs": ["full-object"]}], "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_fingerprint_pad_11.add(mesh_fingerprint_pad_11);
  meshes["fingerprint-pad"] = mesh_fingerprint_pad_11;
  colliders["fingerprint-pad"] = {};
  // repetition system "vent-perforation-system" describes 1 parts that are already built individually; not instanced.
  // repetition system "keyboard-keycap-system" describes 1 parts that are already built individually; not instanced.
  // repetition system "connector-rib-system" describes 1 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createRailwayAttendanceKioskLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Railway Attendance Kiosk look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "large overhead area light", "direction": [-0.35, 0.82, 0.45], "color": "#FFF1D8", "intensity": 2.2, "evidence": "bright ceiling reflections on screen and shell"}, {"id": "fill", "type": "window diffuse fill", "direction": [0.55, 0.4, 0.25], "color": "#E8F1FF", "intensity": 0.65, "evidence": "soft lifted shadows on interface fascia"}, {"id": "environment", "type": "bright indoor room reflection", "direction": [0, 1, 0], "color": "#F4F0E7", "intensity": 0.8, "evidence": "broad screen and worktop reflections"}, {"id": "contact", "type": "soft contact shadow", "direction": [0, -1, 0], "color": "#29302E", "intensity": 0.45, "evidence": "component intersections and worktop contacts"}, {"id": "render-intent", "type": "renderer settings", "exposure": 1.05, "toneMapping": "ACESFilmicToneMapping", "background": "#E7E4DC", "shadowSoftness": 0.55, "evidence": "bright indoor value range with preserved screen highlights"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createRailwayAttendanceKioskEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameRailwayAttendanceKioskCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createRailwayAttendanceKioskPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureRailwayAttendanceKioskRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createRailwayAttendanceKioskInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
