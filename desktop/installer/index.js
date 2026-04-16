import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultConfig, mergeWithDefaults, validateConfig } from "./installer-config.js";
import { generateWindowsConfig } from "./platforms/windows.js";
import { generateMacConfig } from "./platforms/macos.js";
import { generateLinuxConfig } from "./platforms/linux.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export { getDefaultConfig, mergeWithDefaults, validateConfig } from "./installer-config.js";

export function generateElectronBuilderConfig(config) {
  const validated = mergeWithDefaults(config);
  const result = {
    appId: `com.${(validated.branding.company || "app").toLowerCase().replace(/\s+/g, "")}.${validated.productName.toLowerCase().replace(/\s+/g, "")}`,
    productName: validated.productName,
    directories: { output: "dist" },
    files: [
      "main.js", "preload.js", "splash.html", "about.html", "icons/**",
      "../orchestrator/**", "../modules/**", "../contracts/**", "../scripts/**",
      "../package.json", "../node_modules/**"
    ]
  };

  if (validated.platforms.windows.enabled) {
    result.win = generateWindowsConfig(validated);
  }
  if (validated.platforms.macos.enabled) {
    result.mac = generateMacConfig(validated);
  }
  if (validated.platforms.linux.enabled) {
    result.linux = generateLinuxConfig(validated);
  }

  if (validated.platforms.windows.enabled) {
    result.nsis = {
      oneClick: !validated.advanced.allowCustomInstallPath,
      allowToChangeInstallationDirectory: validated.advanced.allowCustomInstallPath ?? true,
      createDesktopShortcut: validated.advanced.desktopShortcut,
      createStartMenuShortcut: validated.advanced.startMenuShortcut,
      shortcutName: validated.productName,
      runAfterFinish: validated.advanced.runAfterInstall
    };
  }

  if (validated.advanced.fileAssociations?.length) {
    result.fileAssociations = validated.advanced.fileAssociations.map((ext) => ({
      ext: ext.replace(/^\./, ""),
      mimeType: ext === ".pdf" ? "application/pdf" : "application/octet-stream",
      role: "Viewer"
    }));
  }

  return result;
}

export async function buildInstaller(config) {
  const validation = validateConfig(config);
  if (!validation.valid) {
    return { success: false, errors: validation.errors, outputPaths: [], duration: 0 };
  }

  const builderConfig = generateElectronBuilderConfig(config);
  const buildDir = path.resolve(__dirname, "..");
  const configPath = path.join(buildDir, "electron-builder-generated.yml");

  await writeFile(configPath, JSON.stringify(builderConfig, null, 2));

  const start = Date.now();
  try {
    const { build } = await import("electron-builder");
    const results = await build({
      config: builderConfig,
      projectDir: buildDir
    });
    return {
      success: true,
      outputPaths: results.map(String),
      duration: Date.now() - start,
      errors: []
    };
  } catch (err) {
    return {
      success: false,
      outputPaths: [],
      duration: Date.now() - start,
      errors: [err.message]
    };
  }
}
