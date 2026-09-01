import type * as THREE from 'three';

/** Opt-in local diagnostics only; nothing is collected or transmitted. */
export function createPerformanceDiagnostics(renderer: THREE.WebGLRenderer): () => void {
  if (!new URLSearchParams(location.search).has('diagnostics')) return () => {};
  const output = document.createElement('output');
  output.id = 'performance-diagnostics';
  output.setAttribute('aria-label', '本地性能诊断');
  Object.assign(output.style, { position: 'fixed', top: '8px', right: '8px', zIndex: '100',
    background: '#102d2deb', color: 'white', padding: '10px', font: '13px monospace', whiteSpace: 'pre', pointerEvents: 'none' });
  document.body.append(output);
  let previous = performance.now(), frames = 0;
  return () => {
    frames++;
    const now = performance.now();
    if (now - previous < 1000) return;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    output.textContent = `本地性能诊断\nFPS ${(frames * 1000 / (now - previous)).toFixed(0)} · DPR ${renderer.getPixelRatio()}\nGPU 几何 ${renderer.info.memory.geometries} · 纹理 ${renderer.info.memory.textures}\n绘制 ${renderer.info.render.calls} · 三角形 ${renderer.info.render.triangles}\nJS 堆 ${heap ? (heap.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : '浏览器未提供'}`;
    previous = now; frames = 0;
  };
}
