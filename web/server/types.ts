/**
 * Import server contracts. These are local development API shapes used by the
 * Vite middleware; they are not browser runtime asset schemas.
 */
export type ImportJobStatus = "queued" | "processing" | "ready" | "error";
export type ImportQuality = "fast" | "high" | "ultra";

export type ImportJob = {
  id: string;
  status: ImportJobStatus;
  progress: number;
  step: string;
  quality: ImportQuality;
  assetBase?: string;
  error?: string;
  detail?: string;
  logUrl?: string;
  createdAt: number;
};

export type UploadedGpx = {
  filename: string;
  text: string;
};
