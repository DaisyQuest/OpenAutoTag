import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(repoRoot, "modules", "validator", "vendor");
const version = "1.30.3";
const installerSha256 = "b512bf24945503a33fc10738ecffc1f2dccaaf8593a448e94ee9ac86a9559a59";
const zipPath = path.join(vendorDir, `verapdf-greenfield-${version}-installer.zip`);
const extractDir = path.join(vendorDir, "verapdf");
const appDir = path.join(extractDir, "app");
const autoInstallPath = path.join(extractDir, "auto-install.xml");

const releaseUrlVersioned = "https://software.verapdf.org/releases/1.30/verapdf-greenfield-1.30.3-installer.zip";
const configuredInstallerUrls = (process.env.VERAPDF_INSTALLER_URLS || process.env.VERAPDF_INSTALLER_URL || "")
  .split(/[\r\n,]+/)
  .map((url) => url.trim())
  .filter(Boolean);

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
    execFile(command, args, { cwd: repoRoot, shell, windowsHide: true, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
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

  // Try configured mirrors first. By default, use the public URLs this project
  // has historically sourced veraPDF from.
  const urls = configuredInstallerUrls.length > 0 ? configuredInstallerUrls : [releaseUrlVersioned];
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
  // Always extract from the checksum-verified archive, never trust a stale cached installer JAR.

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

  const installerDir = path.join(extractDir, `verapdf-greenfield-${version}`);
  return await pathExists(path.join(installerDir, `verapdf-izpack-installer-${version}.jar`)) ? installerDir : null;
}

async function writeAutoInstallFile(target) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AutomatedInstallation langpack="eng">
  <com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
  <com.izforge.izpack.panels.target.TargetPanel id="install_dir">
    <installpath>${escapeXml(target)}</installpath>
  </com.izforge.izpack.panels.target.TargetPanel>
  <com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
    <pack index="0" name="veraPDF GUI" selected="false"/>
    <pack index="1" name="veraPDF CLI" selected="true"/>
    <pack index="2" name="veraPDF Documentation" selected="false"/>
    <pack index="3" name="veraPDF Sample Plugins" selected="false"/>
  </com.izforge.izpack.panels.packs.PacksPanel>
  <com.izforge.izpack.panels.install.InstallPanel id="install"/>
  <com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
`;

  await writeFile(autoInstallPath, xml, "utf8");
}

async function installVeraPdf(installerDir) {
  // Stage and verify the replacement before retaining the prior installation as a backup.
  const target = await mkdtemp(path.join(extractDir, `install-${version}-`));
  await writeAutoInstallFile(target);
  const java = process.env.VALIDATOR_JAVA_PATH || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "java");
  await runCommand(java, ["-Djava.awt.headless=true", "-jar", path.join(installerDir, `verapdf-izpack-installer-${version}.jar`), autoInstallPath]);
  const { stdout } = await runCommand(java, ["-jar", path.join(target, "bin", `cli-${version}.jar`), "--version"]);
  if (!stdout.includes(version)) throw new Error("Unexpected installed veraPDF version");
  const parent = path.resolve(extractDir) + path.sep;
  for (const value of [target, appDir]) if (!path.resolve(value).startsWith(parent)) throw new Error("Install path outside vendor workspace");
  let backup;
  if (await pathExists(appDir)) {
    backup = path.join(extractDir, `previous-${Date.now()}`);
    if (!path.resolve(backup).startsWith(parent)) throw new Error("Backup path outside vendor workspace");
    await rename(appDir, backup);
  }
  try { await rename(target, appDir); }
  catch (error) { if (backup) await rename(backup, appDir); throw error; }

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
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(zipPath)) digest.update(chunk);
  if (digest.digest("hex") !== installerSha256) throw new Error("veraPDF installer SHA-256 mismatch; cached or mirrored content is not the pinned release");
  const installerDir = await extractInstaller();
  await installVeraPdf(installerDir);
  process.stdout.write(`veraPDF installed at ${appDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
