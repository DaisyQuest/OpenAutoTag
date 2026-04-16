# App Icons

This directory contains the SVG source icon and tooling to produce
platform-specific icon files for the Electron build.

## Quick start

```bash
# With sharp installed (recommended)
npm i -D sharp
node desktop/icons/generate-icons.js

# Without sharp — writes tiny placeholder PNGs so the build won't fail
node desktop/icons/generate-icons.js
```

## Source file

`icon.svg` is the single source of truth. It uses a shield shape with an
embedded PDF-document and accessibility figure, coloured in the emerald
green (#059669) that matches the "NATIVE PDF RETAINED" badge.

## Platform-specific icons

### Linux

Use the generated `icon.png` (512x512) directly. electron-builder picks
this up automatically from `build.linux.icon` in package.json.

### Windows (.ico)

If `png-to-ico` is installed alongside sharp, the generate script produces
a multi-size `icon.ico` automatically. Otherwise, convert manually:

```bash
# Option A — png-to-ico (Node)
npm i -D png-to-ico
node -e "
  const pngToIco = require('png-to-ico');
  const fs = require('fs');
  pngToIco([
    'desktop/icons/icon-16.png',
    'desktop/icons/icon-32.png',
    'desktop/icons/icon-48.png',
    'desktop/icons/icon-256.png',
  ]).then(buf => fs.writeFileSync('desktop/icons/icon.ico', buf));
"

# Option B — electron-icon-builder
npx electron-icon-builder --input=desktop/icons/icon.png --output=desktop/icons/

# Option C — ImageMagick
magick desktop/icons/icon.png -define icon:auto-resize=256,128,64,48,32,16 desktop/icons/icon.ico
```

### macOS (.icns)

macOS uses the `iconutil` command (ships with Xcode):

```bash
# 1. Generate the required sizes
mkdir -p desktop/icons/icon.iconset
for size in 16 32 64 128 256 512; do
  sharp -i desktop/icons/icon.svg -o "desktop/icons/icon.iconset/icon_${size}x${size}.png" resize $size $size
  double=$((size * 2))
  sharp -i desktop/icons/icon.svg -o "desktop/icons/icon.iconset/icon_${size}x${size}@2x.png" resize $double $double
done

# 2. Build the .icns bundle
iconutil -c icns desktop/icons/icon.iconset -o desktop/icons/icon.icns

# 3. Clean up
rm -rf desktop/icons/icon.iconset
```

You can also use `electron-icon-builder` which handles both platforms:

```bash
npx electron-icon-builder --input=desktop/icons/icon.png --output=desktop/icons/
```

## Files produced

| File            | Size      | Platform        |
|-----------------|-----------|-----------------|
| icon.svg        | vector    | Source          |
| icon.png        | 512x512   | Linux           |
| icon.ico        | multi     | Windows         |
| icon.icns       | multi     | macOS           |
| tray-icon.png   | 16x16     | System tray     |
| splash-bg.png   | 800x600   | Splash screen   |
