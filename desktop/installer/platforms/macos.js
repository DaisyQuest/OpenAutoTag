export function generateMacConfig(config) {
  return {
    target: config.platforms.macos.target || "dmg",
    icon: config.branding.icon || "icons/icon.icns",
    category: "public.app-category.productivity",
    artifactName: "${productName}-${version}.${ext}"
  };
}
