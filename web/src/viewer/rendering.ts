/**
 * Rendering helpers shared by the live canvas and high-resolution export.
 * Marker sprites render on a separate layer so they stay crisp over composer output.
 */
import * as THREE from "three";
import { exportHeight, exportWidth, markerOverlayLayer, sceneLayer } from "./constants";
import type { RenderPipeline } from "./types";

export function renderSceneWithMarkerOverlay(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  pipeline: RenderPipeline | null,
  marker: THREE.Sprite | null,
) {
  const previousLayerMask = camera.layers.mask;
  const previousAutoClear = renderer.autoClear;
  const previousBackground = scene.background;
  camera.layers.set(sceneLayer);
  if (pipeline?.composer) pipeline.composer.render();
  else renderer.render(scene, camera);

  if (marker?.visible) {
    renderer.autoClear = false;
    renderer.clearDepth();
    scene.background = null;
    camera.layers.set(markerOverlayLayer);
    renderer.render(scene, camera);
  }

  scene.background = previousBackground;
  renderer.autoClear = previousAutoClear;
  camera.layers.mask = previousLayerMask;
}

export function exportRendererImage(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  pipeline: RenderPipeline | null,
  marker: THREE.Sprite | null = null,
) {
  const previousSize = new THREE.Vector2();
  renderer.getSize(previousSize);
  const previousPixelRatio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setSize(exportWidth, exportHeight, false);
  pipeline?.composer?.setSize(exportWidth, exportHeight);
  pipeline?.fxaaPass?.setSize(exportWidth, exportHeight);
  pipeline?.ssaoPass?.setSize(exportWidth, exportHeight);
  camera.aspect = exportWidth / exportHeight;
  camera.updateProjectionMatrix();
  renderSceneWithMarkerOverlay(renderer, scene, camera, pipeline, marker);
  const dataUrl = renderer.domElement.toDataURL("image/png");
  renderer.setPixelRatio(previousPixelRatio);
  renderer.setSize(previousSize.x, previousSize.y, false);
  pipeline?.composer?.setSize(previousSize.x, previousSize.y);
  pipeline?.fxaaPass?.setSize(previousSize.x, previousSize.y);
  pipeline?.ssaoPass?.setSize(previousSize.x, previousSize.y);
  camera.aspect = previousSize.x / previousSize.y;
  camera.updateProjectionMatrix();
  renderSceneWithMarkerOverlay(renderer, scene, camera, pipeline, marker);
  window.dispatchEvent(
    new CustomEvent("trek-export-ready", {
      detail: { dataUrl },
    }),
  );
}
