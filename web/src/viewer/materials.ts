/**
 * Texture, shader, lighting, and post-processing policy for terrain layers.
 * Layer modes intentionally tune lighting differently so paper maps, LiDAR
 * shading, slope maps, and forest masks remain readable on the same mesh.
 */
import * as THREE from "three";
import type { ViewerState } from "../types";
import { neutralReliefTexture, terrainLightingPresets } from "./constants";
import type { RenderPipeline, TerrainLightingRig } from "./types";

export function isPaperTextureMode(textureMode: ViewerState["textureMode"]) {
  return textureMode === "topographic" || textureMode === "raw-topo";
}

export function configureColorTexture(
  texture: THREE.Texture,
  renderer: THREE.WebGLRenderer | null,
  textureMode: ViewerState["textureMode"],
) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = !isPaperTextureMode(textureMode);
  texture.minFilter = isPaperTextureMode(textureMode) ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
}

export function configureReliefTexture(texture: THREE.Texture, renderer: THREE.WebGLRenderer | null) {
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
}

export function installTerrainReliefShader(material: THREE.MeshPhongMaterial) {
  material.onBeforeCompile = (shader) => {
    const userData = material.userData as {
      terrainReliefTexture?: THREE.Texture | null;
      terrainReliefIntensity?: number;
      terrainReliefContrast?: number;
      terrainForestTexture?: THREE.Texture | null;
      terrainForestIntensity?: number;
      terrainReliefUniforms?: Record<string, { value: unknown }>;
    };
    shader.uniforms.terrainReliefMap = {
      value: userData.terrainReliefTexture ?? neutralReliefTexture,
    };
    shader.uniforms.terrainReliefIntensity = {
      value: userData.terrainReliefIntensity ?? 0,
    };
    shader.uniforms.terrainReliefContrast = {
      value: userData.terrainReliefContrast ?? 1,
    };
    shader.uniforms.terrainForestMap = {
      value: userData.terrainForestTexture ?? neutralReliefTexture,
    };
    shader.uniforms.terrainForestIntensity = {
      value: userData.terrainForestIntensity ?? 0,
    };
    userData.terrainReliefUniforms = shader.uniforms;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_pars_fragment>",
      `#include <map_pars_fragment>
uniform sampler2D terrainReliefMap;
uniform float terrainReliefIntensity;
uniform float terrainReliefContrast;
uniform sampler2D terrainForestMap;
uniform float terrainForestIntensity;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>
#ifdef USE_MAP
  // Papery look on map layers: desaturate the vivid OSM colours and warm them toward cream.
  if ( terrainReliefIntensity > 0.0 ) {
    float paperLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
    vec3 paper = mix( diffuseColor.rgb, vec3( paperLum ), 0.55 );
    paper *= vec3( 1.05, 1.0, 0.88 );
    diffuseColor.rgb = mix( diffuseColor.rgb, paper, 0.65 );
  }
  float terrainRelief = texture2D( terrainReliefMap, vMapUv ).r;
  terrainRelief = clamp( ( terrainRelief - 0.5 ) * terrainReliefContrast + 0.5, 0.0, 1.0 );
  // Centred on 1.0 so relief lightens highlights and darkens shadows equally (no net darkening).
  float terrainReliefFactor = mix( 1.0, 0.72 + 0.56 * terrainRelief, terrainReliefIntensity );
  diffuseColor.rgb *= terrainReliefFactor;
  // Hint canopy from the forest layer: multiplicative green tint keeps the relief detail underneath.
  if ( terrainForestIntensity > 0.0 ) {
    vec3 terrainForestTexel = texture2D( terrainForestMap, vMapUv ).rgb;
    float terrainForestMask = clamp( ( terrainForestTexel.g - max( terrainForestTexel.r, terrainForestTexel.b ) ) * 6.0, 0.0, 1.0 );
    vec3 terrainForested = diffuseColor.rgb * vec3( 0.66, 0.92, 0.58 );
    diffuseColor.rgb = mix( diffuseColor.rgb, terrainForested, terrainForestMask * terrainForestIntensity );
  }
#endif`,
    );
  };
  material.customProgramCacheKey = () => "terrain-relief-v4";
}

export function applyTerrainReliefPreset(
  textureMode: ViewerState["textureMode"],
  material: THREE.MeshPhongMaterial | null,
  reliefTexture: THREE.Texture | null,
  forestTexture: THREE.Texture | null,
) {
  if (!material) return;
  const relief = terrainLightingPresets[textureMode].relief;
  const userData = material.userData as {
    terrainReliefTexture?: THREE.Texture | null;
    terrainReliefIntensity?: number;
    terrainReliefContrast?: number;
    terrainForestTexture?: THREE.Texture | null;
    terrainForestIntensity?: number;
    terrainReliefUniforms?: Record<string, { value: unknown }>;
  };
  userData.terrainReliefTexture = reliefTexture ?? neutralReliefTexture;
  userData.terrainReliefIntensity = relief?.intensity ?? 0;
  userData.terrainReliefContrast = relief?.contrast ?? 1;
  userData.terrainForestTexture = forestTexture ?? neutralReliefTexture;
  userData.terrainForestIntensity = forestTexture ? (relief?.forest ?? 0) : 0;
  const uniforms = userData.terrainReliefUniforms;
  if (uniforms) {
    uniforms.terrainReliefMap.value = userData.terrainReliefTexture;
    uniforms.terrainReliefIntensity.value = userData.terrainReliefIntensity;
    uniforms.terrainReliefContrast.value = userData.terrainReliefContrast;
    uniforms.terrainForestMap.value = userData.terrainForestTexture;
    uniforms.terrainForestIntensity.value = userData.terrainForestIntensity;
  }
  material.needsUpdate = true;
}

export function applyPostProcessingForTextureMode(
  textureMode: ViewerState["textureMode"],
  pipeline: RenderPipeline | null,
) {
  if (!pipeline) return;
  if (pipeline.fxaaPass) pipeline.fxaaPass.enabled = true;
  if (pipeline.ssaoPass) {
    pipeline.ssaoPass.enabled = true;
    pipeline.ssaoPass.kernelRadius = isPaperTextureMode(textureMode) ? 14 : 12;
    pipeline.ssaoPass.minDistance = isPaperTextureMode(textureMode) ? 0.001 : 0.0015;
    pipeline.ssaoPass.maxDistance = isPaperTextureMode(textureMode) ? 0.045 : 0.04;
  }
}

export function getTerrainLightingPreset(textureMode: ViewerState["textureMode"], hasTexture: boolean) {
  return hasTexture ? terrainLightingPresets[textureMode] : terrainLightingPresets.surface;
}

export function applyTerrainLightingPreset(
  textureMode: ViewerState["textureMode"],
  hasTexture: boolean,
  span: number,
  rig: TerrainLightingRig | null,
) {
  if (!rig) return;
  const preset = getTerrainLightingPreset(textureMode, hasTexture);
  rig.renderer.toneMappingExposure = preset.exposure;
  rig.ambient.color.setHex(preset.ambient.color);
  rig.ambient.intensity = preset.ambient.intensity;
  rig.hemi.color.setHex(preset.hemisphere.skyColor);
  rig.hemi.groundColor.setHex(preset.hemisphere.groundColor);
  rig.hemi.intensity = preset.hemisphere.intensity;
  rig.sun.color.setHex(preset.sun.color);
  rig.sun.intensity = preset.sun.intensity;
  rig.sun.position.set(span * preset.sun.position[0], span * preset.sun.position[1], span * preset.sun.position[2]);
  rig.headlight.color.setHex(preset.headlight.color);
  rig.headlight.intensity = preset.headlight.intensity;
  if (rig.terrainMaterial) {
    rig.terrainMaterial.emissive.setHex(preset.material.emissive);
    rig.terrainMaterial.emissiveIntensity = preset.material.emissiveIntensity;
    rig.terrainMaterial.needsUpdate = true;
  }
}
