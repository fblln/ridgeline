import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import gifenc from "gifenc";
import pngjs from "pngjs";

const { GIFEncoder, applyPalette, quantize } = gifenc;
const { PNG } = pngjs;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "docs/images/readme");
const tempDir = path.join(outDir, ".frames");
const sampleManifest = path.join(root, "public/assets/escursione-mattutina/manifest.json");
const port = Number(process.env.README_CAPTURE_PORT ?? 5177);
const baseUrl = `http://127.0.0.1:${port}`;

const outputs = {
  entry: path.join(outDir, "entry.png"),
  overview: path.join(outDir, "terrain-overview.png"),
  layers: path.join(outDir, "layer-comparison.png"),
  replay: path.join(outDir, "route-replay.gif"),
  exportPreview: path.join(outDir, "export-preview.png"),
};

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function waitForServer(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canReach(baseUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Vite did not become reachable at ${baseUrl}`);
}

function canReach(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function launchDevServer() {
  const child = spawn(
    npmCommand(),
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: root,
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", (data) => process.stderr.write(data));
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`Vite exited with code ${code}`);
    }
  });

  await waitForServer();
  return child;
}

async function stopDevServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForViewer(page) {
  await page.getByRole("button", { name: "Load area" }).click();
  await page.locator("canvas").waitFor({ state: "visible", timeout: 120_000 });
  await page.getByText("Camera readout").waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForTimeout(2500);
  await assertCanvasPixels(page, "initial terrain");
}

async function assertCanvasPixels(page, label) {
  const stats = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas || canvas.width < 2 || canvas.height < 2) {
      return { ok: false, reason: "missing canvas", stddev: 0, bins: 0 };
    }
    const sample = document.createElement("canvas");
    sample.width = 96;
    sample.height = 54;
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
    let sum = 0;
    let sumSquares = 0;
    const bins = new Set();
    for (let i = 0; i < pixels.length; i += 4) {
      const lum = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
      sum += lum;
      sumSquares += lum * lum;
      bins.add(`${pixels[i] >> 4}:${pixels[i + 1] >> 4}:${pixels[i + 2] >> 4}`);
    }
    const count = pixels.length / 4;
    const mean = sum / count;
    const variance = sumSquares / count - mean * mean;
    return { ok: true, stddev: Math.sqrt(Math.max(0, variance)), bins: bins.size };
  });

  if (!stats.ok || stats.stddev < 8 || stats.bins < 24) {
    throw new Error(
      `Canvas check failed for ${label}: stddev=${stats.stddev.toFixed(2)}, bins=${stats.bins}, reason=${stats.reason ?? "low variance"}`,
    );
  }
}

async function assertImage(pathname, label) {
  const buffer = await fs.readFile(pathname);
  const png = PNG.sync.read(buffer);
  let sum = 0;
  let sumSquares = 0;
  const bins = new Set();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 120_000));
  let count = 0;
  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const i = pixel * 4;
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
    sum += lum;
    sumSquares += lum * lum;
    bins.add(`${r >> 4}:${g >> 4}:${b >> 4}`);
    count += 1;
  }
  const mean = sum / count;
  const stddev = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
  if (stddev < 10 || bins.size < 40) {
    throw new Error(`Image check failed for ${label}: stddev=${stddev.toFixed(2)}, bins=${bins.size}`);
  }
}

async function screenshot(page, pathname, label) {
  await page.screenshot({ path: pathname, fullPage: false });
  await assertImage(pathname, label);
}

async function canvasScreenshot(page, pathname, label) {
  await assertCanvasPixels(page, label);
  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("Missing WebGL canvas");
    return canvas.toDataURL("image/png");
  });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  await fs.writeFile(pathname, Buffer.from(base64, "base64"));
  await assertImage(pathname, label);
}

async function setLayer(page, name) {
  const keyByName = {
    Topo: "1",
    "LiDAR shade": "2",
    Slope: "3",
    Forest: "4",
  };
  const key = keyByName[name];
  if (!key) throw new Error(`Unknown layer: ${name}`);
  console.log(`Selecting layer: ${name}`);
  await page.keyboard.press(key);
  await page.waitForTimeout(900);
  await assertCanvasPixels(page, name);
}

async function setReplayPosition(page, value) {
  await page.locator('input[aria-label="Replay progress"]').evaluate((input, nextValue) => {
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function makeLayerComparison(paths, output) {
  const images = paths.map((pathname) => PNG.sync.read(awaitSyncRead(pathname)));
  const width = images[0].width;
  const height = images[0].height;
  const composite = new PNG({ width: width * 2, height: height * 2 });

  for (let index = 0; index < images.length; index += 1) {
    const source = images[index];
    const offsetX = (index % 2) * width;
    const offsetY = Math.floor(index / 2) * height;
    PNG.bitblt(source, composite, 0, 0, width, height, offsetX, offsetY);
  }

  await fs.writeFile(output, PNG.sync.write(composite));
  await assertImage(output, "layer comparison");
}

function awaitSyncRead(pathname) {
  return fsSyncCache.get(pathname);
}

const fsSyncCache = new Map();

async function cacheFiles(paths) {
  await Promise.all(paths.map(async (pathname) => fsSyncCache.set(pathname, await fs.readFile(pathname))));
}

async function makeGif(framePaths, output, delay = 16) {
  const frames = framePaths.map((pathname) => PNG.sync.read(awaitSyncRead(pathname)));
  const { width, height } = frames[0];
  const gif = GIFEncoder();

  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error("GIF frames must have the same dimensions");
    }
    const palette = quantize(frame.data, 160);
    const index = applyPalette(frame.data, palette);
    gif.writeFrame(index, width, height, { palette, delay });
  }

  gif.finish();
  await fs.writeFile(output, gif.bytes());
}

async function main() {
  try {
    await fs.access(sampleManifest);
  } catch {
    throw new Error(
      [
        "Missing sample terrain assets.",
        "Generate them first from the repository root:",
        "  python tools/asset-baker/export_web_example.py examples/gpx/Escursione_mattutina.gpx",
        `Expected: ${path.relative(root, sampleManifest)}`,
      ].join("\n"),
    );
  }

  await fs.mkdir(outDir, { recursive: true });
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  const server = await launchDevServer();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(120_000);

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await screenshot(page, outputs.entry, "entry screen");
    await waitForViewer(page);
    console.log("Capturing terrain overview");
    await screenshot(page, outputs.overview, "terrain overview");

    const layerFrames = [];
    const layers = ["Topo", "LiDAR shade", "Slope", "Forest"];
    for (const layer of layers) {
      await setLayer(page, layer);
      const framePath = path.join(tempDir, `layer-${layer.toLowerCase().replaceAll(" ", "-")}.png`);
      await screenshot(page, framePath, `${layer} layer`);
      layerFrames.push(framePath);
    }
    console.log("Composing layer comparison");
    await cacheFiles(layerFrames);
    await makeLayerComparison(layerFrames, outputs.layers);

    await page.setViewportSize({ width: 960, height: 600 });
    console.log("Capturing route replay GIF frames");
    console.log("Activating route-follow camera");
    await page.locator('button[title="Preview the route-follow camera"]').click();
    await page.waitForTimeout(700);
    const replayFrames = [];
    const replayPositions = [0, 18, 36, 54, 72, 90];
    for (let i = 0; i < replayPositions.length; i += 1) {
      console.log(`Capturing replay frame ${i + 1}/${replayPositions.length}`);
      await setReplayPosition(page, replayPositions[i]);
      await page.waitForTimeout(220);
      const framePath = path.join(tempDir, `replay-${String(i).padStart(2, "0")}.png`);
      await canvasScreenshot(page, framePath, `route replay frame ${i}`);
      replayFrames.push(framePath);
    }
    await cacheFiles(replayFrames);
    await makeGif(replayFrames, outputs.replay, 11);

    await page.setViewportSize({ width: 1440, height: 900 });
    console.log("Capturing export preview");
    await setLayer(page, "Topo");
    await page.getByRole("button", { name: "Export" }).click();
    await page.locator('[aria-label="Captured image preview"]').waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(800);
    await screenshot(page, outputs.exportPreview, "export preview");
  } finally {
    if (browser) await browser.close();
    await stopDevServer(server);
  }

  console.log("README media captured:");
  for (const [label, pathname] of Object.entries(outputs)) {
    console.log(`- ${label}: ${path.relative(root, pathname)}`);
  }
  if (!process.env.README_CAPTURE_KEEP_FRAMES) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
