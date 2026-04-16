export function generateLinuxConfig(config) {
  return {
    target: config.platforms.linux.target || ["AppImage", "deb"],
    icon: config.branding.icon || "icons/icon.png",
    category: "Office",
    artifactName: "${productName}-${version}.${ext}"
  };
}
