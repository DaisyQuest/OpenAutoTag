/**
 * Installer Wizard — Logic
 *
 * Multi-step configuration wizard for building PDF Accessibility Engine
 * installers. Zero external dependencies. Designed for eventual extraction
 * as a standalone installer-builder library.
 */

/* global document, window, FileReader, URL */

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────
  const TOTAL_STEPS = 8;
  const STEP_NAMES  = [
    'Welcome', 'Platforms', 'Components', 'Java',
    'Branding', 'Advanced', 'Review', 'Build',
  ];

  const THEME_COLORS = [
    '#2563eb', '#7c3aed', '#0891b2', '#059669',
    '#d97706', '#dc2626', '#db2777', '#4f46e5',
  ];

  // ── State ──────────────────────────────────────────────────────
  let currentStep = 0;

  const config = {
    // Step 1
    productName:  'PDF Accessibility Engine',
    version:      '',    // filled from package.json or DOM
    description:  'Contract-first scaffold for a parallel PDF accessibility tagging pipeline.',

    // Step 2
    platforms: { windows: true, macos: false, linux: false },
    architectures: { x64: true, arm64: false },

    // Step 3
    components: {
      accessibilityTagging:  true,
      ssnRedaction:          false,
      pdfCorruptionRepair:   false,
      fontHealthAnalysis:    false,
    },

    // Step 4
    javaBundle:        'bundle',   // 'bundle' | 'system'
    javaBundleSource:  'auto',     // 'auto' | 'local'
    javaLocalPath:     '',

    // Step 5
    appIcon:           null,       // File object or null
    appIconPreviewUrl: '',
    splashText:        'Loading PDF Accessibility Engine...',
    companyName:       '',
    copyright:         '',
    licenseText:       '',
    themeColor:        '#2563eb',

    // Step 6
    autoUpdateUrl:     '',
    installPath:       '',
    fileAssocPdf:      true,
    desktopShortcut:   true,
    startMenuEntry:    true,
    runAfterInstall:   true,
  };

  // ── DOM references (populated on init) ─────────────────────────
  let panels, circles, connectors, prevBtn, nextBtn;

  // ── Initialization ─────────────────────────────────────────────

  function init() {
    panels     = document.querySelectorAll('.wiz-step-panel');
    circles    = document.querySelectorAll('.wiz-step-circle');
    connectors = document.querySelectorAll('.wiz-step-line');
    prevBtn    = document.getElementById('wizPrev');
    nextBtn    = document.getElementById('wizNext');

    // Read version from the hidden span if present
    const versionEl = document.getElementById('wizVersionValue');
    if (versionEl) config.version = versionEl.textContent.trim();

    bindNavigation();
    bindStep1();
    bindStep2();
    bindStep3();
    bindStep4();
    bindStep5();
    bindStep6();
    renderColorSwatches();
    showStep(0);
  }

  // ── Step navigation ────────────────────────────────────────────

  function showStep(idx) {
    currentStep = idx;

    panels.forEach(function (p, i) {
      p.classList.toggle('visible', i === idx);
    });

    // Update step indicator
    var stepItems = document.querySelectorAll('.wiz-step-item');
    stepItems.forEach(function (item, i) {
      item.classList.remove('active', 'done');
      if (i < idx)      item.classList.add('done');
      else if (i === idx) item.classList.add('active');
    });

    connectors.forEach(function (c, i) {
      c.classList.toggle('done-line', i < idx);
    });

    // Nav buttons
    prevBtn.style.visibility = idx === 0 ? 'hidden' : 'visible';
    if (idx === TOTAL_STEPS - 1) {
      nextBtn.style.display = 'none';
    } else {
      nextBtn.style.display = '';
      nextBtn.textContent = idx === TOTAL_STEPS - 2 ? 'Review' : 'Next';
    }

    // Populate review on step 7 (index 6)
    if (idx === 6) populateReview();
  }

  function goNext() {
    if (currentStep >= TOTAL_STEPS - 1) return;
    if (!validateStep(currentStep)) return;
    collectStepData(currentStep);
    showStep(currentStep + 1);
  }

  function goPrev() {
    if (currentStep <= 0) return;
    showStep(currentStep - 1);
  }

  function goToStep(idx) {
    if (idx >= 0 && idx < TOTAL_STEPS) {
      collectStepData(currentStep);
      showStep(idx);
    }
  }

  function bindNavigation() {
    prevBtn.addEventListener('click', goPrev);
    nextBtn.addEventListener('click', goNext);
  }

  // ── Validation ─────────────────────────────────────────────────

  function validateStep(idx) {
    clearErrors();
    switch (idx) {
      case 0: return validateWelcome();
      case 1: return validatePlatforms();
      case 2: return true; // accessibility tagging always selected
      case 3: return validateJava();
      case 4: return true; // branding is optional
      case 5: return true; // advanced is optional
      case 6: return true; // review
      case 7: return true; // build
    }
    return true;
  }

  function validateWelcome() {
    var name = document.getElementById('wizProductName');
    if (!name.value.trim()) {
      showError(name, 'Product name is required');
      return false;
    }
    return true;
  }

  function validatePlatforms() {
    var checks = document.querySelectorAll('.wiz-platform-cb:checked');
    if (checks.length === 0) {
      var el = document.getElementById('wizPlatformError');
      if (el) { el.classList.add('show'); }
      return false;
    }
    var archChecks = document.querySelectorAll('.wiz-arch-cb:checked');
    if (archChecks.length === 0) {
      var el2 = document.getElementById('wizArchError');
      if (el2) { el2.classList.add('show'); }
      return false;
    }
    return true;
  }

  function validateJava() {
    if (config.javaBundle === 'bundle' && config.javaBundleSource === 'local') {
      var pathInput = document.getElementById('wizJavaLocalPath');
      if (pathInput && !pathInput.value.trim()) {
        showError(pathInput, 'Please provide the path to a local JRE');
        return false;
      }
    }
    return true;
  }

  function showError(inputEl, msg) {
    inputEl.classList.add('invalid');
    var errEl = inputEl.parentElement.querySelector('.wiz-error-msg');
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.add('show');
    }
  }

  function clearErrors() {
    document.querySelectorAll('.invalid').forEach(function (el) { el.classList.remove('invalid'); });
    document.querySelectorAll('.wiz-error-msg.show').forEach(function (el) { el.classList.remove('show'); });
  }

  // ── Data collection ────────────────────────────────────────────

  function collectStepData(idx) {
    switch (idx) {
      case 0: collectWelcome(); break;
      case 1: collectPlatforms(); break;
      case 2: collectComponents(); break;
      case 3: collectJava(); break;
      case 4: collectBranding(); break;
      case 5: collectAdvanced(); break;
    }
  }

  function collectWelcome() {
    config.productName = val('wizProductName');
    config.description = val('wizDescription');
  }

  function collectPlatforms() {
    config.platforms.windows = checked('wizPlatWindows');
    config.platforms.macos   = checked('wizPlatMacos');
    config.platforms.linux   = checked('wizPlatLinux');
    config.architectures.x64   = checked('wizArchX64');
    config.architectures.arm64 = checked('wizArchArm64');
  }

  function collectComponents() {
    config.components.ssnRedaction       = checked('wizCompSsn');
    config.components.pdfCorruptionRepair = checked('wizCompRepair');
    config.components.fontHealthAnalysis = checked('wizCompFont');
  }

  function collectJava() {
    config.javaBundle = document.querySelector('input[name="wizJavaBundle"]:checked')
      ? document.querySelector('input[name="wizJavaBundle"]:checked').value
      : 'bundle';
    config.javaBundleSource = document.querySelector('input[name="wizJavaSource"]:checked')
      ? document.querySelector('input[name="wizJavaSource"]:checked').value
      : 'auto';
    config.javaLocalPath = val('wizJavaLocalPath');
  }

  function collectBranding() {
    config.splashText  = val('wizSplashText');
    config.companyName = val('wizCompanyName');
    config.copyright   = val('wizCopyright');
    config.licenseText = val('wizLicense');
  }

  function collectAdvanced() {
    config.autoUpdateUrl   = val('wizAutoUpdateUrl');
    config.installPath     = val('wizInstallPath');
    config.fileAssocPdf    = checked('wizFileAssocPdf');
    config.desktopShortcut = checked('wizDesktopShortcut');
    config.startMenuEntry  = checked('wizStartMenu');
    config.runAfterInstall = checked('wizRunAfter');
  }

  // ── Step-specific bindings ─────────────────────────────────────

  function bindStep1() {
    // No special bindings; fields are standard inputs.
  }

  function bindStep2() {
    // Card selection highlight
    document.querySelectorAll('#wizStep2 .wiz-card-option').forEach(function (card) {
      var input = card.querySelector('input');
      if (!input) return;
      input.addEventListener('change', function () {
        card.classList.toggle('selected', input.checked);
      });
      // Init state
      if (input.checked) card.classList.add('selected');
    });
  }

  function bindStep3() {
    document.querySelectorAll('#wizStep3 .wiz-card-option').forEach(function (card) {
      var input = card.querySelector('input');
      if (!input) return;
      input.addEventListener('change', function () {
        card.classList.toggle('selected', input.checked);
      });
      if (input.checked) card.classList.add('selected');
    });
  }

  function bindStep4() {
    // Show/hide JRE source options based on radio
    var radios = document.querySelectorAll('input[name="wizJavaBundle"]');
    var sourceGroup = document.getElementById('wizJavaSourceGroup');
    radios.forEach(function (r) {
      r.addEventListener('change', function () {
        if (sourceGroup) {
          sourceGroup.style.display = r.value === 'bundle' && r.checked ? '' : 'none';
        }
      });
    });

    // Show/hide local path
    var sourceRadios = document.querySelectorAll('input[name="wizJavaSource"]');
    var localGroup = document.getElementById('wizJavaLocalGroup');
    sourceRadios.forEach(function (r) {
      r.addEventListener('change', function () {
        if (localGroup) {
          localGroup.style.display = r.value === 'local' && r.checked ? '' : 'none';
        }
      });
    });
  }

  function bindStep5() {
    // Icon upload
    var uploadArea = document.getElementById('wizIconUpload');
    var fileInput  = document.getElementById('wizIconFile');
    var preview    = document.getElementById('wizIconPreview');

    if (uploadArea && fileInput) {
      uploadArea.addEventListener('click', function () { fileInput.click(); });
      uploadArea.addEventListener('dragover', function (e) { e.preventDefault(); uploadArea.style.borderColor = 'var(--wiz-primary)'; });
      uploadArea.addEventListener('dragleave', function () { uploadArea.style.borderColor = ''; });
      uploadArea.addEventListener('drop', function (e) {
        e.preventDefault();
        uploadArea.style.borderColor = '';
        if (e.dataTransfer.files.length) handleIconFile(e.dataTransfer.files[0], preview);
      });
      fileInput.addEventListener('change', function () {
        if (fileInput.files.length) handleIconFile(fileInput.files[0], preview);
      });
    }
  }

  function handleIconFile(file, preview) {
    config.appIcon = file;
    var reader = new FileReader();
    reader.onload = function (e) {
      config.appIconPreviewUrl = e.target.result;
      if (preview) {
        preview.src = e.target.result;
        preview.style.display = 'block';
      }
    };
    reader.readAsDataURL(file);
  }

  function bindStep6() {
    // Nothing extra required — standard form fields.
  }

  // ── Color swatches ─────────────────────────────────────────────

  function renderColorSwatches() {
    var container = document.getElementById('wizColorPicker');
    if (!container) return;
    THEME_COLORS.forEach(function (color) {
      var swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'wiz-swatch' + (color === config.themeColor ? ' selected' : '');
      swatch.style.background = color;
      swatch.setAttribute('data-color', color);
      swatch.addEventListener('click', function () {
        config.themeColor = color;
        container.querySelectorAll('.wiz-swatch').forEach(function (s) { s.classList.remove('selected'); });
        swatch.classList.add('selected');
      });
      container.appendChild(swatch);
    });
  }

  // ── Review step ────────────────────────────────────────────────

  function populateReview() {
    collectStepData(currentStep - 1); // collect the last edited step

    // Product info card
    setReviewList('wizRevProduct', [
      config.productName + ' v' + config.version,
      config.description || '(no description)',
    ]);

    // Platforms
    var platList = [];
    if (config.platforms.windows) platList.push('Windows (.exe)');
    if (config.platforms.macos)   platList.push('macOS (.dmg)');
    if (config.platforms.linux)   platList.push('Linux (.AppImage/.deb)');
    var archList = [];
    if (config.architectures.x64)   archList.push('x64');
    if (config.architectures.arm64) archList.push('arm64');
    platList.push('Architecture: ' + archList.join(', '));
    setReviewList('wizRevPlatforms', platList);

    // Components
    var compList = ['Accessibility Tagging (core)'];
    if (config.components.ssnRedaction)       compList.push('SSN Redaction');
    if (config.components.pdfCorruptionRepair) compList.push('PDF Corruption Repair');
    if (config.components.fontHealthAnalysis) compList.push('Font Health Analysis');
    setReviewList('wizRevComponents', compList);

    // Java
    var javaItems = [];
    if (config.javaBundle === 'bundle') {
      javaItems.push('Bundle JRE 21 (~120 MB)');
      javaItems.push('Source: ' + (config.javaBundleSource === 'auto' ? 'Auto-download' : 'Local: ' + config.javaLocalPath));
    } else {
      javaItems.push('Require system Java 21');
    }
    setReviewList('wizRevJava', javaItems);

    // Branding
    var brandItems = [];
    if (config.companyName) brandItems.push(config.companyName);
    if (config.copyright)   brandItems.push(config.copyright);
    brandItems.push('Theme: ' + config.themeColor);
    if (config.appIcon) brandItems.push('Custom icon: ' + config.appIcon.name);
    setReviewList('wizRevBranding', brandItems.length ? brandItems : ['(defaults)']);

    // Advanced
    var advItems = [];
    if (config.installPath)  advItems.push('Install path: ' + config.installPath);
    if (config.autoUpdateUrl) advItems.push('Auto-update: ' + config.autoUpdateUrl);
    advItems.push('Desktop shortcut: ' + (config.desktopShortcut ? 'Yes' : 'No'));
    advItems.push('Start menu: ' + (config.startMenuEntry ? 'Yes' : 'No'));
    advItems.push('.pdf association: ' + (config.fileAssocPdf ? 'Yes' : 'No'));
    advItems.push('Run after install: ' + (config.runAfterInstall ? 'Yes' : 'No'));
    setReviewList('wizRevAdvanced', advItems);

    // Code previews
    var ymlEl = document.getElementById('wizYamlPreview');
    if (ymlEl) ymlEl.innerHTML = highlightYaml(generateElectronBuilderYml(config));

    var jsonEl = document.getElementById('wizJsonPreview');
    if (jsonEl) jsonEl.innerHTML = highlightJson(generateBuildConfig(config));
  }

  function setReviewList(id, items) {
    var ul = document.getElementById(id);
    if (!ul) return;
    ul.innerHTML = items.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('');
  }

  // ── Config generators ──────────────────────────────────────────

  function generateElectronBuilderYml(cfg) {
    var lines = [];
    lines.push('appId: com.' + slugify(cfg.companyName || 'company') + '.' + slugify(cfg.productName));
    lines.push('productName: "' + cfg.productName + '"');
    lines.push('');
    lines.push('# Directories');
    lines.push('directories:');
    lines.push('  output: dist');
    lines.push('  buildResources: build');
    lines.push('');

    if (cfg.platforms.windows) {
      lines.push('win:');
      lines.push('  target:');
      lines.push('    - target: nsis');
      lines.push('      arch:');
      if (cfg.architectures.x64)   lines.push('        - x64');
      if (cfg.architectures.arm64) lines.push('        - arm64');
      lines.push('');
      lines.push('nsis:');
      lines.push('  oneClick: false');
      lines.push('  perMachine: true');
      lines.push('  allowToChangeInstallationDirectory: true');
      if (cfg.desktopShortcut) lines.push('  createDesktopShortcut: true');
      if (cfg.startMenuEntry) lines.push('  createStartMenuShortcut: true');
      if (cfg.runAfterInstall) lines.push('  runAfterFinish: true');
      if (cfg.licenseText) lines.push('  license: license.txt');
      lines.push('');
    }

    if (cfg.platforms.macos) {
      lines.push('mac:');
      lines.push('  target:');
      lines.push('    - target: dmg');
      lines.push('      arch:');
      if (cfg.architectures.x64)   lines.push('        - x64');
      if (cfg.architectures.arm64) lines.push('        - arm64');
      lines.push('  category: public.app-category.productivity');
      lines.push('');
    }

    if (cfg.platforms.linux) {
      lines.push('linux:');
      lines.push('  target:');
      lines.push('    - AppImage');
      lines.push('    - deb');
      lines.push('  category: Office');
      lines.push('');
    }

    if (cfg.fileAssocPdf) {
      lines.push('fileAssociations:');
      lines.push('  - ext: pdf');
      lines.push('    mimeType: application/pdf');
      lines.push('    name: PDF Document');
      lines.push('');
    }

    if (cfg.autoUpdateUrl) {
      lines.push('publish:');
      lines.push('  provider: generic');
      lines.push('  url: "' + cfg.autoUpdateUrl + '"');
      lines.push('');
    }

    if (cfg.javaBundle === 'bundle') {
      lines.push('extraResources:');
      lines.push('  - from: jre/');
      lines.push('    to: jre');
      lines.push('    filter:');
      lines.push('      - "**/*"');
      lines.push('');
    }

    return lines.join('\n');
  }

  function generateBuildConfig(cfg) {
    var obj = {
      product: {
        name: cfg.productName,
        version: cfg.version,
        description: cfg.description,
      },
      platforms: [],
      architectures: [],
      components: {
        accessibilityTagging: true,
        ssnRedaction: cfg.components.ssnRedaction,
        pdfCorruptionRepair: cfg.components.pdfCorruptionRepair,
        fontHealthAnalysis: cfg.components.fontHealthAnalysis,
      },
      java: {
        bundle: cfg.javaBundle === 'bundle',
        source: cfg.javaBundle === 'bundle' ? cfg.javaBundleSource : null,
        localPath: cfg.javaBundle === 'bundle' && cfg.javaBundleSource === 'local' ? cfg.javaLocalPath : null,
      },
      branding: {
        splashText: cfg.splashText,
        companyName: cfg.companyName,
        copyright: cfg.copyright,
        themeColor: cfg.themeColor,
        hasCustomIcon: !!cfg.appIcon,
        hasLicense: !!cfg.licenseText,
      },
      installer: {
        autoUpdateUrl: cfg.autoUpdateUrl || null,
        installPath: cfg.installPath || null,
        fileAssocPdf: cfg.fileAssocPdf,
        desktopShortcut: cfg.desktopShortcut,
        startMenuEntry: cfg.startMenuEntry,
        runAfterInstall: cfg.runAfterInstall,
      },
    };

    if (cfg.platforms.windows) obj.platforms.push('windows');
    if (cfg.platforms.macos)   obj.platforms.push('macos');
    if (cfg.platforms.linux)   obj.platforms.push('linux');
    if (cfg.architectures.x64)   obj.architectures.push('x64');
    if (cfg.architectures.arm64) obj.architectures.push('arm64');

    return JSON.stringify(obj, null, 2);
  }

  // ── Build simulation ───────────────────────────────────────────

  function startBuild() {
    var btn       = document.getElementById('wizBuildBtn');
    var bar       = document.getElementById('wizProgressFill');
    var logEl     = document.getElementById('wizBuildLog');
    var statusEl  = document.getElementById('wizBuildStatus');
    var dlEl      = document.getElementById('wizDownloadLink');

    if (!btn || !bar || !logEl) return;

    btn.disabled = true;
    logEl.textContent = '';
    if (statusEl) { statusEl.className = 'wiz-status'; statusEl.style.display = 'none'; }
    if (dlEl) dlEl.style.display = 'none';

    var steps = [
      { pct: 5,   msg: '[info]  Validating configuration...' },
      { pct: 10,  msg: '[info]  Configuration valid.' },
      { pct: 15,  msg: '[info]  Generating electron-builder.yml...' },
      { pct: 20,  msg: '[info]  Generating build-config.json...' },
      { pct: 25,  msg: '[info]  Preparing build directory...' },
      { pct: 35,  msg: '[info]  Copying application resources...' },
      { pct: 40,  msg: '[info]  Bundling components: Accessibility Tagging' + (config.components.ssnRedaction ? ', SSN Redaction' : '') + (config.components.pdfCorruptionRepair ? ', PDF Corruption Repair' : '') + (config.components.fontHealthAnalysis ? ', Font Health Analysis' : '') },
      { pct: 50,  msg: config.javaBundle === 'bundle' ? '[info]  Bundling JRE 21...' : '[info]  Skipping JRE bundle (system Java required)' },
      { pct: 60,  msg: '[info]  Compiling native modules...' },
      { pct: 70,  msg: '[info]  Packaging application...' },
      { pct: 80,  msg: '[info]  Building installer for: ' + Object.keys(config.platforms).filter(function (k) { return config.platforms[k]; }).join(', ') },
      { pct: 90,  msg: '[info]  Signing and finalizing...' },
      { pct: 95,  msg: '[info]  Running post-build checks...' },
      { pct: 100, msg: '[done]  Build complete!' },
    ];

    var i = 0;
    function tick() {
      if (i >= steps.length) {
        btn.disabled = false;
        if (statusEl) {
          statusEl.textContent = 'Build succeeded';
          statusEl.className = 'wiz-status success';
          statusEl.style.display = 'inline-flex';
        }
        if (dlEl) {
          dlEl.style.display = 'inline-flex';
          dlEl.textContent = 'Download installer (simulated)';
        }
        return;
      }
      var step = steps[i];
      bar.style.width = step.pct + '%';
      logEl.textContent += step.msg + '\n';
      logEl.scrollTop = logEl.scrollHeight;
      i++;
      setTimeout(tick, 350 + Math.random() * 250);
    }
    tick();
  }

  // ── Syntax highlighting (simple) ───────────────────────────────

  function highlightYaml(str) {
    return str.split('\n').map(function (line) {
      // Comments
      if (/^\s*#/.test(line)) return '<span class="hl-comment">' + escapeHtml(line) + '</span>';
      // Key-value
      var m = line.match(/^(\s*)([\w-]+)(\s*:\s*)(.*)/);
      if (m) {
        var val2 = m[4];
        var valClass = '';
        if (/^".*"$/.test(val2) || /^'.*'$/.test(val2)) valClass = 'hl-str';
        else if (/^(true|false)$/i.test(val2)) valClass = 'hl-bool';
        else if (/^\d+$/.test(val2)) valClass = 'hl-num';
        else valClass = 'hl-str';
        return escapeHtml(m[1]) + '<span class="hl-key">' + escapeHtml(m[2]) + '</span>' + escapeHtml(m[3]) + (val2 ? '<span class="' + valClass + '">' + escapeHtml(val2) + '</span>' : '');
      }
      // List items
      var lm = line.match(/^(\s*-\s+)(.*)/);
      if (lm) return escapeHtml(lm[1]) + '<span class="hl-str">' + escapeHtml(lm[2]) + '</span>';
      return escapeHtml(line);
    }).join('\n');
  }

  function highlightJson(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"([^"]+)"(\s*:)/g, '<span class="hl-key">"$1"</span>$2')
      .replace(/:\s*"([^"]*)"/g, ': <span class="hl-str">"$1"</span>')
      .replace(/:\s*(true|false)/g, ': <span class="hl-bool">$1</span>')
      .replace(/:\s*(\d+)/g, ': <span class="hl-num">$1</span>')
      .replace(/:\s*(null)/g, ': <span class="hl-bool">$1</span>');
  }

  // ── Helpers ────────────────────────────────────────────────────

  function val(id)     { var el = document.getElementById(id); return el ? el.value : ''; }
  function checked(id) { var el = document.getElementById(id); return el ? el.checked : false; }
  function slugify(s)  { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'app'; }
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Returns the current wizard configuration object (deep copy).
   * @returns {object}
   */
  function getWizardConfig() {
    // Collect whatever step we're on
    collectStepData(currentStep);
    return JSON.parse(JSON.stringify(config));
  }

  // Expose to global scope for programmatic access
  window.InstallerWizard = {
    init: init,
    getWizardConfig: getWizardConfig,
    generateElectronBuilderYml: generateElectronBuilderYml,
    generateBuildConfig: generateBuildConfig,
    goToStep: goToStep,
    startBuild: startBuild,
  };

  // Auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
