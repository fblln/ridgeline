/**
 * Vite development middleware for GPX import and tracing proxy endpoints.
 *
 * The heavy work lives in web/server modules so request routing stays readable
 * and validation/job behavior can be tested without running the dev server.
 */
import type { Plugin } from "vite";
import { contextFromHeaders } from "./otel.node";
import { collectRequestBody, parseMultipartGpx, sendJson } from "./server/http";
import { cancelImportJob, getImportJob, queueImportJob } from "./server/importJobs";
import { parseQuality, validateSupportedRegion } from "./server/importValidation";

export function gpxImportServer(): Plugin {
  return {
    name: "ridgeline-gpx-import-server",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const requestUrl = new URL(request.url ?? "/", "http://localhost");

          if (request.method === "POST" && requestUrl.pathname === "/v1/traces") {
            const body = await collectRequestBody(request, 8 * 1024 * 1024);
            const otlp = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318").replace(/\/$/, "");
            const upstream = await fetch(`${otlp}/v1/traces`, {
              method: "POST",
              headers: { "content-type": request.headers["content-type"] ?? "application/json" },
              body: new Uint8Array(body),
            }).catch(() => null);
            response.statusCode = upstream?.status ?? 502;
            response.setHeader("content-type", "application/json");
            response.end(upstream ? await upstream.text() : "{}");
            return;
          }

          if (request.method === "POST" && requestUrl.pathname === "/api/import-gpx") {
            const quality = parseQuality(requestUrl);
            const body = await collectRequestBody(request);
            const upload = parseMultipartGpx(request, body);
            validateSupportedRegion(upload.text);
            const job = queueImportJob({
              server,
              quality,
              upload,
              parentContext: contextFromHeaders(request.headers),
            });
            sendJson(response, 202, { jobId: job.id, status: job.status });
            return;
          }

          const cancelMatch = requestUrl.pathname.match(/^\/api\/import-jobs\/([a-f0-9]{16})$/);
          if (request.method === "DELETE" && cancelMatch) {
            const job = cancelImportJob(cancelMatch[1]);
            if (!job) {
              sendJson(response, 404, { status: "error", message: "Import job not found." });
              return;
            }
            sendJson(response, 200, { status: "cancelled" });
            return;
          }

          const jobMatch = requestUrl.pathname.match(/^\/api\/import-jobs\/([a-f0-9]{16})(?:\/result)?$/);
          if (request.method === "GET" && jobMatch) {
            const job = getImportJob(jobMatch[1]);
            if (!job) {
              sendJson(response, 404, { status: "error", message: "Import job not found." });
              return;
            }
            if (requestUrl.pathname.endsWith("/result")) {
              if (job.status !== "ready") {
                sendJson(response, 409, { status: job.status, message: job.error ?? job.step });
                return;
              }
              sendJson(response, 200, { status: "ready", assetBase: job.assetBase });
              return;
            }
            sendJson(response, 200, job);
            return;
          }
        } catch (error) {
          sendJson(response, 400, {
            status: "error",
            message: error instanceof Error ? error.message : "Could not import GPX.",
          });
          return;
        }
        next();
      });
    },
  };
}
