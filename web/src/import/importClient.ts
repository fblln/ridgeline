/**
 * Browser-side client for the local GPX import API. The UI owns cancellation
 * state, while this module owns the request/poll/load sequence and response
 * normalization.
 */
import type { ValleyManifest } from "../types";

export type JobState = { progress: number; step: string; detail?: string };
export type ImportQuality = "fast" | "high" | "ultra";

export const importStages: Array<{ pct: number; label: string }> = [
  { pct: 5, label: "Starting worker" },
  { pct: 8, label: "Reading GPX track" },
  { pct: 22, label: "Fetching elevation (DEM)" },
  { pct: 58, label: "Sampling route & terrain" },
  { pct: 70, label: "Building map textures" },
  { pct: 82, label: "Rendering relief & slope" },
  { pct: 90, label: "Adding forest layer" },
  { pct: 97, label: "Finalizing assets" },
];

export const qualityOptions: Array<{ id: ImportQuality; label: string; res: string; tip: string }> = [
  {
    id: "fast",
    label: "Fast",
    res: "~8 m",
    tip: "Quick preview - targets ~8 m/cell terrain, 4K map textures, coarser route. Fastest.",
  },
  {
    id: "high",
    label: "High",
    res: "~5 m",
    tip: "Balanced default - targets ~5 m/cell terrain, 8K map textures.",
  },
  {
    id: "ultra",
    label: "Ultra",
    res: "~3 m",
    tip: "Export quality - targets ~3 m/cell terrain, 8K textures, densest route. Slowest.",
  },
];

type ImportJobResponse = {
  jobId: string;
  status?: "queued" | "processing" | "ready" | "error";
  message?: string;
};

type PollResponse = {
  status: "queued" | "processing" | "ready" | "error";
  progress?: number;
  step?: string;
  detail?: string;
  error?: string;
  message?: string;
  logUrl?: string;
  assetBase?: string;
};

const pollIntervalMs = 1200;

export async function cancelImportJob(jobId: string) {
  await fetch(`/api/import-jobs/${jobId}`, { method: "DELETE" });
}

export async function runGpxImport({
  file,
  quality,
  isCancelled,
  onJob,
  onJobId,
  onLogUrl,
}: {
  file: File;
  quality: ImportQuality;
  isCancelled: () => boolean;
  onJob: (job: JobState) => void;
  onJobId: (jobId: string) => void;
  onLogUrl: (url: string | null) => void;
}): Promise<{ jobId: string; valley: ValleyManifest }> {
  const form = new FormData();
  form.append("file", file);
  const startRes = await fetch(`/api/import-gpx?quality=${quality}`, { method: "POST", body: form });
  const start = (await startRes.json()) as ImportJobResponse;
  if (!startRes.ok || start.status === "error") {
    throw new Error(start.message ?? "Could not import this GPX.");
  }
  onJobId(start.jobId);
  onLogUrl(null);

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (isCancelled()) throw new Error("Import cancelled.");

    const data = (await (await fetch(`/api/import-jobs/${start.jobId}`)).json()) as PollResponse;
    if (data.status === "error") {
      if (data.logUrl) onLogUrl(data.logUrl);
      throw new Error(data.error ?? data.message ?? "Import failed.");
    }
    onJob({ progress: data.progress ?? 0, step: data.step ?? "Working", detail: data.detail });
    if (data.status === "ready") {
      onJob({ progress: 99, step: "Loading viewer", detail: "Fetching generated assets" });
      if (!data.assetBase) throw new Error("Import finished without an asset path.");
      const manifestRes = await fetch(`${data.assetBase}manifest.json`);
      if (!manifestRes.ok) throw new Error("Generated assets are missing - re-import to rebuild them.");
      const manifest = (await manifestRes.json()) as ValleyManifest;
      return { jobId: start.jobId, valley: { ...manifest, assetBase: data.assetBase } };
    }
  }
}
