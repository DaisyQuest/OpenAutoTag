export function generateWindowsConfig(config) {
  return {
    target: config.platforms.windows.target || "nsis",
    icon: config.branding.icon || "icons/icon.ico",
    artifactName: "${productName}-Setup-${version}.${ext}"
  };
}
