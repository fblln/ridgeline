import { Check, Compass, Loader2, MapPin, Mountain, Search, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  cancelImportJob,
  importStages,
  qualityOptions,
  runGpxImport,
  type ImportQuality,
  type JobState,
} from "./import/importClient";
import type { ValleyManifest } from "./types";

type EntryTab = "search" | "coords" | "gpx";

// Search/coordinate entry still opens the bundled sample; GPX entry runs the
// local baker and then loads the generated assetBase returned by the server.
export function EntryScreen({ onLoad }: { onLoad: (valley?: ValleyManifest | null) => void }) {
  const [tab, setTab] = useState<EntryTab>("search");
  const [gpxFile, setGpxFile] = useState<File | null>(null);
  const [quality, setQuality] = useState<ImportQuality>("high");
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logUrl, setLogUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const jobIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  // Tick the elapsed timer while a job is running.
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const id = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => window.clearInterval(id);
  }, [busy]);

  async function importGpx(file: File) {
    setBusy(true);
    setError(null);
    cancelledRef.current = false;
    setJob({ progress: 2, step: "Uploading GPX", detail: file.name });
    try {
      const result = await runGpxImport({
        file,
        quality,
        isCancelled: () => cancelledRef.current,
        onJob: setJob,
        onJobId: (jobId) => {
          jobIdRef.current = jobId;
        },
        onLogUrl: setLogUrl,
      });
      onLoad(result.valley);
    } catch (caught) {
      if (cancelledRef.current) return;
      setError(caught instanceof Error ? caught.message : "Import failed.");
      setJob(null);
      setBusy(false);
    }
  }

  function cancelImport() {
    cancelledRef.current = true;
    if (jobIdRef.current) {
      void cancelImportJob(jobIdRef.current);
    }
    setBusy(false);
    setJob(null);
  }

  return (
    <main className="entry-screen">
      <form
        className="entry-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (tab === "gpx") {
            if (!gpxFile) {
              setError("Choose a .gpx file first.");
              return;
            }
            void importGpx(gpxFile);
          } else {
            onLoad();
          }
        }}
      >
        <div className="entry-brand">
          <div className="brand-mark">
            <Mountain size={20} />
          </div>
          <div>
            <h1>Ridgeline</h1>
            <p className="entry-tagline">Fly any valley from the sky · 2D / 3D LiDAR terrain</p>
          </div>
        </div>

        {busy && job ? (
          <ImportProgress job={job} elapsed={elapsed} />
        ) : (
          <>
            <div className="entry-tabs" role="tablist">
              <button type="button" className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>
                Search a place
              </button>
              <button type="button" className={tab === "coords" ? "active" : ""} onClick={() => setTab("coords")}>
                Lat, Long
              </button>
              <button type="button" className={tab === "gpx" ? "active" : ""} onClick={() => setTab("gpx")}>
                Import GPX
              </button>
            </div>

            {tab === "search" ? (
              <div className="entry-field">
                <div className="entry-input-wrap">
                  <Search size={16} />
                  <input className="entry-input has-icon" placeholder="Search a place or peak…" />
                </div>
              </div>
            ) : null}

            {tab === "coords" ? (
              <div className="entry-coords">
                <div className="entry-input-wrap">
                  <MapPin size={16} />
                  <input className="entry-input has-icon" placeholder="Latitude" defaultValue="45.0703" />
                </div>
                <input className="entry-input" placeholder="Longitude" defaultValue="6.6431" />
              </div>
            ) : null}

            {tab === "gpx" ? (
              <div className="entry-field">
                <div className="entry-input-wrap">
                  <Upload size={16} />
                  <input
                    className="entry-input has-icon"
                    type="file"
                    accept=".gpx"
                    onChange={(event) => {
                      setGpxFile(event.target.files?.[0] ?? null);
                      setError(null);
                    }}
                  />
                </div>
                <div className="quality-select" role="group" aria-label="Terrain quality">
                  {qualityOptions.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      title={option.tip}
                      aria-pressed={quality === option.id}
                      className={quality === option.id ? "active" : ""}
                      onClick={() => setQuality(option.id)}
                    >
                      <strong>{option.label}</strong>
                      <span>{option.res}/cell</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="entry-preview">
              <Compass className="compass" size={18} />
              <span>Terrain area follows the route bounds · Piemonte / France</span>
            </div>
          </>
        )}

        {error ? (
          <p className="entry-error">
            {error}
            {logUrl ? (
              <>
                {" · "}
                <a href={logUrl} target="_blank" rel="noreferrer">
                  view build log
                </a>
              </>
            ) : null}
          </p>
        ) : null}

        {busy ? (
          <button type="button" className="text-button wide" onClick={cancelImport}>
            Cancel import
          </button>
        ) : (
          <button type="submit" className="text-button primary wide">
            Load area
          </button>
        )}
      </form>
    </main>
  );
}

function ImportProgress({ job, elapsed }: { job: JobState; elapsed: number }) {
  // Current stage = the last one whose threshold the worker has reached.
  const currentIdx = importStages.reduce((acc, stage, i) => (job.progress >= stage.pct ? i : acc), 0);
  return (
    <div className="import-progress">
      <div className="import-head">
        <Loader2 className="spin" size={18} />
        <strong>{job.step}…</strong>
        <span className="import-meta">
          {Math.round(job.progress)}% · {elapsed.toFixed(0)}s
        </span>
      </div>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${job.progress}%` }} />
      </div>

      {/* Live worker output, useful when DEM/tile fetches are the slow path. */}
      <div className="import-detail">
        <span className="import-dot" />
        <code>{job.detail ?? "thinking…"}</code>
      </div>

      <ol className="import-stages">
        {importStages.map((stage, i) => {
          const state = i < currentIdx ? "done" : i === currentIdx ? "active" : "pending";
          return (
            <li key={stage.label} className={`import-stage ${state}`}>
              <span className="import-stage-icon">
                {state === "done" ? <Check size={13} /> : state === "active" ? <Loader2 className="spin" size={13} /> : null}
              </span>
              {stage.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
