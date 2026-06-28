import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { collectRequestBody, parseMultipartGpx } from "./http";

function multipart(boundary: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  return req;
}

const gpxPart =
  '--B\r\nContent-Disposition: form-data; name="file"; filename="route.gpx"\r\n' +
  "Content-Type: application/gpx+xml\r\n\r\n" +
  '<gpx><trkpt lat="45" lon="7"></trkpt></gpx>\r\n--B--\r\n';

describe("parseMultipartGpx", () => {
  it("extracts filename and GPX text", () => {
    const req = multipart("B");
    const out = parseMultipartGpx(req, Buffer.from(gpxPart));
    expect(out.filename).toBe("route.gpx");
    expect(out.text).toContain("<gpx>");
    expect(out.text).toContain("<trkpt");
  });

  it("rejects a missing boundary", () => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.headers = { "content-type": "multipart/form-data" };
    expect(() => parseMultipartGpx(req, Buffer.from(gpxPart))).toThrow(/boundary/);
  });

  it("rejects content that is not a GPX track", () => {
    const notGpx = '--B\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nhello\r\n--B--\r\n';
    const req = multipart("B");
    expect(() => parseMultipartGpx(req, Buffer.from(notGpx))).toThrow(/GPX track/);
  });
});

describe("collectRequestBody", () => {
  it("concatenates the request stream", async () => {
    const req = Readable.from([Buffer.from("ab"), Buffer.from("cd")]) as unknown as IncomingMessage;
    const body = await collectRequestBody(req);
    expect(body.toString()).toBe("abcd");
  });

  it("rejects an upload past the size limit", async () => {
    const req = Readable.from([Buffer.from("0123456789")]) as unknown as IncomingMessage;
    await expect(collectRequestBody(req, 5)).rejects.toThrow(/too large/);
  });
});
