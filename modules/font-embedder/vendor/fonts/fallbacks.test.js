import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FONTS_DIR = __dirname;

function readFallbacks() {
  return JSON.parse(fs.readFileSync(path.join(FONTS_DIR, 'fallbacks.json'), 'utf8'));
}

function hasFontMagic(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  const magic = buf.toString('hex');
  return ['00010000', '4f54544f', '74727565', '74746366'].includes(magic);
}

test('fallbacks.json parses and has required entries', () => {
  const fb = readFallbacks();
  assert.strictEqual(fb.schemaVersion, '1.0.0');
  const required = [
    'helvetica', 'helvetica-bold', 'helvetica-oblique', 'helvetica-boldoblique',
    'times-roman', 'times-bold', 'times-italic', 'times-bolditalic',
    'courier', 'courier-bold', 'courier-oblique', 'courier-boldoblique',
    'symbol', 'zapfdingbats', 'universal'
  ];
  for (const key of required) {
    assert.ok(fb.fallbacks[key], `missing fallback entry: ${key}`);
    assert.ok(fb.fallbacks[key].path, `missing path for ${key}`);
    assert.strictEqual(fb.fallbacks[key].license, 'OFL-1.1');
  }
});

test('every committed fallback file exists and has valid font magic', () => {
  const fb = readFallbacks();
  for (const [key, desc] of Object.entries(fb.fallbacks)) {
    if (desc.requiresInstall) continue;
    const full = path.join(REPO_ROOT, desc.path);
    assert.ok(fs.existsSync(full), `${key} -> ${desc.path} does not exist`);
    assert.ok(hasFontMagic(full), `${key} -> ${desc.path} has invalid font magic`);
  }
});

test('every family folder has a LICENSE.txt', () => {
  const families = fs.readdirSync(FONTS_DIR).filter((name) => {
    const full = path.join(FONTS_DIR, name);
    return fs.statSync(full).isDirectory();
  });
  assert.ok(families.length >= 4, 'expected at least 4 family folders');
  for (const family of families) {
    const licensePath = path.join(FONTS_DIR, family, 'LICENSE.txt');
    if (family === 'noto-sans-cjk' && !fs.existsSync(licensePath)) continue;
    assert.ok(fs.existsSync(licensePath), `${family}/LICENSE.txt missing`);
  }
});

test('CJK install script exists and is referenced by package.json', () => {
  const scriptPath = path.join(REPO_ROOT, 'scripts', 'install-fonts.js');
  assert.ok(fs.existsSync(scriptPath), 'scripts/install-fonts.js missing');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts['install:fonts'], 'install:fonts script missing from package.json');
});
