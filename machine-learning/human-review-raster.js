import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(__dirname, "java", "HumanReviewRasterCli.java");
const defaultBuildDir = path.join(repoRoot, "tmp", "build", "ml-human-review-raster");
const defaultCacheDir = path.join(repoRoot, "output", "ml-human-review", "raster-cache");
const pdfboxJarCandidates = [
  path.join(repoRoot, "modules", "pdf-writer", "vendor", "pdfbox-app-3.0.7.jar"),
  path.join(repoRoot, "modules", "validator", "vendor", "pdfbox-app-3.0.7.jar")
];

let compilePromise = null;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: repoRoot,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 20,
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findPdfboxJar() {
  for (const candidate of pdfboxJarCandidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error("PDFBox app jar was not found in modules/pdf-writer/vendor or modules/validator/vendor.");
}

async function shouldCompile(classFile) {
  if (!(await pathExists(classFile))) {
    return true;
  }

  const [sourceStats, classStats] = await Promise.all([stat(sourcePath), stat(classFile)]);
  return sourceStats.mtimeMs > classStats.mtimeMs;
}

async function compileRasterCli({ buildDir = defaultBuildDir } = {}) {
  if (!compilePromise) {
    compilePromise = (async () => {
      const pdfboxJar = await findPdfboxJar();
      await mkdir(buildDir, { recursive: true });
      const classFile = path.join(buildDir, "HumanReviewRasterCli.class");
      if (await shouldCompile(classFile)) {
        await runCommand("javac", ["-cp", pdfboxJar, "-d", buildDir, sourcePath]);
      }
      return {
        buildDir,
        pdfboxJar
      };
    })();
  }

  return compilePromise;
}

async function buildCacheKey(item, { dpi }) {
  const pdfPath = path.resolve(item.sourcePdf);
  const pdfStats = await stat(pdfPath);
  return sha256(JSON.stringify({
    pdfPath,
    size: pdfStats.size,
    mtimeMs: Math.round(pdfStats.mtimeMs),
    pageNumber: item.target?.pageNumber || 1,
    dpi
  }));
}

export async function renderHumanReviewPageRaster(item, { cacheDir = defaultCacheDir, dpi = 144 } = {}) {
  if (!item?.sourcePdf) {
    throw new Error("Review item does not include a source PDF path.");
  }

  const pdfPath = path.resolve(item.sourcePdf);
  if (!(await pathExists(pdfPath))) {
    throw new Error(`Source PDF not found: ${pdfPath}`);
  }

  const cacheKey = await buildCacheKey(item, { dpi });
  const imagePath = path.join(path.resolve(cacheDir), `${cacheKey}.png`);
  const metadataPath = path.join(path.resolve(cacheDir), `${cacheKey}.json`);

  if (await pathExists(imagePath)) {
    try {
      return JSON.parse(await readFile(metadataPath, "utf8"));
    } catch {
      return {
        status: "completed",
        imagePath,
        pageNumber: item.target?.pageNumber || 1,
        dpi,
        cacheHit: true
      };
    }
  }

  const { buildDir, pdfboxJar } = await compileRasterCli();
  await mkdir(path.dirname(imagePath), { recursive: true });
  const { stdout } = await runCommand("java", [
    "-cp",
    `${buildDir}${path.delimiter}${pdfboxJar}`,
    "HumanReviewRasterCli",
    "--pdf",
    pdfPath,
    "--page",
    String(item.target?.pageNumber || 1),
    "--dpi",
    String(dpi),
    "--output",
    imagePath
  ]);
  const metadata = {
    ...JSON.parse(stdout),
    cacheKey,
    cacheHit: false
  };
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return metadata;
}

export async function readRasterDataUri(item, options = {}) {
  const raster = await renderHumanReviewPageRaster(item, options);
  const bytes = await readFile(raster.imagePath);
  return {
    raster,
    dataUri: `data:image/png;base64,${bytes.toString("base64")}`
  };
}
