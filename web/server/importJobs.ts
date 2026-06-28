/**
 * Local GPX import job runner. It owns temporary upload paths, Python worker
 * lifecycle, progress parsing, and trace propagation into the asset baker.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context, Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ViteDevServer } from "vite";
import { traceparentFor, tracer } from "../otel.node";
import type { ImportJob, ImportQuality, UploadedGpx } from "./types";
import { importJobId, lastErrorLine, qualityEnv, slugify, titleFromFilename } from "./importValidation";

const jobs = new Map<string, ImportJob>();
const jobChildren = new Map<string, ChildProcess>();

export function getImportJob(jobId: string) {
  return jobs.get(jobId) ?? null;
}

export function cancelImportJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status === "processing" || job.status === "queued") {
    job.status = "error";
    job.error = "Import cancelled.";
    job.step = "Cancelled";
    jobChildren.get(job.id)?.kill("SIGTERM");
    jobChildren.delete(job.id);
  }
  return job;
}

export function queueImportJob({
  server,
  quality,
  upload,
  parentContext,
}: {
  server: ViteDevServer;
  quality: ImportQuality;
  upload: UploadedGpx;
  parentContext: Context;
}) {
  const jobId = importJobId(upload.text, quality);
  let job = jobs.get(jobId);
  if (!job) {
    job = {
      id: jobId,
      status: "queued",
      progress: 2,
      step: "Queued",
      quality,
      createdAt: Date.now(),
    };
    jobs.set(jobId, job);
    const startedJob = job;
    startJob({ server, job: startedJob, gpxText: upload.text, filename: upload.filename, parentContext }).catch((error: unknown) => {
      startedJob.status = "error";
      startedJob.error = error instanceof Error ? error.message : "Import failed.";
      startedJob.step = "Import failed";
    });
  }
  return job;
}

async function startJob({
  server,
  job,
  gpxText,
  filename,
  parentContext,
}: {
  server: ViteDevServer;
  job: ImportJob;
  gpxText: string;
  filename: string;
  parentContext: Context;
}) {
  const webRoot = server.config.root;
  const repoRoot = path.resolve(webRoot, "..");
  const generatedRoot = path.join(webRoot, "public", "generated");
  const uploadRoot = path.join(generatedRoot, ".uploads");
  const outDir = path.join(generatedRoot, job.id);
  const gpxPath = path.join(uploadRoot, `${job.id}.gpx`);
  const manifestPath = path.join(outDir, "manifest.json");

  await mkdir(uploadRoot, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(gpxPath, gpxText, "utf8");

  const manifestExists = await readFile(manifestPath, "utf8").then(() => true).catch(() => false);
  if (manifestExists) {
    job.status = "ready";
    job.progress = 100;
    job.step = "Loaded from cache";
    job.assetBase = `/generated/${job.id}/`;
    return;
  }

  job.status = "processing";
  job.progress = 5;
  job.step = "Starting worker";

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const routeId = slugify(path.basename(filename, path.extname(filename)));
  const routeName = titleFromFilename(filename);
  const python = process.env.PYTHON ?? "/opt/miniconda3/bin/python";
  const exporter = path.join(repoRoot, "tools", "asset-baker", "export_web_example.py");
  const missingReference = path.join(uploadRoot, `${job.id}-reference-not-required.png`);
  const missingAngles = path.join(uploadRoot, `${job.id}-angles-not-required.png`);

  const jobSpan: Span = tracer.startSpan(
    "import-job",
    { attributes: { "import.job_id": job.id, "import.quality": job.quality, "import.source": path.basename(filename) } },
    parentContext,
  );
  const traceparent = traceparentFor(jobSpan);

  const child = spawn(python, [exporter, gpxPath, missingReference, missingAngles, outDir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...qualityEnv(job.quality),
      WEB_ROUTE_ID: routeId,
      WEB_ROUTE_NAME: routeName,
      WEB_SOURCE_NAME: path.basename(filename),
      OTEL_SERVICE_NAME: "ridgeline-worker",
      ...(traceparent ? { TRACEPARENT: traceparent } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  jobChildren.set(job.id, child);

  const logPath = path.join(outDir, "build.log");
  const logLines: string[] = [`# ${new Date(job.createdAt).toISOString()} quality=${job.quality} source=${filename}`];
  const onLine = (line: string) => {
    logLines.push(line);
    const text = line.trim();
    if (!text) return;
    const phase = text.match(/^progress:(\d+)\s+(.*)$/);
    if (phase) {
      job.progress = Math.max(job.progress, Math.min(99, Number(phase[1])));
      job.step = phase[2].slice(0, 80);
    } else {
      job.detail = text.slice(0, 160);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    chunk.toString("utf8").split(/\r?\n/).forEach(onLine);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    chunk.toString("utf8").split(/\r?\n/).forEach(onLine);
  });
  child.on("error", (error) => {
    job.status = "error";
    job.error = error.message;
    job.step = "Import failed";
  });
  child.on("close", (code) => {
    jobChildren.delete(job.id);
    const seconds = ((Date.now() - job.createdAt) / 1000).toFixed(1);
    logLines.push(`# exit=${code} duration=${seconds}s`);
    job.logUrl = `/generated/${job.id}/build.log`;
    void writeFile(logPath, logLines.join("\n"), "utf8").catch(() => {});
    jobSpan.setAttribute("import.duration_s", Number(seconds));
    if (job.status === "error") {
      jobSpan.setStatus({ code: SpanStatusCode.ERROR, message: job.error ?? "cancelled" });
      jobSpan.end();
      return;
    }
    if (code === 0) {
      job.status = "ready";
      job.progress = 100;
      job.step = "Ready";
      job.assetBase = `/generated/${job.id}/`;
      jobSpan.setStatus({ code: SpanStatusCode.OK });
      console.log(`[gpx-import] ${job.id} ready in ${seconds}s (${job.quality}) - ${filename}`);
    } else {
      const reason = lastErrorLine(logLines);
      job.status = "error";
      job.error = reason ? `Asset generation failed: ${reason}` : `Asset generation failed (exit ${code ?? "unknown"}).`;
      job.step = "Import failed";
      jobSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason || `exit ${code}` });
      console.warn(`[gpx-import] ${job.id} FAILED after ${seconds}s (exit ${code}) - ${filename}\n  ${reason}\n  full log: ${logPath}`);
    }
    jobSpan.end();
  });
}
