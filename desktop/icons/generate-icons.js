#!/usr/bin/env node
// desktop/icons/generate-icons.js
// Converts icon.svg into platform-specific icons for Electron builds.
//
// Usage:
//   node desktop/icons/generate-icons.js
//
// When `sharp` is available (npm i -D sharp), this script will produce:
//   - icon.png      (512x512, Linux / generic)
//   - icon.ico      (Windows, multi-size)
//   - icon.icns     (macOS — requires iconutil, see README.md)
//   - tray-icon.png (16x16, system tray)
//   - splash-bg.png (800x600, splash screen background)
//
// Without sharp, it writes 1x1 transparent PNG placeholders so the
// electron-builder build does not fail on missing assets.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

// Minimal 1x1 transparent PNG (68 bytes)
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
  "Nl7BcQAAAABJRU5ErkJggg==",
  "base64"
);

// Minimal 1x1 ICO (built from the same 1x1 PNG payload)
function buildPlaceholderIco() {
  const png = PLACEHOLDER_PNG;
  // ICO header: 0=reserved, 1=ICO type, 1 image
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);  // reserved
  header.writeUInt16LE(1, 2);  // type: ICO
  header.writeUInt16LE(1, 4);  // image count

  // ICO directory entry (16 bytes)
  const entry = Buffer.alloc(16);
  entry.writeUInt8(1, 0);      // width (1 pixel; 0 would mean 256)
  entry.writeUInt8(1, 1);      // height
  entry.writeUInt8(0, 2);      // color palette
  entry.writeUInt8(0, 3);      // reserved
  entry.writeUInt16LE(1, 4);   // color planes
  entry.writeUInt16LE(32, 6);  // bits per pixel
  entry.writeUInt32LE(png.length, 8);  // image data size
  entry.writeUInt32LE(6 + 16, 12);     // offset to image data

  return Buffer.concat([header, entry, png]);
}

const targets = [
  { name: "icon.png",      desc: "App icon (512x512, Linux)" },
  { name: "icon.ico",      desc: "App icon (Windows multi-size)" },
  { name: "tray-icon.png", desc: "System tray icon (16x16)" },
  { name: "splash-bg.png", desc: "Splash screen background (800x600)" },
];

async function generateWithSharp() {
  const sharp = (await import("sharp")).default;
  const svgPath = join(__dirname, "icon.svg");
  const svg = readFileSync(svgPath);

  // icon.png — 512x512
  await sharp(svg).resize(512, 512).png().toFile(join(OUT, "icon.png"));
  console.log("  icon.png (512x512)");

  // tray-icon.png — 16x16
  await sharp(svg).resize(16, 16).png().toFile(join(OUT, "tray-icon.png"));
  console.log("  tray-icon.png (16x16)");

  // splash-bg.png — 800x600 centered on dark background
  const centered = await sharp(svg).resize(240, 240).png().toBuffer();
  await sharp({
    create: { width: 800, height: 600, channels: 4, background: { r: 19, g: 38, b: 40, alpha: 1 } },
  })
    .composite([{ input: centered, gravity: "centre" }])
    .png()
    .toFile(join(OUT, "splash-bg.png"));
  console.log("  splash-bg.png (800x600)");

  // icon.ico — generate multiple sizes, then write as ICO
  // (For a production ICO, use png-to-ico or electron-icon-builder.)
  // For now, produce a 256x256 PNG and note the manual step.
  const ico256 = await sharp(svg).resize(256, 256).png().toBuffer();
  writeFileSync(join(OUT, "icon-256.png"), ico256);
  console.log("  icon-256.png (256x256, convert to .ico manually or with png-to-ico)");

  // Attempt png-to-ico if available
  try {
    const pngToIco = (await import("png-to-ico")).default;
    const sizes = [16, 32, 48, 64, 128, 256];
    const buffers = await Promise.all(
      sizes.map((s) => sharp(svg).resize(s, s).png().toBuffer())
    );
    const ico = await pngToIco(buffers);
    writeFileSync(join(OUT, "icon.ico"), ico);
    console.log("  icon.ico (multi-size via png-to-ico)");
  } catch {
    console.log("  [skip] png-to-ico not installed; icon.ico placeholder written instead");
    writeFileSync(join(OUT, "icon.ico"), buildPlaceholderIco());
  }

  console.log("\nNote: For macOS icon.icns, see README.md (requires iconutil on macOS).");
}

function writePlaceholders() {
  for (const t of targets) {
    const out = join(OUT, t.name);
    if (t.name.endsWith(".ico")) {
      writeFileSync(out, buildPlaceholderIco());
    } else {
      writeFileSync(out, PLACEHOLDER_PNG);
    }
    console.log(`  ${t.name} (placeholder) — ${t.desc}`);
  }
}

async function main() {
  console.log("PDF Accessibility Engine — Icon Generator\n");

  let hasSharp = false;
  try {
    await import("sharp");
    hasSharp = true;
  } catch {
    // sharp not available
  }

  if (hasSharp) {
    console.log("sharp detected — generating real icons from icon.svg:\n");
    await generateWithSharp();
  } else {
    console.log(
      "sharp not installed — writing 1x1 placeholder PNGs.\n" +
      "Install sharp for real icons:  npm i -D sharp\n"
    );
    writePlaceholders();
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
