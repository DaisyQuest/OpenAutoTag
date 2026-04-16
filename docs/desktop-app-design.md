# Desktop Application & Installer Design

## Architecture Decision: Electron

After evaluating Swing+FlatLaf, Tauri, and Electron, **Electron wins on maintainability**:

- **One codebase**: our entire web dashboard, server, and pipeline are already Node.js.
  Electron wraps them directly — no bridge layer, no second language, no serialization.
- **Installer ecosystem**: electron-builder produces native installers (.exe NSIS,
  .dmg, .deb, .AppImage) from a single config. Well-maintained, documented, and
  extractable as a library.
- **Auto-update**: electron-updater provides differential updates out of the box.
- **Maintainability**: any developer who can work on the Node server can work on
  the desktop app. Swing would require separate Java UI expertise.

The Java components (PDFBox, validators, font repair) are invoked as child
processes — the same way they work in the server. No change needed.

## Application Structure

```
desktop/
├── main.js              ← Electron main process (starts server, creates window)
├── preload.js           ← Bridge between renderer and main process
├── splash.html          ← Beautiful loading screen while server starts
├── icons/               ← App icons (ICO, ICNS, PNG)
├── installer/
│   ├── installer-config.js    ← Programmatic installer builder config
│   ├── wizard/
│   │   ├── wizard.html        ← Graphical install wizard configurator
│   │   ├── wizard.js          ← Wizard logic (step flow, validation)
│   │   └── wizard.css         ← Wizard styling
│   └── templates/
│       ├── nsis-template.nsi  ← Windows NSIS template
│       └── dmg-template.json  ← macOS DMG layout
├── package.json         ← Electron app manifest
└── electron-builder.yml ← Build configuration
```

## Installer Wizard

A graphical configurator that builds installer configurations:

1. **Welcome** — product name, version, description
2. **Targets** — checkboxes for Windows/macOS/Linux + architecture
3. **Components** — which workloads to include (accessibility, redaction, repair)
4. **Java Runtime** — bundle JRE 21 or require system Java
5. **Branding** — app icon, splash screen, installer banner
6. **Advanced** — auto-update URL, install path, file associations (.pdf)
7. **Review** — shows the generated electron-builder.yml
8. **Build** — runs electron-builder with the config

The wizard is itself an HTML/CSS/JS app that can run standalone or inside
Electron. It produces a `build-config.json` consumed by the build script.

## Extractable Installer Library

The installer system is designed for extraction:

```
desktop/installer/
├── index.js             ← Public API: buildInstaller(config)
├── installer-config.js  ← Config schema + validation
├── platforms/
│   ├── windows.js       ← NSIS-specific logic
│   ├── macos.js         ← DMG/pkg logic
│   └── linux.js         ← deb/rpm/AppImage logic
├── wizard/              ← Standalone wizard app
└── templates/           ← Platform-specific templates
```

`buildInstaller({ productName, targets, components, javaBundle, branding })`
is the entire public surface. Everything else is internal.
