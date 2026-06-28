/**
 * Small HTTP helpers for the local Vite middleware. Uploads are intentionally
 * bounded because the baker runs locally and stores temporary GPX files.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UploadedGpx } from "./types";

export function sendJson(response: ServerResponse, statusCode: number, data: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(data));
}

export function collectRequestBody(request: IncomingMessage, maxBytes = 30 * 1024 * 1024) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("GPX upload is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export function parseMultipartGpx(request: IncomingMessage, body: Buffer): UploadedGpx {
  const contentType = request.headers["content-type"] ?? "";
  const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
  if (!boundary) throw new Error("Missing multipart boundary.");

  const bodyText = body.toString("utf8");
  const parts = bodyText.split(`--${boundary}`);
  const filePart = parts.find((part) => part.includes('name="file"'));
  if (!filePart) throw new Error("Missing GPX file upload.");

  const filename = filePart.match(/filename="([^"]+)"/)?.[1] ?? "imported-route.gpx";
  const contentStart = filePart.indexOf("\r\n\r\n");
  if (contentStart === -1) throw new Error("Malformed GPX upload.");

  let text = filePart.slice(contentStart + 4);
  text = text.replace(/\r\n$/, "");
  if (!text.includes("<gpx") || !text.includes("<trkpt")) {
    throw new Error("Uploaded file does not look like a GPX track.");
  }
  return { filename, text };
}
