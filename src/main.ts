import * as THREE from 'three';
import {
  configureRailwayAttendanceKioskRenderer,
  createRailwayAttendanceKioskInspectControls,
  createRailwayAttendanceKioskLookDevLights,
  createRailwayAttendanceKioskModel,
  frameRailwayAttendanceKioskCamera,
} from './createAttendanceKioskModel';
import { KioskScreenRuntime } from './kioskScreenRuntime';
import { loadDispatcherModel, loadHeldItem, markDeliveryRevealPaperLine, syncDeliveryRevealPaperMarks, setDeliveryRevealViewPose, setHeldItemActionPose, setNotebookInspectionPose, softenKioskGeometry, type InventoryItemId } from './sceneProps';
import { createKioskCardSlot, KioskCardInsertion } from './kioskCardInsertion';
import { fitScreenAndAccessory, nearestKioskSurface } from './kioskBreathInteraction';
import { paperLineAtLocalPoint } from './revealPaperLayout';
import { nearestInteraction } from './nearbyInteraction';
import { mountDispatcherFlow, mountLkjFlow, mountNotebookFlow, mountPersonDialogue } from './trainingFlows';
import { TrainingWorkflow, createDialoguePicker, type PersonRole } from './trainingWorkflow';
import { paperRevealRecords } from './cardRevealData';
import { createRoomFurniture, decorateRoom, createSeatedDeputy, createFloorMaterial, createRearDoorDetails, counterBounds, dispatcherPosition, deputyForwardOffset, rearDoorPosition } from './sceneEnvironment';
import { resolveRoomMove, type RoomCollider } from './roomCollision';
import './styles.css';
import { createPerformanceDiagnostics } from './performanceDiagnostics';
import { disposeOwnedObject } from './resourceLifetime';

const reviewMode = new URLSearchParams(window.location.search).has('review');
const mobileMode = new URLSearchParams(window.location.search).has('mobile')
  || window.matchMedia('(pointer: coarse)').matches
  || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
document.body.classList.toggle('review-mode', reviewMode);
document.body.classList.toggle('public-demo', __PUBLIC_HOSTED__);
document.body.classList.toggle('mobile-controls-enabled', mobileMode && !reviewMode);

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');
const appRoot: HTMLDivElement = app;

app.innerHTML = `
  <canvas class="viewport" aria-label="出勤一体机三维预览"></canvas>
  <div class="studio-watermark studio-watermark--top" aria-hidden="true">谭浩宇工作室</div>
  <section class="hud collapsed">
    <button class="hud-toggle" type="button" aria-label="展开场景说明" aria-expanded="false">›</button>
    <p class="eyebrow">乘务作业训练</p>
    <h1>电力机车乘务作业 · 出勤场景</h1>
    <p>WASD移动，鼠标控制视角。靠近设备或人员后按E交互。</p>
    <div class="status"><i></i><span>出勤作业</span></div>
  </section>
  <output id="selection" hidden>未选择</output>
  <nav class="mission" aria-label="出勤作业任务路径">
    <button data-station="kiosk" class="active">01 出勤一体机</button>
    <button data-station="notebook">02 小组会</button>
    <button data-station="dispatcher">03 调度员</button>
    <button data-station="cab">04 驾驶台</button>
  </nav>
  <div class="interaction-prompt" hidden><span>已靠近出勤一体机</span><button type="button" data-open-kiosk>开始操作（E）</button></div>
  <div class="inventory-dock collapsed">
    <button class="hotbar-toggle" type="button" aria-label="展开随身物品" aria-expanded="false">⌃</button>
    <nav class="hotbar" aria-label="随身物品快捷栏">
      <button data-item="recorder"><kbd>1</kbd><img src="${import.meta.env.BASE_URL}assets/props/recorder-reference.png" alt=""><span>录音笔</span></button>
      <button data-item="notebook"><kbd>2</kbd><span class="item-glyph notebook-glyph">帐</span><span>司机手帐</span></button>
      <button data-item="ic-card"><kbd>3</kbd><img src="${import.meta.env.BASE_URL}assets/props/ic-card.png" alt=""><span>IC卡</span></button>
      <button data-item="delivery-reveal" class="locked"><kbd>4</kbd><span class="item-glyph paper-glyph">揭</span><span>交付揭示</span></button>
      <button data-item="documents"><kbd>5</kbd><span class="item-glyph document-glyph">证</span><span>证件规章</span></button>
      <button data-item="backpack"><kbd>6</kbd><span class="item-glyph backpack-glyph">包</span><span>背包</span></button>
    </nav>
  </div>
  <div class="crosshair" aria-hidden="true"></div>
  <section class="mobile-entry" ${mobileMode && !reviewMode ? '' : 'hidden'} aria-label="移动端训练入口">
    <div>
      <b>横屏进入仿真实训</b>
      <span>点击后将请求全屏并锁定横屏</span>
      <button type="button" data-mobile-enter>进入训练</button>
    </div>
  </section>
  <div class="mobile-rotate-message" aria-hidden="true">请将手机横向旋转</div>
  <button class="mobile-fullscreen" type="button" data-mobile-fullscreen aria-label="进入全屏">⛶</button>
  <section class="mobile-game-controls" aria-label="移动端游戏控制">
    <div class="mobile-joystick" data-mobile-joystick aria-label="移动方向">
      <i></i><b></b>
    </div>
    <div class="mobile-action-cluster">
      <button type="button" class="mobile-action mobile-action--interact" data-mobile-action="interact">交互</button>
      <button type="button" class="mobile-action mobile-action--primary" data-mobile-action="primary">操作</button>
      <button type="button" class="mobile-action mobile-action--jump" data-mobile-action="jump">跳跃</button>
      <button type="button" class="mobile-action mobile-action--sprint" data-mobile-action="sprint">加速</button>
    </div>
  </section>
  <div class="kiosk-overlay" hidden></div>
  <div class="scene-overlay" hidden></div>
  <div class="pass">03 / 08　交互与物品</div>
`;

const canvasElement = app.querySelector<HTMLCanvasElement>('canvas');
const selectionElement = app.querySelector<HTMLElement>('#selection');
const promptElement = app.querySelector<HTMLElement>('.interaction-prompt');
const kioskOverlayElement = app.querySelector<HTMLElement>('.kiosk-overlay');
const sceneOverlayElement = app.querySelector<HTMLElement>('.scene-overlay');
const hudElement = app.querySelector<HTMLElement>('.hud');
const hudToggle = app.querySelector<HTMLButtonElement>('.hud-toggle');
const inventoryDock = app.querySelector<HTMLElement>('.inventory-dock');
const hotbarToggle = app.querySelector<HTMLButtonElement>('.hotbar-toggle');
const mobileEntry = app.querySelector<HTMLElement>('.mobile-entry');
const mobileJoystick = app.querySelector<HTMLElement>('[data-mobile-joystick]');
const mobileJoystickThumb = mobileJoystick?.querySelector<HTMLElement>('b') ?? null;
if (!canvasElement || !selectionElement || !promptElement || !kioskOverlayElement || !sceneOverlayElement) throw new Error('Missing view elements');
const canvas: HTMLCanvasElement = canvasElement;
const selection: HTMLElement = selectionElement;
const interactionPrompt: HTMLElement = promptElement;
const kioskOverlay: HTMLElement = kioskOverlayElement;
const sceneOverlay: HTMLElement = sceneOverlayElement;

hudToggle?.addEventListener('click', () => {
  const collapsed = hudElement?.classList.toggle('collapsed') ?? true;
  hudToggle.textContent = collapsed ? '›' : '‹';
  hudToggle.setAttribute('aria-expanded', String(!collapsed));
});
hotbarToggle?.addEventListener('click', () => {
  const collapsed = inventoryDock?.classList.toggle('collapsed') ?? true;
  document.body.classList.toggle('hotbar-open', !collapsed);
  hotbarToggle.textContent = collapsed ? '⌃' : '⌄';
  hotbarToggle.setAttribute('aria-expanded', String(!collapsed));
});

async function requestMobileImmersive(): Promise<void> {
  if (!mobileMode) return;
  try {
    if (!document.fullscreenElement) await appRoot.requestFullscreen?.({ navigationUI: 'hide' });
  } catch {
    // iOS Safari and embedded browsers may not expose Fullscreen API.
  }
  try {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> };
    await orientation.lock?.('landscape');
  } catch {
    // Orientation lock is best-effort and normally requires fullscreen.
  }
  if (mobileEntry) mobileEntry.hidden = true;
  document.body.classList.add('mobile-training-started');
}

app.querySelector<HTMLButtonElement>('[data-mobile-enter]')?.addEventListener('click', () => {
  void requestMobileImmersive();
});
app.querySelector<HTMLButtonElement>('[data-mobile-fullscreen]')?.addEventListener('click', () => {
  void requestMobileImmersive();
});

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
configureRailwayAttendanceKioskRenderer(renderer);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
renderer.shadowMap.enabled = false;
renderer.setClearColor(reviewMode ? 0xffffff : 0xe7e4dc, 1);
const updatePerformanceDiagnostics = createPerformanceDiagnostics(renderer);
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(reviewMode ? 0xffffff : 0xe7e4dc);
if (!reviewMode) scene.fog = new THREE.Fog(0xe7e4dc, 15, 30);

const camera = new THREE.PerspectiveCamera(reviewMode ? 38 : 50, 1, 0.01, 100);
const kiosk = createRailwayAttendanceKioskModel({ castShadow: false, receiveShadow: false, qualityPriority: 'balanced' });
softenKioskGeometry(kiosk);
let kioskScreen: THREE.Mesh | null = null;
let kioskCardReader: THREE.Mesh | null = null;
let breathAnalyzer: THREE.Object3D | null = null;
let breathPivot: THREE.Object3D | null = null;
const breathPivotRestPosition = new THREE.Vector3();
const breathPivotBaseQuaternion = new THREE.Quaternion();
const breathPivotActionQuaternion = new THREE.Quaternion();
const blockoutMaterials = {
  shell: new THREE.MeshStandardMaterial({ color: 0xd9ddda, roughness: 0.74, metalness: 0.02 }),
  panel: new THREE.MeshStandardMaterial({ color: 0xaeb6b2, roughness: 0.76, metalness: 0.01 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x303936, roughness: 0.5, metalness: 0.01 }),
  worktop: new THREE.MeshStandardMaterial({ color: 0x59625f, roughness: 0.58, metalness: 0.01 }),
};
kiosk.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  if (reviewMode) {
    object.material = new THREE.MeshBasicMaterial({ color: 0x111111 });
    return;
  }
  const component = object.userData.sculptComponent as { id?: string; role?: string } | undefined;
  if (component?.id === 'main-screen') kioskScreen = object;
  if (component?.id === 'card-reader') kioskCardReader = object;
  if (component?.id === 'recognition-arm') breathAnalyzer = object;
  if (component?.id === 'main-screen') object.material = blockoutMaterials.screen;
  else if (component?.id === 'worktop') object.material = blockoutMaterials.worktop;
  else if (component?.id === 'interface-fascia') object.material = blockoutMaterials.panel;
  else object.material = blockoutMaterials.shell;
});
const initialBreathAnalyzer = breathAnalyzer as THREE.Object3D | null;
if (initialBreathAnalyzer) {
  breathPivot = initialBreathAnalyzer.parent;
  if (breathPivot) {
    breathPivot.position.x -= 0.21;
    initialBreathAnalyzer.position.x += 0.21;
    breathPivotBaseQuaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    breathPivotActionQuaternion.copy(breathPivotBaseQuaternion);
    breathPivot.quaternion.copy(breathPivotBaseQuaternion);
    breathPivotRestPosition.copy(breathPivot.position);
  }
  initialBreathAnalyzer.userData.interactionLabel = '点击酒测器开始检测';
}
kiosk.position.set(reviewMode ? 0 : -3.1, 0.62, reviewMode ? 0 : -2.55);
scene.add(kiosk);
scene.add(camera);
const viewModelScene = new THREE.Scene();
const viewModelCamera = new THREE.PerspectiveCamera(50, 1, 0.01, 10);
const viewModelRoot = new THREE.Group();
viewModelRoot.name = '第一人称手持物品层';
viewModelScene.add(viewModelRoot, viewModelCamera, new THREE.HemisphereLight(0xfff8eb, 0x354541, 2.2));
const readerMesh = kioskCardReader as THREE.Mesh | null;
if (readerMesh) readerMesh.material = new THREE.MeshStandardMaterial({ color: 0x24322d, roughness: 0.66 });
const kioskCardInsertion = readerMesh
  ? new KioskCardInsertion(createKioskCardSlot(readerMesh), scene, camera, viewModelRoot) : null;

let selectedItem: InventoryItemId | null = null;
let heldItem: THREE.Group | null = null;
let deliveryRevealUnlocked = import.meta.env.DEV && Number(new URLSearchParams(window.location.search).get('kioskStep')) >= 4;
let heldLoadToken = 0;
const heldRestPosition = new THREE.Vector3();
let heldActionElapsed = 0;
let heldActionActive = false;
let documentFanProgress = 0;
let documentFanTarget = 0;
let notebookOpen = false;
let notebookInspectProgress = 0;
let notebookInspectTarget = 0;
let revealInspectProgress = 0;
let revealInspectTarget = 0;
let revealView: 'overview' | 'screen' | 'paper' = 'overview';
let revealCloseProgress = 0;
let revealHideProgress = 0;

async function replaceHeldItemVariant(variant: 'default' | 'active'): Promise<void> {
  if (!selectedItem) return;
  const id = selectedItem;
  const token = ++heldLoadToken;
  const loaded = await loadHeldItem(id, variant);
  if (token !== heldLoadToken || selectedItem !== id) { disposeOwnedObject(loaded); return; }
  if (heldItem) disposeOwnedObject(heldItem);
  heldItem = loaded;
  heldRestPosition.copy(loaded.position);
  viewModelRoot.add(loaded);
  kioskController?.draw();
}

function triggerHeldItemAction(): void {
  if (!selectedItem || !heldItem || heldActionActive) return;
  if (selectedItem === 'ic-card' && kioskOpen && activeKioskStep === 5) {
    void kioskController?.insertCard();
    return;
  }
  if (selectedItem === 'notebook') {
    if (!notebookOpen) {
      notebookOpen = true;
      notebookInspectProgress = 0;
      notebookInspectTarget = 0;
      selection.textContent = '司机手账已翻开；再次点击可拿到镜头前查看。';
      void replaceHeldItemVariant('active');
    } else {
      notebookInspectTarget = notebookInspectTarget > 0.5 ? 0 : 1;
      selection.textContent = notebookInspectTarget ? '司机手账已拿到镜头前近距离查看。' : '司机手账已回到正常手持位置。';
    }
    return;
  }
  if (selectedItem === 'delivery-reveal') {
    revealInspectTarget = revealInspectTarget > 0.5 ? 0 : 1;
    selection.textContent = revealInspectTarget ? '运行揭示已拿到镜头前近距离查看。' : '运行揭示已回到正常手持位置。';
    return;
  }
  if (selectedItem === 'documents') {
    documentFanTarget = documentFanTarget > 0.5 ? 0 : 1;
    selection.textContent = documentFanTarget ? '规章证件已扇形展开。' : '规章证件已收拢。';
    return;
  }
  heldActionElapsed = 0;
  heldActionActive = true;
  const messages: Partial<Record<InventoryItemId, string>> = {
    recorder: '录音键已按下，开始录音。',
    'ic-card': 'IC卡正以绿色端朝前推向读卡口。',
    backpack: '背包已向前提起。',
  };
  selection.textContent = messages[selectedItem] ?? '已执行物品动作。';
}

async function selectInventoryItem(id: InventoryItemId): Promise<void> {
  if (kioskCardInsertion?.busy) return;
  if (id === 'ic-card' && kioskCardInsertion?.hasCard) {
    selection.textContent = 'IC卡仍在一体机卡槽内，请完成验卡与纸卡核对后取回。';
    return;
  }
  if (id === 'delivery-reveal' && !deliveryRevealUnlocked) {
    selection.textContent = '交付揭示尚未打印。';
    return;
  }
  if (selectedItem === id) {
    heldLoadToken += 1;
    selectedItem = null;
    if (heldItem) disposeOwnedObject(heldItem);
    heldItem = null;
  } else {
    selectedItem = id;
    if (heldItem) disposeOwnedObject(heldItem);
    heldItem = null;
    const token = ++heldLoadToken;
    selection.textContent = '正在取出物品…';
    const loaded = await loadHeldItem(id);
    if (token !== heldLoadToken || selectedItem !== id) { disposeOwnedObject(loaded); return; }
    heldItem = loaded;
    if (id === 'delivery-reveal') {
      syncDeliveryRevealPaperMarks(loaded, kioskController?.getPaperMarks() ?? []);
      revealCloseProgress = 0;
      revealHideProgress = 0;
      kioskController?.focusRevealView('overview');
    }
    heldRestPosition.copy(loaded.position);
    viewModelRoot.add(heldItem);
  }
  heldActionActive = false;
  heldActionElapsed = 0;
  documentFanProgress = 0;
  documentFanTarget = 0;
  notebookOpen = false;
  notebookInspectProgress = 0;
  notebookInspectTarget = 0;
  revealInspectProgress = 0;
  revealInspectTarget = 0;
  appRoot.querySelectorAll<HTMLElement>('[data-item]').forEach((button) => button.classList.toggle('active', button.dataset.item === selectedItem));
  selection.textContent = selectedItem ? `已取出：${appRoot.querySelector<HTMLElement>(`[data-item="${selectedItem}"] span:last-child`)?.textContent ?? selectedItem}` : '已收起随身物品';
  kioskController?.draw();
}

function unlockDeliveryReveal(): void {
  deliveryRevealUnlocked = true;
  appRoot.querySelector<HTMLElement>('[data-item="delivery-reveal"]')?.classList.remove('locked');
}

appRoot.querySelectorAll<HTMLElement>('[data-item]').forEach((button) => {
  button.addEventListener('click', () => selectInventoryItem(button.dataset.item as InventoryItemId));
});
scene.add(createRailwayAttendanceKioskLookDevLights('neutral'));
if (!reviewMode) scene.add(new THREE.HemisphereLight(0xfffbef, 0x6b716f, 1.15));

const interactables: THREE.Object3D[] = [kiosk];
type CollisionProxy = RoomCollider;
const collisionProxies: CollisionProxy[] = [];
let doorOpen = false;
let doorPivot: THREE.Group | null = null;
let rearDoorOpen = false;
let rearDoorPivot: THREE.Group | null = null;
const movingDoorColliders: {leaf:THREE.Object3D;proxy:CollisionProxy}[] = [];
let assistantDriverObject: THREE.Group | null = null;
let dispatcherObject: THREE.Group | null = null;
const interactionOccluders: THREE.Object3D[] = [];

function addBoxCollider(mesh: THREE.Object3D, name = mesh.name, enabled = () => true): CollisionProxy {
  mesh.updateWorldMatrix(true, false);
  const bounds = new THREE.Box3().setFromObject(mesh);
  const proxy={ name, minX: bounds.min.x, maxX: bounds.max.x, minZ: bounds.min.z, maxZ: bounds.max.z, enabled };
  collisionProxies.push(proxy);
  return proxy;
}

function roomBox(
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  color: number,
  label?: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.02 }),
  );
  mesh.name = name;
  mesh.position.set(...position);
  if (label) mesh.userData.interactionLabel = label;
  return mesh;
}

if (!reviewMode) {
  const room = new THREE.Group();
  room.name = '出勤调度室';
  const backWallLeft = roomBox('后墙左段', [0.82, 3.4, 0.12], [-5.59, 1.7, -4], 0xd8d4c9);
  const backWallRight = roomBox('后墙右段', [10.02, 3.4, 0.12], [0.99, 1.7, -4], 0xd8d4c9);
  const backWallTop = roomBox('门楣', [1.16, 1.12, 0.12], [-4.60, 2.84, -4], 0xd8d4c9);
  const leftWall = roomBox('左墙', [0.12, 3.4, 12], [-6, 1.7, 2], 0xdedbd1);
  const rightWall = roomBox('右墙', [0.12, 3.4, 12], [6, 1.7, 2], 0xdedbd1);
  room.add(backWallLeft, backWallRight, backWallTop, leftWall, rightWall);
  interactionOccluders.push(backWallLeft, backWallRight, backWallTop, leftWall, rightWall);
  const ceiling = roomBox('吊顶', [12, 0.1, 12], [0, 3.4, 2], 0xeeeeea);
  ceiling.material = new THREE.MeshBasicMaterial({color: 0xd7d9d2});
  room.add(ceiling);
  const entranceLeft=roomBox('派班室后墙左段',[5.30,3.4,.12],[-3.35,1.7,8],0xdedbd1);
  const entranceRight=roomBox('派班室后墙右段',[5.30,3.4,.12],[3.35,1.7,8],0xdedbd1);
  const entranceTop=roomBox('派班室后门门楣',[1.40,1.12,.12],[0,2.84,8],0xdedbd1);
  room.add(entranceLeft,entranceRight,entranceTop);
  interactionOccluders.push(entranceLeft,entranceRight,entranceTop);
  const {desk, deskTop, cabinet, bench, chair, stool, backpack} = createRoomFurniture();
  desk.userData.interactionLabel = '出勤调度员工作台';
  room.add(desk, cabinet, bench, chair, stool, backpack);

  doorPivot = new THREE.Group();
  doorPivot.name = '调度室出口门铰链';
  doorPivot.position.set(-5.18, 0, -3.91);
  const doorLeaf = roomBox('调度室出口门', [1.10, 2.22, 0.07], [0.55, 1.11, 0], 0xc8d0cc, '出口门：按E开启或关闭');
  const doorWindow = roomBox('门上观察窗', [0.56, 0.62, 0.025], [0.55, 1.48, 0.045], 0x668a8f);
  doorPivot.add(doorLeaf, doorWindow);
  decorateRoom(room, doorPivot);
  room.add(doorPivot);
  interactables.push(doorPivot);
  rearDoorPivot=new THREE.Group();rearDoorPivot.name='派班室后门铰链';rearDoorPivot.position.set(-.65,0,7.96);
  const rearDoorLeaf=roomBox('派班室后门',[1.30,2.22,.07],[.65,1.11,0],0xc8d0cc,'派班室后门：按E开启或关闭');
  rearDoorPivot.add(rearDoorLeaf);createRearDoorDetails(room,rearDoorPivot);room.add(rearDoorPivot);
  interactables.push(rearDoorPivot);
  interactionOccluders.push(doorLeaf,rearDoorLeaf,desk);

  const dispatcher = new THREE.Group();
  dispatcher.name = '调度员加载占位';
  dispatcher.userData.interactionLabel = '出勤调度员人物正在加载';
  const torso = roomBox('调度员躯干', [0.46, 0.72, 0.28], [0, 1.24, 0], 0x263b58);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xc89e7c, roughness: 0.82 }),
  );
  head.position.set(0, 1.76, 0);
  dispatcher.add(torso, head);
  dispatcher.scale.setScalar(1.60/1.74);
  dispatcher.position.set(...dispatcherPosition);
  room.add(dispatcher);
  dispatcherObject = dispatcher;
  interactables.push(dispatcher, desk);

  const assistantDriver = createSeatedDeputy();
  assistantDriverObject = assistantDriver;
  room.add(assistantDriver);
  interactables.push(assistantDriver);

  if (!__PUBLIC_DEMO__) loadDispatcherModel().then((loadedDispatcher) => {
    loadedDispatcher.position.set(...dispatcherPosition);
    loadedDispatcher.rotation.y = 0;
    room.remove(dispatcher);
    const placeholderIndex = interactables.indexOf(dispatcher);
    if (placeholderIndex >= 0) interactables.splice(placeholderIndex, 1);
    room.add(loadedDispatcher);
    dispatcherObject = loadedDispatcher;
    interactables.push(loadedDispatcher);
  }).catch((error) => {
    console.warn('调度员GLB加载失败，保留低面数占位人物。', error);
    dispatcher.name = '出勤调度员（低面数占位）';
    dispatcher.userData.interactionLabel = '出勤调度员：开始人人核对';
  });
  else {
    // Reuse the detailed procedural railway worker in the public build. It
    // preserves the pre-lightweight silhouette without publishing the private GLB.
    const publicDispatcher = createSeatedDeputy();
    publicDispatcher.name = '出勤调度员（公开低面数模型）';
    publicDispatcher.userData.interactionLabel = '出勤调度员：开始人人核对';
    publicDispatcher.position.set(...dispatcherPosition);
    room.remove(dispatcher);
    const placeholderIndex = interactables.indexOf(dispatcher);
    if (placeholderIndex >= 0) interactables.splice(placeholderIndex, 1);
    room.add(publicDispatcher);
    dispatcherObject = publicDispatcher;
    interactables.push(publicDispatcher);
  }

  for (const x of [-3.6, 0, 3.6]) {
    const light = new THREE.PointLight(0xfff4df, 0.52, 8, 2);
    light.position.set(x, 3.05, -0.2);
    room.add(light);
  }
  scene.add(room);
  room.updateMatrixWorld(true);
  [backWallLeft, backWallRight, leftWall, rightWall, entranceLeft, entranceRight, cabinet, bench, chair, stool, backpack]
    .forEach((mesh) => addBoxCollider(mesh));
  collisionProxies.push({name:'封闭出勤台及内部工作区',...counterBounds,enabled:()=>true});
  movingDoorColliders.push({leaf:doorLeaf,proxy:addBoxCollider(doorLeaf,'出勤室门')});
  movingDoorColliders.push({leaf:rearDoorLeaf,proxy:addBoxCollider(rearDoorLeaf,'派班室后门')});
}

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(12, 12),
  createFloorMaterial(),
);
floor.rotation.x = -Math.PI / 2;
floor.position.z = 2;
floor.receiveShadow = true;
if (!reviewMode) scene.add(floor);

if (!reviewMode) {
  const outsideFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 7),
    new THREE.MeshStandardMaterial({ color: 0xbfc5c1, roughness: 0.9 }),
  );
  outsideFloor.rotation.x = -Math.PI / 2;
  outsideFloor.position.set(-4.6, 0.002, -7.3);
  scene.add(outsideFloor);
  const rearOutsideFloor=outsideFloor.clone();rearOutsideFloor.position.set(0,.002,11.3);scene.add(rearOutsideFloor);
  kiosk.updateMatrixWorld(true);
  addBoxCollider(kiosk, '出勤一体机');
}

const controls = createRailwayAttendanceKioskInspectControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 2.2;
controls.maxDistance = 6.8;
controls.enabled = reviewMode;

camera.rotation.order = 'YXZ';
if (!reviewMode) {
  camera.position.set(0, 1.65, 5.6);
  camera.lookAt(-1.6, 1.35, -2.55);
}
let yaw = camera.rotation.y;
let pitch = camera.rotation.x;
let roomInitialized = !reviewMode;

function frame(): void {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  viewModelCamera.aspect = width / height;
  if (reviewMode) {
    frameRailwayAttendanceKioskCamera(camera, kiosk, { margin: 1.08, azimuthDeg: -6, elevationDeg: 2 });
    controls.target.copy(new THREE.Box3().setFromObject(kiosk).getCenter(new THREE.Vector3()));
  } else if (!roomInitialized) {
    camera.position.set(0, 1.65, 5.6);
    camera.lookAt(-1.6, 1.35, -2.55);
    yaw = camera.rotation.y;
    pitch = camera.rotation.x;
    roomInitialized = true;
  }
  camera.updateProjectionMatrix();
  viewModelCamera.updateProjectionMatrix();
  if (kioskOpen) fitKioskInteractionCamera();
  if (reviewMode) controls.update();
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let selected: THREE.Mesh | null = null;
let selectedColor: THREE.Color | null = null;
let kioskController: KioskScreenRuntime | null = null;
let sceneFlowCleanup: (() => void) | null = null;
const trainingWorkflow = new TrainingWorkflow();
const personLine = createDialoguePicker();
let kioskOpen = false;
let sceneOverlayOpen = false;
let activeStation = 'kiosk';
let activeKioskStep = 0;
let breathAnimation = 0;
let breathAnimationTarget = 0;
const preKioskCameraPosition = new THREE.Vector3();
const preKioskCameraQuaternion = new THREE.Quaternion();

function isInside(object: THREE.Object3D | null, parent: THREE.Object3D): boolean {
  let cursor = object;
  while (cursor) {
    if (cursor === parent) return true;
    cursor = cursor.parent;
  }
  return false;
}

function componentIdOf(object: THREE.Object3D | null): string {
  let cursor = object;
  while (cursor) {
    const component = cursor.userData.sculptComponent as { id?: string } | undefined;
    if (component?.id) return component.id;
    cursor = cursor.parent;
  }
  return '';
}

function triggerBreathAnalyzer(): void {
  if (!kioskOpen || activeKioskStep !== 1 || !breathAnalyzer) return;
  if (!kioskController?.beginBreathTest()) return;
  if (breathPivot?.parent) {
    const pivotWorld = breathPivot.getWorldPosition(new THREE.Vector3());
    const cameraWorld = camera.getWorldPosition(new THREE.Vector3());
    const localDirection = cameraWorld
      .sub(pivotWorld)
      .normalize()
      .applyQuaternion(breathPivot.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    breathPivotActionQuaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), localDirection);
  }
  breathAnimation = 0;
  breathAnimationTarget = 1;
  selection.textContent = '酒测器正在转向当前视角。';
}

function kioskDistance(): number {
  return camera.position.distanceTo(new THREE.Vector3(kiosk.position.x, 1.35, kiosk.position.z + 0.8));
}

function doorDistance(): number {
  return camera.position.distanceTo(new THREE.Vector3(-4.6, 1.25, -3.9));
}

function assistantDriverDistance(): number {
  if (!assistantDriverObject) return Number.POSITIVE_INFINITY;
  const target = assistantDriverObject.getWorldPosition(new THREE.Vector3());
  target.y = 1.05;
  return camera.position.distanceTo(target);
}

function dispatcherDistance(): number {
  if (!dispatcherObject) return Number.POSITIVE_INFINITY;
  const target = dispatcherObject.getWorldPosition(new THREE.Vector3());
  target.y = 1.35;
  return camera.position.distanceTo(target);
}

function nearestSceneInteraction(): string | null {
  const dispatcherPoint = dispatcherObject?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(2.75, 0, -3.18);
  dispatcherPoint.y = 1.35;
  const candidates = [
    { id: 'kiosk', point: new THREE.Vector3(kiosk.position.x, 1.35, kiosk.position.z + 0.8), radius: 1.75 },
    { id: 'dispatcher', point: dispatcherPoint, radius: 2.1, available: !!dispatcherObject },
    { id: 'notebook', point: new THREE.Vector3(2.05, 1.05, 1.12+deputyForwardOffset), radius: 1.85, available: !!assistantDriverObject },
    { id: 'door', point: new THREE.Vector3(-4.6, 1.25, -3.9), radius: 1.7 },
    { id: 'rear-door', point: new THREE.Vector3(...rearDoorPosition), radius: 1.7 },
  ];
  return nearestInteraction(candidates.map(candidate => {
    const distance = camera.position.distanceTo(candidate.point);
    const direction = candidate.point.clone().sub(camera.position).normalize();
    const blocked = distance > 0.1 && new THREE.Raycaster(camera.position, direction, 0, distance - 0.1)
      .intersectObjects(interactionOccluders, true).length > 0;
    return { ...candidate, distance, visible: candidate.available !== false && !blocked };
  }))?.id ?? null;
}

function interactNearby(): void {
  if (reviewMode || kioskOpen || sceneOverlayOpen) return;
  const target = nearestSceneInteraction();
  if (target === 'door') toggleDoor();
  else if (target === 'rear-door') toggleDoor(true);
  else if (target === 'kiosk') openKiosk();
  else if (target === 'dispatcher') openDispatcherFlow();
  else if (target === 'notebook') openNotebookFlow();
  else selection.textContent = '附近没有可交互对象，请先靠近设备或人员后按E。';
}

function fitKioskInteractionCamera(): void {
  if (kioskCardInsertion?.busy) return;
  if (!kioskScreen) return;
  if (activeKioskStep === 1 && breathAnalyzer) {
    fitScreenAndAccessory(camera, kioskScreen, breathAnalyzer);
    yaw = camera.rotation.y; pitch = camera.rotation.x;
    return;
  }
  kioskScreen.updateWorldMatrix(true, false);
  const component = kioskScreen.userData.sculptComponent as { dimensions?: { width?: number; height?: number } };
  const scale = kioskScreen.getWorldScale(new THREE.Vector3());
  const width = (component?.dimensions?.width ?? 0.96) * scale.x;
  const height = (component?.dimensions?.height ?? 0.58) * scale.y;
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // Fit the physical screen to the viewport, not a fixed world-space distance.
  const margin = (activeKioskStep === 4 || activeKioskStep === 6) && revealView === 'screen' ? 1.04 : 1.16;
  const distance = Math.max(height / (2 * tangent), width / (2 * tangent * camera.aspect)) * margin;
  const center = kioskScreen.getWorldPosition(new THREE.Vector3());
  const quaternion = kioskScreen.getWorldQuaternion(new THREE.Quaternion());
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  camera.position.copy(center).addScaledVector(normal, distance);
  camera.quaternion.copy(quaternion);
  yaw = camera.rotation.y;
  pitch = camera.rotation.x;
}

function toggleDoor(rear=false): void {
  if(rear){
    if(!rearDoorPivot)return;
    rearDoorOpen=!rearDoorOpen;
    selection.textContent=rearDoorOpen?'派班室后门已打开。':'派班室后门已关闭。';
    return;
  }
  if (!doorPivot) return;
  doorOpen = !doorOpen;
  selection.textContent = doorOpen ? '出口门已打开，可以走出调度室。' : '出口门已关闭。';
}

function setActiveStation(station: string): void {
  appRoot.querySelectorAll('.mission button').forEach((item) => item.classList.toggle('active', (item as HTMLElement).dataset.station === station));
}

function closeKiosk(): void {
  kioskCardInsertion?.cancel();
  if (breathAnimationTarget > 0) {
    breathAnimationTarget = 0; breathAnimation = 0;
    breathPivot?.quaternion.copy(breathPivotBaseQuaternion);
    kioskController?.cancelBreathTest();
  }
  kioskOpen = false;
  kioskOverlay.hidden = true;
  kioskOverlay.classList.remove('embedded');
  kioskOverlay.removeAttribute('style');
  document.body.classList.remove('kiosk-active');
  camera.position.copy(preKioskCameraPosition);
  camera.quaternion.copy(preKioskCameraQuaternion);
  yaw = camera.rotation.y;
  pitch = camera.rotation.x;
  revealView = 'overview';
}

function ensureKioskRuntime(): KioskScreenRuntime {
  if (kioskController) return kioskController;
  kioskController = new KioskScreenRuntime({
    onClose: closeKiosk,
    onPrinted: unlockDeliveryReveal,
    onStartBreath: triggerBreathAnalyzer,
    onReportDifference: source => { trainingWorkflow.pendingDifference = source; },
    onRequestCard: () => { void selectInventoryItem('ic-card'); },
    getSelectedItem: () => selectedItem,
    onInsertCard: async () => {
      if (!heldItem || selectedItem !== 'ic-card' || !kioskCardInsertion) return false;
      heldActionActive = false;
      const inserted = await kioskCardInsertion.insert(heldItem);
      if (inserted) {
        heldItem = null; selectedItem = null; heldLoadToken += 1;
        appRoot.querySelectorAll('[data-item]').forEach(button => button.classList.remove('active'));
      }
      if (kioskOpen) fitKioskInteractionCamera();
      return inserted;
    },
    onTakeCard: () => {
      const mountedCard = kioskCardInsertion?.takeBack();
      if (mountedCard) disposeOwnedObject(mountedCard);
      void selectInventoryItem('ic-card');
    },
    onRevealViewChange: (view) => {
      revealView = view;
      if (kioskOpen) fitKioskInteractionCamera();
      selection.textContent = view === 'paper'
        ? '手持交付揭示已拿到镜头前；点击左侧露出的一体机屏幕可切换。'
        : view === 'screen'
          ? `交付揭示已移出镜头，当前查看${activeKioskStep === 6 ? '卡内揭示' : '公布揭示'}。`
          : '点击左侧屏幕或右侧交付揭示进入近景核对。';
    },
    onStepChange: (step) => {
      activeKioskStep = step;
      revealView = 'overview';
      revealCloseProgress = 0; revealHideProgress = 0;
      if (kioskOpen) fitKioskInteractionCamera();
      if ((step === 4 || (step === 6 && kioskController?.isRevealComparison())) && deliveryRevealUnlocked) {
        if (selectedItem !== 'delivery-reveal') void selectInventoryItem('delivery-reveal');
        else if (heldItem) syncDeliveryRevealPaperMarks(heldItem, kioskController?.getPaperMarks() ?? []);
      }
      if (step !== 1 && breathPivot) {
        breathAnimationTarget = 0;
        breathAnimation = 0;
        breathPivot.quaternion.copy(breathPivotBaseQuaternion);
        breathPivot.position.copy(breathPivotRestPosition);
      }
    },
    onComplete: () => {
      // All card checks have passed, including any reported card fault that was rewritten.
      trainingWorkflow.pendingDifference = null;
      trainingWorkflow.complete('kiosk');
      closeKiosk();
      setActiveStation('notebook');
      activeStation = 'notebook';
      selection.textContent = '一体机阶段完成：请与副司机开小组会。';
    },
  });
  if (kioskScreen) {
    kioskScreen.material = new THREE.MeshBasicMaterial({ map: kioskController.texture, toneMapped: false });
  }
  return kioskController;
}

function closeSceneOverlay(): void {
  sceneFlowCleanup?.();
  sceneFlowCleanup = null;
  sceneOverlayOpen = false;
  sceneOverlay.hidden = true;
  document.body.classList.remove('scene-flow-active');
}

function openPersonDialogue(role: PersonRole): void {
  document.exitPointerLock?.();
  interactionPrompt.hidden=true; sceneOverlayOpen=true; sceneOverlay.hidden=false;
  document.body.classList.add('scene-flow-active');
  const source = role==='dispatcher' ? trainingWorkflow.pendingDifference : null;
  sceneFlowCleanup = mountPersonDialogue(sceneOverlay, {
    role, onClose: closeSceneOverlay,
    nextLine: () => source ? (source==='published'?'已收到公布揭示差异报告，我们先复核这份资料。':'已收到纸卡差异报告，复核后需要重新写卡并验卡。') : personLine(role,trainingWorkflow.stage),
    onReview: source ? () => {
      if(kioskController?.resolveReportedDifference(source)) {
        trainingWorkflow.pendingDifference=null;
        if(heldItem&&selectedItem==='delivery-reveal')syncDeliveryRevealPaperMarks(heldItem,[]);
      }
    } : undefined,
  });
}

function openDispatcherFlow(): void {
  if (reviewMode || sceneOverlayOpen || kioskOpen) return;
  if (dispatcherDistance() > 2.1 || nearestSceneInteraction() !== 'dispatcher') {
    selection.textContent = '请先靠近出勤调度员，再按E进行人人核对。';
    return;
  }
  if (trainingWorkflow.actionFor('dispatcher') !== 'check') { openPersonDialogue('dispatcher'); return; }
  document.exitPointerLock?.();
  interactionPrompt.hidden = true;
  sceneOverlayOpen = true;
  sceneOverlay.hidden = false;
  document.body.classList.add('scene-flow-active');
  sceneFlowCleanup = mountDispatcherFlow(sceneOverlay, {
    onClose: closeSceneOverlay,
    onComplete: () => {
      if (!trainingWorkflow.complete('dispatcher')) return;
      closeSceneOverlay();
      setActiveStation('cab');
      activeStation = 'cab';
      selection.textContent = '人人核对完成，下一步进行人车核对。';
    },
  });
}

function openNotebookFlow(): void {
  if (reviewMode || sceneOverlayOpen || kioskOpen) return;
  if (assistantDriverDistance() > 1.85 || nearestSceneInteraction() !== 'notebook') {
    selection.textContent = '请先靠近旁边的副司机，再按E填写司机手帐。';
    return;
  }
  if (trainingWorkflow.actionFor('deputy') !== 'meeting') { openPersonDialogue('deputy'); return; }
  if (selectedItem !== 'notebook') selectInventoryItem('notebook');
  document.exitPointerLock?.();
  interactionPrompt.hidden = true;
  sceneOverlayOpen = true;
  sceneOverlay.hidden = false;
  document.body.classList.add('scene-flow-active');
  sceneFlowCleanup = mountNotebookFlow(sceneOverlay, {
    onClose: closeSceneOverlay,
    onComplete: () => {
      if (!trainingWorkflow.complete('meeting')) return;
      closeSceneOverlay();
      setActiveStation('dispatcher');
      activeStation = 'dispatcher';
      selection.textContent = '小组会已完成，请与出勤调度员进行人人核对。';
    },
  });
}

// Development-only entry used to verify the notebook form at real mobile viewport sizes.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('openNotebook') === '1') {
  window.setTimeout(() => {
    if (sceneOverlayOpen || kioskOpen) return;
    sceneOverlayOpen = true;
    sceneOverlay.hidden = false;
    document.body.classList.add('scene-flow-active');
    sceneFlowCleanup = mountNotebookFlow(sceneOverlay, { onClose: closeSceneOverlay });
  }, 0);
}

function openLkjFlow(explicitPrototype = false): void {
  // No physical cab exists yet: keep the explicit prototype preview, never bind it to nearby E.
  if (!explicitPrototype || reviewMode || sceneOverlayOpen || kioskOpen) return;
  if (trainingWorkflow.stage !== 'cab') {
    window.alert(trainingWorkflow.stage === 'complete' ? '本轮人车核对已完成。' : '请先完成一体机出勤、小组会和人人核对。');
    return;
  }
  document.exitPointerLock?.();
  interactionPrompt.hidden = true;
  sceneOverlayOpen = true;
  sceneOverlay.hidden = false;
  document.body.classList.add('scene-flow-active');
  sceneFlowCleanup = mountLkjFlow(sceneOverlay, {
    onClose: closeSceneOverlay,
    onComplete: () => {
      if (!trainingWorkflow.complete('cab')) return;
      closeSceneOverlay();
      selection.textContent = `人车核对完成：已查询IC卡内全部${paperRevealRecords.length}条揭示信息。`;
    },
  });
}

function openKiosk(force = false): void {
  if (reviewMode || kioskOpen || sceneOverlayOpen) return;
  if (!force && (kioskDistance() > 1.75 || nearestSceneInteraction() !== 'kiosk')) {
    selection.textContent = '距离一体机过远，请先使用WASD或方向键靠近。';
    return;
  }
  document.exitPointerLock?.();
  preKioskCameraPosition.copy(camera.position);
  preKioskCameraQuaternion.copy(camera.quaternion);
  fitKioskInteractionCamera();
  kioskOpen = true;
  interactionPrompt.hidden = true;
  kioskOverlay.hidden = true;
  document.body.classList.add('kiosk-active');
  ensureKioskRuntime().draw();
}

if (!reviewMode) ensureKioskRuntime();
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('openKiosk') === '1') {
  window.setTimeout(() => openKiosk(true), 0);
}

let kioskPointerActive: number | null = null;
let paperPointerActive: number | null = null;
let paperPointerLine: number | null = null;
let suppressNextCanvasClick = false;

function deliveryRevealPaperPointAt(event: PointerEvent): THREE.Vector3 | null {
  if (!kioskOpen || !kioskController?.isRevealComparison() || selectedItem !== 'delivery-reveal' || !heldItem?.visible || revealHideProgress > 0.5) return null;
  const paper = heldItem.getObjectByName('交付揭示纸面');
  if (!paper) return null;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, viewModelCamera);
  const hit = raycaster.intersectObject(paper, false)[0];
  if (!hit) return null;
  return heldItem.worldToLocal(hit.point.clone());
}

function handleKioskPointer(event: PointerEvent, phase: 'down' | 'move' | 'up'): boolean {
  if (!kioskOpen || !kioskScreen || !kioskController) return false;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = nearestKioskSurface(raycaster, kioskScreen, breathAnalyzer, activeKioskStep === 1);
  if (!hit) return false;
  if (hit.object === breathAnalyzer) {
    if (phase === 'up') triggerBreathAnalyzer();
    return true;
  }
  const local = kioskScreen.worldToLocal(hit.point.clone());
  const component = kioskScreen.userData.sculptComponent as { dimensions?: { width?: number; height?: number } } | undefined;
  const width = component?.dimensions?.width ?? 0.96;
  const height = component?.dimensions?.height ?? 0.58;
  const u = THREE.MathUtils.clamp(local.x / width + 0.5, 0, 1);
  const v = THREE.MathUtils.clamp(0.5 - local.y / height, 0, 1);
  kioskController.handlePointer(u, v, phase);
  return true;
}

function inspectAt(event: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(interactables, true).find((item) => item.object instanceof THREE.Mesh);
  if (selected && selectedColor) {
    const material = selected.material;
    if (material instanceof THREE.MeshStandardMaterial) material.color.copy(selectedColor);
  }
  selected = hit?.object instanceof THREE.Mesh ? hit.object : null;
  selectedColor = null;
  if (!selected) {
    selection.textContent = '未选择';
    return;
  }
  const material = selected.material;
  if (material instanceof THREE.MeshStandardMaterial) {
    selectedColor = material.color.clone();
    material.color.offsetHSL(0.02, 0.12, 0.12);
  }
  let cursor: THREE.Object3D | null = selected;
  let label = '';
  while (cursor && !label) {
    label = String(cursor.userData.interactionLabel || '');
    cursor = cursor.parent;
  }
  selection.textContent = label || selected.parent?.name || selected.name || '未命名组件';
  if (componentIdOf(selected) === 'recognition-arm' && kioskOpen) triggerBreathAnalyzer();
  else if (componentIdOf(selected) === 'card-reader' && kioskOpen && activeKioskStep === 5) void kioskController?.insertCard();
  else if (!kioskOpen) selection.textContent = label ? `${label}；靠近后按E交互。` : '靠近设备或人员后按E交互。';
}

let lookPointer: number | null = null;
let lastLookX = 0;
let lastLookY = 0;
let lookTravel = 0;
function applyLookDelta(dx: number, dy: number): void {
  yaw -= dx * 0.00155;
  pitch = THREE.MathUtils.clamp(pitch - dy * 0.0014, -1.05, 1.05);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}
canvas.addEventListener('pointerdown', (event) => {
  suppressNextCanvasClick = kioskOpen;
  if (kioskCardInsertion?.busy) return;
  if (kioskOpen) {
    const paperPoint = deliveryRevealPaperPointAt(event);
    if (paperPoint) {
      paperPointerActive = event.pointerId;
      // The first click only raises the paper. Never let that same click also mark a line.
      paperPointerLine = revealView === 'paper' && revealCloseProgress > 0.94
        ? paperLineAtLocalPoint(paperPoint.x, paperPoint.y) : null;
      if (revealView !== 'paper') kioskController?.focusRevealView('paper');
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    kioskPointerActive = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    handleKioskPointer(event, 'down');
    return;
  }
  if (event.pointerType === 'mouse' && document.pointerLockElement === canvas && selectedItem) {
    triggerHeldItemAction();
    return;
  }
  if (reviewMode || event.pointerType === 'mouse') return;
  lookPointer = event.pointerId;
  lastLookX = event.clientX;
  lastLookY = event.clientY;
  lookTravel = 0;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (kioskOpen && kioskPointerActive === event.pointerId) {
    handleKioskPointer(event, 'move');
    return;
  }
  if (reviewMode || event.pointerType === 'mouse' || lookPointer !== event.pointerId || kioskOpen || sceneOverlayOpen) return;
  const dx = event.clientX - lastLookX;
  const dy = event.clientY - lastLookY;
  lookTravel += Math.abs(dx) + Math.abs(dy);
  lastLookX = event.clientX;
  lastLookY = event.clientY;
  applyLookDelta(dx, dy);
});
canvas.addEventListener('pointerup', (event) => {
  if (kioskOpen && paperPointerActive === event.pointerId) {
    const point = deliveryRevealPaperPointAt(event);
    const line = point ? paperLineAtLocalPoint(point.x, point.y) : null;
    const sameLine = line !== null && line === paperPointerLine;
    paperPointerActive = null;
    paperPointerLine = null;
    if (sameLine && line !== null && heldItem && kioskController?.markPaperRevealLine(line)) {
      markDeliveryRevealPaperLine(heldItem, line);
      selection.textContent = `纸质交付揭示第 ${line + 1} 行已添加下划线。`;
    }
    return;
  }
  if (kioskOpen && kioskPointerActive === event.pointerId) {
    const handledByScreen = handleKioskPointer(event, 'up');
    kioskPointerActive = null;
    if (!handledByScreen) inspectAt(event);
    return;
  }
  if (reviewMode) {
    inspectAt(event);
    return;
  }
  if (lookPointer !== event.pointerId) return;
  lookPointer = null;
  if (lookTravel < 8) {
    if (selectedItem) triggerHeldItemAction();
    else inspectAt(event);
  }
});
canvas.addEventListener('pointercancel', () => {
  paperPointerActive = null;
  paperPointerLine = null;
  kioskPointerActive = null;
});
canvas.addEventListener('click', (event) => {
  if (suppressNextCanvasClick) { suppressNextCanvasClick = false; return; }
  if (reviewMode) {
    inspectAt(event);
    return;
  }
  if (kioskOpen) {
    return;
  }
  if (sceneOverlayOpen) return;
  if (document.pointerLockElement !== canvas) {
    if (selectedItem) triggerHeldItemAction();
    canvas.requestPointerLock?.();
  }
});
document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== canvas || reviewMode || kioskOpen || sceneOverlayOpen) return;
  applyLookDelta(event.movementX, event.movementY);
});
document.addEventListener('pointerlockchange', () => {
  document.body.classList.toggle('fps-active', document.pointerLockElement === canvas);
});

const movement = new Set<string>();
let mobileMoveX = 0;
let mobileMoveY = 0;
let mobileSprint = false;
let mobileJoystickPointer: number | null = null;
const standingEyeHeight = 1.65;
let verticalVelocity = 0;
let grounded = true;
const playerRadius = 0.28;

function resolvePlayerMove(current: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
  const resolved = current.clone();
  const position=resolveRoomMove(current,desired,collisionProxies,playerRadius);
  resolved.x=position.x;resolved.z=position.z;
  return resolved;
}

function updateMobileJoystick(event: PointerEvent): void {
  if (!mobileJoystick || !mobileJoystickThumb) return;
  const rect = mobileJoystick.getBoundingClientRect();
  const radius = Math.max(24, rect.width * 0.32);
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  const length = Math.hypot(dx, dy) || 1;
  const scale = Math.min(1, radius / length);
  const x = dx * scale;
  const y = dy * scale;
  mobileMoveX = THREE.MathUtils.clamp(x / radius, -1, 1);
  mobileMoveY = THREE.MathUtils.clamp(-y / radius, -1, 1);
  mobileJoystickThumb.style.transform = `translate(${x}px, ${y}px)`;
}

function resetMobileJoystick(): void {
  mobileJoystickPointer = null;
  mobileMoveX = 0;
  mobileMoveY = 0;
  if (mobileJoystickThumb) mobileJoystickThumb.style.transform = 'translate(0, 0)';
}

mobileJoystick?.addEventListener('pointerdown', (event) => {
  if (kioskOpen || sceneOverlayOpen) return;
  mobileJoystickPointer = event.pointerId;
  mobileJoystick.setPointerCapture(event.pointerId);
  updateMobileJoystick(event);
  event.preventDefault();
  event.stopPropagation();
});
mobileJoystick?.addEventListener('pointermove', (event) => {
  if (mobileJoystickPointer !== event.pointerId) return;
  updateMobileJoystick(event);
  event.preventDefault();
  event.stopPropagation();
});
mobileJoystick?.addEventListener('pointerup', resetMobileJoystick);
mobileJoystick?.addEventListener('pointercancel', resetMobileJoystick);

app.querySelector<HTMLButtonElement>('[data-mobile-action="interact"]')?.addEventListener('click', () => {
  if (!kioskOpen && !sceneOverlayOpen) interactNearby();
});
app.querySelector<HTMLButtonElement>('[data-mobile-action="primary"]')?.addEventListener('click', () => {
  if (kioskOpen || sceneOverlayOpen) return;
  if (selectedItem) triggerHeldItemAction();
  else interactNearby();
});
const mobileJumpButton = app.querySelector<HTMLButtonElement>('[data-mobile-action="jump"]');
function triggerMobileJump(event?: PointerEvent): void {
  event?.preventDefault();
  event?.stopPropagation();
  if (kioskOpen || sceneOverlayOpen || !grounded) return;
  verticalVelocity = 4.8;
  grounded = false;
}
// A second touch must jump immediately while the first remains captured by the joystick.
mobileJumpButton?.addEventListener('pointerdown', triggerMobileJump);
const mobileSprintButton = app.querySelector<HTMLButtonElement>('[data-mobile-action="sprint"]');
const stopMobileSprint = (): void => {
  mobileSprint = false;
  mobileSprintButton?.classList.remove('pressed');
};
mobileSprintButton?.addEventListener('pointerdown', (event) => {
  mobileSprint = true;
  mobileSprintButton.classList.add('pressed');
  mobileSprintButton.setPointerCapture(event.pointerId);
  event.preventDefault();
  event.stopPropagation();
});
mobileSprintButton?.addEventListener('pointerup', stopMobileSprint);
mobileSprintButton?.addEventListener('pointercancel', stopMobileSprint);
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const typing = target?.matches('input, textarea, select, [contenteditable="true"]') ?? false;
  if (!typing && event.code === 'Escape' && kioskOpen) {
    closeKiosk();
    return;
  }
  const hotkeys: Record<string, InventoryItemId> = {
    Digit1: 'recorder', Digit2: 'notebook', Digit3: 'ic-card', Digit4: 'delivery-reveal', Digit5: 'documents', Digit6: 'backpack',
  };
  if (!typing && hotkeys[event.code]) selectInventoryItem(hotkeys[event.code]);
  if (!typing && !event.repeat && event.code === 'KeyE' && !kioskOpen && !sceneOverlayOpen) {
    event.preventDefault();
    interactNearby();
  }
  if (!typing && (event.code === 'ShiftLeft' || event.code === 'ShiftRight')) movement.add(event.code);
  if (!typing && event.code === 'Space' && !kioskOpen && !sceneOverlayOpen && grounded) {
    verticalVelocity = 4.8;
    grounded = false;
    event.preventDefault();
  }
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.code)) {
    if (typing || kioskOpen || sceneOverlayOpen) return;
    movement.add(event.code);
    event.preventDefault();
  }
});
window.addEventListener('keyup', (event) => movement.delete(event.code));

app.querySelector('[data-open-kiosk]')?.addEventListener('click', () => {
  interactNearby();
});

app.querySelectorAll<HTMLButtonElement>('.mission button').forEach((button) => {
  button.addEventListener('click', () => {
    if (kioskOpen || sceneOverlayOpen) return;
    app.querySelectorAll('.mission button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const station = button.dataset.station;
    activeStation = station || 'kiosk';
    const messages: Record<string, string> = {
      kiosk: '出勤一体机：登录、查看揭示并完成信息确认',
      dispatcher: '出勤调度员：领取资料并完成面对面核对',
      notebook: '副司机：出乘小组会',
      cab: '人车核对：当前接入LKJ写卡后揭示信息查询；HXD3C驾驶台模型待补',
    };
    selection.textContent = messages[station || 'kiosk'];
    if (station === 'kiosk') {
      camera.position.set(-3.1, 1.65, -0.70);
      camera.lookAt(-3.1, 1.35, -2.55);
      yaw = camera.rotation.y;
      pitch = camera.rotation.x;
    } else if (station === 'dispatcher') {
      camera.position.set(2.75, 1.65, -1.10);
      camera.lookAt(dispatcherPosition[0],1.35,dispatcherPosition[2]);
      yaw = camera.rotation.y;
      pitch = camera.rotation.x;
      selection.textContent = '已来到出勤调度员附近，按E进行人人核对。';
    } else if (station === 'notebook') {
      camera.position.set(2.05, 1.65, 2.62+deputyForwardOffset);
      camera.lookAt(2.05, 1.05, 1.12+deputyForwardOffset);
      yaw = camera.rotation.y;
      pitch = camera.rotation.x;
      selection.textContent = '已来到副司机座位旁，按E填写司机手帐。';
    } else if (station === 'cab') {
      openLkjFlow(true);
    }
  });
});

window.addEventListener('resize', frame);
frame();

// Development-only inspection view. Movement and E still use the real scene
// collision/interaction paths; this does not grant access through closed doors.
if(import.meta.env.DEV&&new URLSearchParams(window.location.search).get('roomView')==='rear-door'){
  camera.position.set(0,1.65,6.65);camera.lookAt(0,1.3,8);
  yaw=camera.rotation.y;pitch=camera.rotation.x;
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  if (document.hidden) { clock.getDelta(); return; }
  const delta = Math.min(clock.getDelta(), 0.05);
  kioskCardInsertion?.update(delta);
  viewModelRoot.visible = !kioskOpen
    || (kioskController?.isRevealComparison() === true && selectedItem === 'delivery-reveal')
    || (activeKioskStep === 5 && selectedItem === 'ic-card');
  if (doorPivot) {
    const target = doorOpen ? -Math.PI / 2 : 0;
    doorPivot.rotation.y = THREE.MathUtils.damp(doorPivot.rotation.y, target, 7, delta);
  }
  if(rearDoorPivot)rearDoorPivot.rotation.y=THREE.MathUtils.damp(rearDoorPivot.rotation.y,rearDoorOpen?-Math.PI/2:0,7,delta);
  for(const {leaf,proxy} of movingDoorColliders){
    leaf.updateWorldMatrix(true,false);const bounds=new THREE.Box3().setFromObject(leaf);
    proxy.minX=bounds.min.x;proxy.maxX=bounds.max.x;proxy.minZ=bounds.min.z;proxy.maxZ=bounds.max.z;
  }
  if (breathPivot && breathAnimationTarget > 0) {
    breathAnimation = Math.min(1, breathAnimation + delta * 1.7);
    const eased = 1 - Math.pow(1 - breathAnimation, 3);
    breathPivot.quaternion.slerpQuaternions(breathPivotBaseQuaternion, breathPivotActionQuaternion, eased);
    breathPivot.position.copy(breathPivotRestPosition);
    if (breathAnimation >= 1) {
      breathAnimationTarget = 0;
      kioskController?.completeBreathTest();
    }
  }
  if (heldItem && selectedItem) {
    documentFanProgress = THREE.MathUtils.damp(documentFanProgress, documentFanTarget, 9, delta);
    if (selectedItem === 'documents') setHeldItemActionPose(heldItem, selectedItem, documentFanProgress);
    if (selectedItem === 'delivery-reveal' && kioskOpen && kioskController?.isRevealComparison()) {
      revealCloseProgress = THREE.MathUtils.damp(revealCloseProgress, revealView === 'paper' ? 1 : 0, 8, delta);
      revealHideProgress = THREE.MathUtils.damp(revealHideProgress, revealView === 'screen' ? 1 : 0, 8, delta);
      setDeliveryRevealViewPose(heldItem, revealCloseProgress, revealHideProgress);
    } else if (selectedItem === 'delivery-reveal') {
      revealInspectProgress = THREE.MathUtils.damp(revealInspectProgress, revealInspectTarget, 8, delta);
      setDeliveryRevealViewPose(heldItem, revealInspectProgress, 0);
    }
    if (selectedItem === 'notebook' && notebookOpen) {
      notebookInspectProgress = THREE.MathUtils.damp(notebookInspectProgress, notebookInspectTarget, 8, delta);
      setNotebookInspectionPose(heldItem, notebookInspectProgress);
    }
    if (heldActionActive) {
      heldActionElapsed = Math.min(0.68, heldActionElapsed + delta);
      const phase = heldActionElapsed / 0.68;
      const pulse = Math.sin(phase * Math.PI);
      const pushDistance = selectedItem === 'ic-card' ? 0.26 : selectedItem === 'delivery-reveal' ? 0.24 : 0.055;
      heldItem.position.copy(heldRestPosition);
      heldItem.position.z -= pulse * pushDistance;
      setHeldItemActionPose(heldItem, selectedItem, pulse);
      if (phase >= 1) {
        heldActionActive = false;
        heldItem.position.copy(heldRestPosition);
        setHeldItemActionPose(heldItem, selectedItem, selectedItem === 'documents' ? documentFanProgress : 0);
      }
    }
  }
  if (reviewMode) controls.update();
  else if (!kioskOpen && !sceneOverlayOpen) {
    const keyboardForward = Number(movement.has('KeyW') || movement.has('ArrowUp')) - Number(movement.has('KeyS') || movement.has('ArrowDown'));
    const keyboardSide = Number(movement.has('KeyD') || movement.has('ArrowRight')) - Number(movement.has('KeyA') || movement.has('ArrowLeft'));
    const forwardInput = THREE.MathUtils.clamp(keyboardForward + mobileMoveY, -1, 1);
    const sideInput = THREE.MathUtils.clamp(keyboardSide + mobileMoveX, -1, 1);
    if (forwardInput || sideInput) {
      const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const move = forward.multiplyScalar(forwardInput).add(right.multiplyScalar(sideInput)).normalize();
      const sprinting = mobileSprint || movement.has('ShiftLeft') || movement.has('ShiftRight');
      const desired = camera.position.clone().addScaledVector(move, delta * (sprinting ? 4.35 : 2.25));
      const resolved = resolvePlayerMove(camera.position, desired);
      camera.position.x = resolved.x;
      camera.position.z = resolved.z;
    }
    if (!grounded) {
      verticalVelocity -= 12.5 * delta;
      camera.position.y += verticalVelocity * delta;
      if (camera.position.y <= standingEyeHeight) {
        camera.position.y = standingEyeHeight;
        verticalVelocity = 0;
        grounded = true;
      }
    } else camera.position.y = standingEyeHeight;
    const promptLabel = interactionPrompt.querySelector<HTMLElement>('span');
    const promptButton = interactionPrompt.querySelector<HTMLButtonElement>('button');
    const nearby = nearestSceneInteraction();
    interactionPrompt.hidden = !nearby;
    const labels: Record<string, string> = { kiosk: '出勤一体机', dispatcher: '出勤调度员', notebook: '副司机', door: '出勤室门', 'rear-door':'派班室后门' };
    if (promptLabel) promptLabel.textContent = nearby ? `已靠近：${labels[nearby]}` : '';
    if (promptButton) promptButton.textContent = mobileMode ? '交互' : '交互（E）';
  }
  renderer.autoClear = true;
  renderer.info.reset();
  renderer.render(scene, camera);
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(viewModelScene, viewModelCamera);
  updatePerformanceDiagnostics();
  renderer.autoClear = true;
});
