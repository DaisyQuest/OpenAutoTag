export const CONFIG_SCHEMA = {
  productName: { type: "string", required: true },
  version: { type: "string", required: true },
  description: { type: "string", default: "" },
  platforms: {
    type: "object",
    default: {
      windows: { enabled: true, arch: ["x64"], target: "nsis" },
      macos: { enabled: false, arch: ["x64", "arm64"], target: "dmg" },
      linux: { enabled: false, arch: ["x64"], target: ["AppImage", "deb"] }
    }
  },
  components: {
    type: "object",
    default: {
      accessibilityTagging: { included: true, removable: false },
      ssnRedaction: { included: true, removable: true },
      corruptionRepair: { included: true, removable: true },
      fontHealthAnalysis: { included: true, removable: true }
    }
  },
  java: { type: "object", default: { bundle: false, jrePath: null } },
  branding: {
    type: "object",
    default: {
      icon: null,
      splash: null,
      company: "DaisyQuest",
      copyright: `Copyright ${new Date().getFullYear()} DaisyQuest`,
      license: null,
      themeColor: "#059669"
    }
  },
  advanced: {
    type: "object",
    default: {
      autoUpdateUrl: null,
      allowCustomInstallPath: true,
      fileAssociations: [".pdf"],
      desktopShortcut: true,
      startMenuShortcut: true,
      runAfterInstall: true
    }
  }
};

export function getDefaultConfig() {
  return {
    productName: "PDF Accessibility Engine",
    version: "1.0.0",
    description: "PDF Accessibility Engine — Desktop Edition",
    platforms: CONFIG_SCHEMA.platforms.default,
    components: CONFIG_SCHEMA.components.default,
    java: CONFIG_SCHEMA.java.default,
    branding: { ...CONFIG_SCHEMA.branding.default },
    advanced: { ...CONFIG_SCHEMA.advanced.default }
  };
}

export function mergeWithDefaults(partial) {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    ...partial,
    platforms: { ...defaults.platforms, ...partial?.platforms },
    components: { ...defaults.components, ...partial?.components },
    java: { ...defaults.java, ...partial?.java },
    branding: { ...defaults.branding, ...partial?.branding },
    advanced: { ...defaults.advanced, ...partial?.advanced }
  };
}

export function validateConfig(config) {
  const errors = [];
  if (!config?.productName) errors.push("productName is required");
  if (!config?.version) errors.push("version is required");
  if (config?.platforms) {
    const hasTarget = Object.values(config.platforms).some((p) => p?.enabled);
    if (!hasTarget) errors.push("at least one platform must be enabled");
  }
  return { valid: errors.length === 0, errors };
}
