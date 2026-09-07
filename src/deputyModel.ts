import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

/**
 * 副司机（坐姿）GLB 替换模块 —— 独立于 sceneEnvironment.createSeatedDeputy 的迭代版本。
 *
 * 源模型 68f3392060f7fc34fd32bcde6168415d.glb（75.88 MB）经两步压缩后为 6.23 MB：
 *   1) gltf-transform optimize --simplify false --compress draco
 *      → 几何做 Draco 量化编码，顶点拓扑与形状不变（79.56 MB → 37.66 MB）
 *   2) tools/retexture_webp.py
 *      → 三张 4096×4096 贴图由 PNG 转 WebP(q95)，分辨率不变（32.27 MB → 2.58 MB）
 *
 * 之所以需要 DRACOLoader：压缩后文件声明了 KHR_draco_mesh_compression。
 * 解码器自托管在 public/assets/libs/draco/，离线可用，不依赖 Google CDN。
 */

const assetUrl = (path: string) => `${import.meta.env.BASE_URL}assets/${path}`;

export type DeputyVariant = 'lite' | '4k' | '2k' | 'proc';

export type DeputyTuning = {
  /** 4k = 4096 贴图保真版；2k = 2048 贴图轻量版；proc = 回退到原程序化占位人物 */
  variant: DeputyVariant;
  /** max = 按最长边归一化；y = 按高度归一化 */
  fit: 'max' | 'y';
  /** 归一化目标尺寸（米） */
  extent: number;
  /** 归一化之后的额外倍率 */
  scale: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** 相对原副司机坐标的偏移（米） */
  offset: [number, number, number];
};

export type DeputyModel = {
  root: THREE.Group;
  inner: THREE.Group;
  /** 归一化之前的原始包围盒尺寸 */
  size: THREE.Vector3;
  baseScale: number;
};

export const DEPUTY_DEFAULT_TUNING: DeputyTuning = {
  variant: 'lite',
  fit: 'max',
  extent: 1.3,
  // 已按现场调参结果固化。
  scale: 1.09,
  // 模型坐姿正面朝向玩家。曾设为 180 导致坐反，改回 0。
  yaw: 0,
  pitch: 0,
  roll: 0,
  // 微笑版方哥是坐姿扫描：脚 y=0、臀（坐骨）y≈0.45、头顶 y≈1.0。
  // 已按现场调参结果固化：X=-0.10、Y=0.14、Z=0.37。
  offset: [-0.10, 0.14, 0.37],
};

const VARIANT_FILE: Record<Exclude<DeputyVariant, 'proc'>, string> = {
  lite: 'models/characters/assistant-driver-fangge.glb',
  '4k': 'models/characters/assistant-driver-uploaded.glb',
  '2k': 'models/characters/assistant-driver-2k.glb',
};

function numberParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function readDeputyTuning(): DeputyTuning {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('dep');
  const variant: DeputyVariant =
    raw === 'proc' ? 'proc'
    : raw === '2k' ? '2k'
    : raw === '4k' ? '4k'
    : 'lite';

  // 只有明确带 depApply=1 时才应用 URL 里的位置/缩放参数。
  // 这样旧地址栏里残留的 depY/depZ/depScale 不会继续覆盖代码中的新默认值。
  // ?dep=2k / ?dep=4k / ?dep=proc 仍可单独切换模型版本。
  const applyQueryTuning = params.get('depApply') === '1';

  if (!applyQueryTuning) {
    return {
      ...DEPUTY_DEFAULT_TUNING,
      variant,
      offset: [...DEPUTY_DEFAULT_TUNING.offset] as [number, number, number],
    };
  }

  return {
    ...DEPUTY_DEFAULT_TUNING,
    variant,
    fit: params.get('depFit') === 'y' ? 'y' : DEPUTY_DEFAULT_TUNING.fit,
    extent: numberParam(params, 'depExtent', DEPUTY_DEFAULT_TUNING.extent),
    scale: numberParam(params, 'depScale', DEPUTY_DEFAULT_TUNING.scale),
    yaw: numberParam(params, 'depYaw', DEPUTY_DEFAULT_TUNING.yaw),
    pitch: numberParam(params, 'depPitch', DEPUTY_DEFAULT_TUNING.pitch),
    roll: numberParam(params, 'depRoll', DEPUTY_DEFAULT_TUNING.roll),
    offset: [
      numberParam(params, 'depX', DEPUTY_DEFAULT_TUNING.offset[0]),
      numberParam(params, 'depY', DEPUTY_DEFAULT_TUNING.offset[1]),
      numberParam(params, 'depZ', DEPUTY_DEFAULT_TUNING.offset[2]),
    ],
  };
}

export function tuningToQuery(tuning: DeputyTuning): string {
  const parts = [
    // 新复制出的调参 URL 明确声明要应用这些参数；旧 URL 没有 depApply=1 时不会覆盖默认值。
    'depTune=1',
    'depApply=1',
    `dep=${tuning.variant}`,
    `depFit=${tuning.fit}`,
    `depExtent=${tuning.extent.toFixed(3)}`,
    `depScale=${tuning.scale.toFixed(3)}`,
    `depYaw=${tuning.yaw.toFixed(1)}`,
    `depPitch=${tuning.pitch.toFixed(1)}`,
    `depRoll=${tuning.roll.toFixed(1)}`,
    `depX=${tuning.offset[0].toFixed(3)}`,
    `depY=${tuning.offset[1].toFixed(3)}`,
    `depZ=${tuning.offset[2].toFixed(3)}`,
  ];
  return parts.join('&');
}

let sharedLoader: GLTFLoader | null = null;

function deputyLoader(): GLTFLoader {
  if (sharedLoader) return sharedLoader;
  sharedLoader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(`${import.meta.env.BASE_URL}assets/libs/draco/`);
  sharedLoader.setDRACOLoader(draco);
  return sharedLoader;
}

/** 返回 null 表示继续沿用程序化占位人物。 */
export async function loadAssistantDriverModel(
  tuning: DeputyTuning = DEPUTY_DEFAULT_TUNING,
): Promise<DeputyModel | null> {
  if (tuning.variant === 'proc') return null;
  const gltf = await deputyLoader().loadAsync(assetUrl(VARIANT_FILE[tuning.variant]));
  const source = gltf.scene;
  source.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(source);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const reference = tuning.fit === 'y' ? size.y : Math.max(size.x, size.y, size.z);
  const baseScale = tuning.extent / Math.max(reference, 1e-3);

  // 归一化：水平居中 + 底面贴地（y=0），让 root 层只负责倍率与朝向。
  source.scale.setScalar(baseScale);
  source.position.set(-center.x * baseScale, -bounds.min.y * baseScale, -center.z * baseScale);
  source.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // Imported GLBs can carry stale bounds after normalization. Recompute them
    // and keep the character visible even when the mobile camera clips close
    // to the desk during the first-person approach.
    object.geometry.computeBoundingBox();
    object.geometry.computeBoundingSphere();
    object.castShadow = false;
    object.receiveShadow = false;
    object.frustumCulled = false;
  });

  const inner = new THREE.Group();
  inner.name = '副司机GLB·归一化层';
  inner.add(source);

  const root = new THREE.Group();
  root.name = '副司机（坐姿·GLB替换）';
  root.userData.interactionLabel = '副司机：配合填写司机手帐与出乘预想';
  root.add(inner);

  return { root, inner, size, baseScale };
}

export function applyDeputyTuning(
  model: DeputyModel,
  tuning: DeputyTuning,
  base: THREE.Vector3,
): void {
  const { root } = model;

  // extent 原先只在模型加载时参与一次 baseScale 计算，调参面板里拖动 extent 看起来“没有变化”。
  // 这里根据原始包围盒重新计算目标归一化倍率，再与加载时的 baseScale 求比值，
  // 因此无需重新加载 GLB，extent 也能实时生效。
  const reference = tuning.fit === 'y'
    ? model.size.y
    : Math.max(model.size.x, model.size.y, model.size.z);
  const desiredBaseScale = tuning.extent / Math.max(reference, 1e-3);
  const normalizationRatio = desiredBaseScale / Math.max(model.baseScale, 1e-6);

  root.scale.setScalar(tuning.scale * normalizationRatio);
  root.rotation.set(
    THREE.MathUtils.degToRad(tuning.pitch),
    THREE.MathUtils.degToRad(tuning.yaw),
    THREE.MathUtils.degToRad(tuning.roll),
  );
  root.position.set(
    base.x + tuning.offset[0],
    base.y + tuning.offset[1],
    base.z + tuning.offset[2],
  );
  root.updateMatrixWorld(true);
}

type SliderSpec = {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (value: number) => void;
};

/**
 * 可选的实时调参面板（?depTune=1 打开）。
 * 作用只是把当前参数拼成可复制的 URL，方便把满意的值固化进 DEPUTY_DEFAULT_TUNING。
 */
export function mountDeputyTuner(
  model: DeputyModel,
  tuning: DeputyTuning,
  base: THREE.Vector3,
): void {
  const panel = document.createElement('div');
  panel.id = 'deputy-tuner';
  panel.style.cssText = [
    'position:fixed',
    'left:16px',
    'bottom:16px',
    'z-index:9999',
    'width:290px',
    'padding:12px 14px',
    'border-radius:10px',
    'background:rgba(8,18,30,.92)',
    'border:1px solid rgba(120,190,255,.35)',
    'color:#dceaff',
    'font:12px/1.5 "Microsoft YaHei UI",system-ui,sans-serif',
    'box-shadow:0 8px 28px rgba(0,0,0,.45)',
  ].join(';');

  const size = model.size;
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;margin-bottom:6px;color:#7cc8ff';
  title.textContent = '副司机 GLB 调参面板';
  panel.appendChild(title);

  const meta = document.createElement('div');
  meta.style.cssText = 'margin-bottom:8px;opacity:.72;font-size:11px';
  meta.textContent = `原始包围盒 X ${size.x.toFixed(3)} / Y ${size.y.toFixed(3)} / Z ${size.z.toFixed(3)} m · 基础缩放 ${model.baseScale.toFixed(3)}`;
  panel.appendChild(meta);

  const readout = document.createElement('input');
  readout.readOnly = true;
  readout.style.cssText =
    'width:100%;margin-top:8px;padding:5px 6px;border-radius:6px;border:1px solid rgba(120,190,255,.3);background:#081420;color:#8fd2ff;font-size:11px';
  panel.appendChild(readout);

  const refresh = (): void => {
    applyDeputyTuning(model, tuning, base);
    readout.value = `?${tuningToQuery(tuning)}`;
  };

  const slider = (spec: SliderSpec): void => {
    const row = document.createElement('label');
    row.style.cssText = 'display:block;margin:7px 0 2px';
    const caption = document.createElement('span');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(spec.get());
    input.style.cssText = 'width:100%';
    const sync = (): void => {
      caption.textContent = `${spec.label}：${Number(input.value).toFixed(3)}`;
    };
    input.addEventListener('input', () => {
      spec.set(Number(input.value));
      sync();
      refresh();
    });
    sync();
    row.appendChild(caption);
    row.appendChild(input);
    panel.appendChild(row);
  };

  slider({ label: '整体倍率 scale', min: 0.2, max: 3, step: 0.01, get: () => tuning.scale, set: (v) => { tuning.scale = v; } });
  slider({ label: '归一化尺寸 extent(m)', min: 0.5, max: 3, step: 0.01, get: () => tuning.extent, set: (v) => { tuning.extent = v; } });
  slider({ label: '朝向 yaw(°)', min: -180, max: 180, step: 1, get: () => tuning.yaw, set: (v) => { tuning.yaw = v; } });
  slider({ label: '俯仰 pitch(°)', min: -90, max: 90, step: 1, get: () => tuning.pitch, set: (v) => { tuning.pitch = v; } });
  slider({ label: '翻滚 roll(°)', min: -90, max: 90, step: 1, get: () => tuning.roll, set: (v) => { tuning.roll = v; } });
  slider({ label: '偏移 X(m)', min: -2, max: 2, step: 0.01, get: () => tuning.offset[0], set: (v) => { tuning.offset[0] = v; } });
  slider({ label: '偏移 Y(m)', min: -1, max: 2, step: 0.01, get: () => tuning.offset[1], set: (v) => { tuning.offset[1] = v; } });
  slider({ label: '偏移 Z(m)', min: -2, max: 2, step: 0.01, get: () => tuning.offset[2], set: (v) => { tuning.offset[2] = v; } });

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = '恢复代码默认参数';
  reset.style.cssText =
    'margin-top:8px;width:100%;padding:6px;border-radius:6px;border:1px solid rgba(120,190,255,.4);background:#10283d;color:#cfe8ff;cursor:pointer;font-size:12px';
  reset.addEventListener('click', () => {
    // 直接清掉 URL 中旧的调参参数并重新进入调参模式，确保读取最新代码默认值。
    const url = new URL(window.location.href);
    const keys = [
      'depApply', 'dep', 'depFit', 'depExtent', 'depScale', 'depYaw', 'depPitch', 'depRoll',
      'depX', 'depY', 'depZ',
    ];
    keys.forEach((key) => url.searchParams.delete(key));
    url.searchParams.set('depTune', '1');
    window.location.replace(url.toString());
  });
  panel.appendChild(reset);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = '复制参数 URL';
  copy.style.cssText =
    'margin-top:8px;width:100%;padding:6px;border-radius:6px;border:1px solid rgba(120,190,255,.4);background:#12314c;color:#cfe8ff;cursor:pointer;font-size:12px';
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(readout.value);
    copy.textContent = '已复制 ✓';
    window.setTimeout(() => { copy.textContent = '复制参数 URL'; }, 1400);
  });
  panel.appendChild(copy);

  document.body.appendChild(panel);
  refresh();
}
