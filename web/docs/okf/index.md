---
type: Index
title: Trek Camera Viewer — Knowledge Bundle
description: OKF v0.1 wiki for the trek-camera-viewer web app, a React + three.js LiDAR terrain and route camera tool.
tags: [react, threejs, terrain, viewer]
timestamp: 2026-06-27T00:00:00Z
---

# Trek Camera Viewer

A single-page React 19 + Vite app that renders an exported LiDAR heightfield in three.js, draws a GPX-derived route over it, and lets the user frame, save, and export camera shots. All UI is mock-state driven; terrain/route assets stream from a per-valley manifest.

## Concepts

- [Architecture](/architecture.md) — how the pieces fit and the data flow
- [App shell & UI panels](/app-shell.md) — `App.tsx` state owner and HUD/toolbar/panels
- [Terrain viewer](/terrain-viewer.md) — `TerrainViewer.tsx` three.js render engine
- [Data model](/data-model.md) — `types.ts` shared TypeScript types
- [Mock data & manifests](/mock-data.md) — `mockData.ts` valleys and saved shots
- [Dev & build runbook](/dev-runbook.md) — how to run, build, preview

## Stack

React 19, TypeScript, Vite 6, three.js 0.185 (EffectComposer / FXAA / SSAO), lucide-react icons.
