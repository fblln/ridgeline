import { useCallback, useEffect, useMemo, useState } from "react";
import { cumulativeMinutes } from "./app/routeTime";
import { mapLayers } from "./app/viewerLabels";
import {
  CameraToolbar,
  ControlPanel,
  CoordReadout,
  ExportPreview,
  Hud,
  LoadingOverlay,
  MovePanel,
  ReplayTimeline,
  ShotPanel,
  TopBar,
} from "./components/ViewerChrome";
import { EntryScreen } from "./EntryScreen";
import { initialShots, valleys } from "./mockData";
import { TerrainViewer } from "./TerrainViewer";
import type {
  AppStatus,
  CameraMode,
  CameraSnapshot,
  RouteAsset,
  SavedShot,
  TextureMode,
  ValleyManifest,
  ViewerState,
  ViewMode,
} from "./types";

type Screen = "entry" | "loading" | "viewer";

const replayDurationMs = 68000;

export function App() {
  const [screen, setScreen] = useState<Screen>("entry");
  const [currentCamera, setCurrentCamera] = useState<CameraSnapshot>({
    position: [3293, -3364, 3828],
    target: [3114, 2499, 2150],
    fov: 42,
    altitudeM: 3828,
    distanceToRouteM: 0,
    headingDeg: 0,
  });
  const [viewerState, setViewerState] = useState<ViewerState>({
    valleyId: valleys[0].id,
    routeId: valleys[0].routes[0].id,
    viewMode: "3d",
    cameraMode: "orbit",
    quality: "high",
    textureMode: "topographic",
    verticalExaggeration: 1.5,
    showRoute: true,
    selectedShotId: initialShots[0].id,
  });
  const [shots, setShots] = useState<SavedShot[]>(initialShots);
  const [replayPosition, setReplayPosition] = useState(0);
  const [isReplayPreviewing, setIsReplayPreviewing] = useState(false);
  const [loadedRoute, setLoadedRoute] = useState<RouteAsset | null>(null);
  const [dynamicValley, setDynamicValley] = useState<ValleyManifest | null>(null);
  const [exportImageUrl, setExportImageUrl] = useState<string | null>(null);
  const [commands, setCommands] = useState({
    frameRoute: 0,
    reset: 0,
    exportImage: 0,
  });

  const status: AppStatus = screen === "loading" ? "loading" : "ready";

  const activeValley = useMemo(
    () => dynamicValley ?? valleys.find((valley) => valley.id === viewerState.valleyId) ?? null,
    [dynamicValley, viewerState.valleyId],
  );

  const activeRoute = useMemo(
    () => activeValley?.routes.find((route) => route.id === viewerState.routeId) ?? null,
    [activeValley, viewerState.routeId],
  );

  const selectedShot = useMemo(
    () => shots.find((shot) => shot.id === viewerState.selectedShotId) ?? null,
    [shots, viewerState.selectedShotId],
  );

  const centerCoords = useMemo(() => {
    const b = activeValley?.bounds;
    if (!b) return "—";
    return `${((b[1] + b[3]) / 2).toFixed(4)}, ${((b[0] + b[2]) / 2).toFixed(4)}`;
  }, [activeValley]);

  const replayCumMin = useMemo(() => (loadedRoute ? cumulativeMinutes(loadedRoute.points) : null), [loadedRoute]);

  const replayInfo = useMemo(() => {
    const points = loadedRoute?.points;
    if (!points || points.length < 2) return { km: 0, minutes: 0 };
    const idx = Math.round((replayPosition / 100) * (points.length - 1));
    return { km: points[idx].d / 1000, minutes: replayCumMin?.[idx] ?? 0 };
  }, [loadedRoute, replayCumMin, replayPosition]);

  const setMode = useCallback((cameraMode: CameraMode) => {
    setViewerState((state) => ({
      ...state,
      cameraMode,
      viewMode: cameraMode === "orbit" ? state.viewMode : "3d",
    }));
  }, []);

  const setViewMode = (viewMode: ViewMode) => {
    setViewerState((state) => ({ ...state, viewMode }));
  };

  const setTextureMode = (textureMode: TextureMode) => {
    setViewerState((state) => ({ ...state, textureMode }));
  };

  const addShot = () => {
    const nextShot: SavedShot = {
      id: `shot-${Date.now()}`,
      name: `View ${shots.length + 1}`,
      cameraPosition: currentCamera.position,
      target: currentCamera.target,
      fov: Math.round(currentCamera.fov),
      verticalExaggeration: viewerState.verticalExaggeration,
      textureMode: viewerState.textureMode,
      showRoute: viewerState.showRoute,
    };
    setShots((current) => [nextShot, ...current]);
    setViewerState((state) => ({ ...state, selectedShotId: nextShot.id }));
  };

  const activeRouteStats = loadedRoute ?? activeRoute;

  // Stable so the viewer's asset-loading effect doesn't refetch+rebuild every render.
  const handleAssetsLoaded = useCallback((route: RouteAsset | null) => {
    setLoadedRoute(route);
    setScreen((current) => (current === "loading" ? "viewer" : current));
  }, []);

  useEffect(() => {
    if (!isReplayPreviewing) return;
    setMode("route-follow");
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(120, now - previous);
      previous = now;
      setReplayPosition((value) => Math.min(100, value + (dt / replayDurationMs) * 100));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isReplayPreviewing, setMode]);

  // Stop at the end instead of looping back to the start.
  useEffect(() => {
    if (isReplayPreviewing && replayPosition >= 100) setIsReplayPreviewing(false);
  }, [isReplayPreviewing, replayPosition]);

  useEffect(() => {
    const onExportReady = (event: Event) => {
      const customEvent = event as CustomEvent<{ dataUrl?: string }>;
      if (customEvent.detail?.dataUrl) {
        setExportImageUrl(customEvent.detail.dataUrl);
      }
    };
    window.addEventListener("trek-export-ready", onExportReady);
    return () => window.removeEventListener("trek-export-ready", onExportReady);
  }, []);

  // Map-layer keyboard shortcuts (T/L/S/H), only in the viewer and not while typing.
  useEffect(() => {
    if (screen !== "viewer") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const layer = mapLayers.find((item) => item.key.toLowerCase() === event.key.toLowerCase());
      if (layer) setTextureMode(layer.mode);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen]);

  const copyShareLink = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("valley", viewerState.valleyId ?? "");
    url.searchParams.set("route", viewerState.routeId ?? "");
    url.searchParams.set("mode", viewerState.cameraMode);
    url.searchParams.set("shot", viewerState.selectedShotId ?? "");
    await navigator.clipboard?.writeText(url.toString());
  };

  const requestImageExport = () => {
    window.dispatchEvent(new Event("trek-export-image"));
  };

  if (screen === "entry") {
    return (
      <EntryScreen
        onLoad={(valley) => {
          if (valley) {
            setDynamicValley(valley);
            setViewerState((state) => ({
              ...state,
              valleyId: valley.id,
              routeId: valley.routes[0]?.id ?? null,
            }));
          }
          setScreen("loading");
        }}
      />
    );
  }

  const routeName = activeRouteStats?.name ?? "No route";

  return (
    <main className="app-shell">
      <TerrainViewer
        status={status}
        valley={activeValley}
        routeId={viewerState.routeId}
        state={viewerState}
        selectedShot={selectedShot}
        replayPosition={replayPosition}
        commands={commands}
        onCameraChange={setCurrentCamera}
        onAssetsLoaded={handleAssetsLoaded}
      />

      {screen === "loading" ? (
        <LoadingOverlay />
      ) : (
        <>
          <TopBar
            state={viewerState}
            routeName={routeName}
            routeDistanceKm={activeRouteStats?.distanceKm ?? 0}
            elevationGainM={activeRouteStats?.elevationGainM ?? 0}
            onViewModeChange={setViewMode}
            onShare={copyShareLink}
            onExport={requestImageExport}
            onReset={() => {
              setViewerState((state) => ({
                ...state,
                cameraMode: "orbit",
                selectedShotId: initialShots[0].id,
              }));
              setCommands((current) => ({ ...current, reset: current.reset + 1 }));
            }}
          />

          <CoordReadout coords={centerCoords} altitudeM={currentCamera.altitudeM} />

          {activeValley?.attribution?.length ? (
            <div className="attribution-badge" title={activeValley.attribution.join("\n")}>
              {activeValley.attribution[0]}
            </div>
          ) : null}

          <Hud state={viewerState} camera={currentCamera} />

          <div className="right-rail">
            <ControlPanel
              state={viewerState}
              onStateChange={setViewerState}
              onTextureChange={setTextureMode}
              onToggleRoute={() => setViewerState((state) => ({ ...state, showRoute: !state.showRoute }))}
            />
            <ShotPanel
              shots={shots}
              selectedShotId={viewerState.selectedShotId}
              onSelect={(selectedShotId) => setViewerState((state) => ({ ...state, selectedShotId }))}
              onAdd={addShot}
            />
          </div>

          <CameraToolbar
            activeMode={viewerState.cameraMode}
            onModeChange={setMode}
            onFrameRoute={() => {
              setMode("orbit");
              setCommands((current) => ({ ...current, frameRoute: current.frameRoute + 1 }));
            }}
          />

          <MovePanel state={viewerState} />

          <ReplayTimeline
            value={replayPosition}
            distanceKm={replayInfo.km}
            minutes={replayInfo.minutes}
            isPreviewing={isReplayPreviewing}
            onChange={(value) => {
              setReplayPosition(value);
              setMode("route-follow");
            }}
            onTogglePreview={() => {
              setReplayPosition((pos) => (pos >= 100 ? 0 : pos));
              setIsReplayPreviewing((value) => !value);
            }}
          />

          {exportImageUrl ? <ExportPreview imageUrl={exportImageUrl} onClose={() => setExportImageUrl(null)} /> : null}
        </>
      )}
    </main>
  );
}
