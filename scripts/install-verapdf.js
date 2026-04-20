import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(repoRoot, "modules", "validator", "vendor");
const zipPath = path.join(vendorDir, "verapdf-pdfbox-installer.zip");
const extractDir = path.join(vendorDir, "verapdf");
const appDir = path.join(extractDir, "app");
const autoInstallPath = path.join(extractDir, "auto-install.xml");
const releaseUrl = "https://software.verapdf.org/releases/verapdf-pdfbox-installer.zip";
const releaseUrlVersioned = "https://software.verapdf.org/releases/1.28/verapdf-pdfbox-1.28.2-installer.zip";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function runCommand(command, args, { shell = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoRoot, shell, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
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

async function downloadInstaller() {
  if (await pathExists(zipPath)) {
    return;
  }

  // Try the versioned URL first (more stable), then fall back to the unversioned alias.
  const urls = [releaseUrlVersioned, releaseUrl];
  let lastError = new Error("Unable to download veraPDF installer: no URLs available.");
  for (const url of urls) {
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      lastError = new Error(`Network error fetching ${url}: ${error.message}`);
      continue;
    }
    if (!response.ok || !response.body) {
      lastError = new Error(`Unable to download veraPDF installer from ${url} (HTTP ${response.status}).`);
      continue;
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath));
    return;
  }
  throw lastError;
}

async function extractInstaller() {
  const extracted = await findInstallerDir();
  if (extracted) {
    return extracted;
  }

  if (process.platform === "win32") {
    await runCommand("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`
    ]);
  } else {
    await runCommand("unzip", ["-oq", zipPath, "-d", extractDir]);
  }

  const installerDir = await findInstallerDir();
  if (!installerDir) {
    throw new Error("Unable to find extracted veraPDF installer directory.");
  }

  return installerDir;
}

async function findInstallerDir() {
  if (!(await pathExists(extractDir))) {
    return null;
  }

  const entries = await readdir(extractDir, { withFileTypes: true });
  const installerEntry = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("verapdf-pdfbox-"));
  return installerEntry ? path.join(extractDir, installerEntry.name) : null;
}

async function writeAutoInstallFile() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AutomatedInstallation langpack="eng">
  <com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
  <com.izforge.izpack.panels.target.TargetPanel id="install_dir">
    <installpath>${escapeXml(appDir)}</installpath>
  </com.izforge.izpack.panels.target.TargetPanel>
  <com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
    <pack index="0" name="veraPDF GUI" selected="true"/>
    <pack index="1" name="veraPDF Batch files" selected="true"/>
    <pack index="2" name="veraPDF Validation model" selected="true"/>
  </com.izforge.izpack.panels.packs.PacksPanel>
  <com.izforge.izpack.panels.install.InstallPanel id="install"/>
  <com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
`;

  await writeFile(autoInstallPath, xml, "utf8");
}

async function installVeraPdf(installerDir) {
  await rm(appDir, { recursive: true, force: true });
  await writeAutoInstallFile();

  const installerPath =
    process.platform === "win32"
      ? path.join(installerDir, "verapdf-install.bat")
      : path.join(installerDir, "verapdf-install");

  if (!(await pathExists(installerPath))) {
    throw new Error(`veraPDF installer not found at ${installerPath}.`);
  }

  if (process.platform !== "win32") {
    await chmod(installerPath, 0o755).catch(() => {});
  }

  await runCommand(installerPath, [autoInstallPath], { shell: process.platform === "win32" });

  if (process.platform !== "win32") {
    for (const launcherPath of [path.join(appDir, "verapdf"), path.join(appDir, "bin", "verapdf")]) {
      if (await pathExists(launcherPath)) {
        await chmod(launcherPath, 0o755).catch(() => {});
      }
    }
  }
}

async function main() {
  await mkdir(vendorDir, { recursive: true });
  await mkdir(extractDir, { recursive: true });
  await downloadInstaller();
  const installerDir = await extractInstaller();
  await installVeraPdf(installerDir);
  process.stdout.write(`veraPDF installed at ${appDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
