#!/usr/bin/env node
/*
 * install-fonts.js — downloads large fallback fonts (Noto Sans CJK) that are
 * too big to commit. Idempotent: skips families already present.
 *
 * Latin/Symbol fonts are committed under modules/font-embedder/vendor/fonts/*.
 * This script only handles the CJK pack.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CJK_DIR = path.join(REPO_ROOT, 'modules', 'font-embedder', 'vendor', 'fonts', 'noto-sans-cjk');

const CJK_FONTS = [
  { file: 'NotoSansCJKjp-Regular.otf', url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf' },
  { file: 'NotoSansCJKjp-Bold.otf',    url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansCJKjp-Bold.otf' },
  { file: 'NotoSansCJKsc-Regular.otf', url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf' },
  { file: 'NotoSansCJKtc-Regular.otf', url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf' },
  { file: 'NotoSansCJKkr-Regular.otf', url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf' }
];
const LICENSE_URL = 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE';

function fetchToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'install-fonts.js' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchToFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const tmp = dest + '.partial';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => fs.rename(tmp, dest, (err) => err ? reject(err) : resolve())));
      res.on('error', reject);
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function isValidOtf(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.toString('hex');
    return magic === '00010000' || magic === '4f54544f' || magic === '74727565' || magic === '74746366';
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  await fsp.mkdir(CJK_DIR, { recursive: true });
  const results = [];

  for (const entry of CJK_FONTS) {
    const dest = path.join(CJK_DIR, entry.file);
    if (fs.existsSync(dest) && isValidOtf(dest)) {
      const size = fs.statSync(dest).size;
      console.log(`[skip]    ${entry.file} (${size} bytes, already valid)`);
      results.push({ file: entry.file, status: 'skipped', sha256: await sha256(dest) });
      continue;
    }
    console.log(`[fetch]   ${entry.file} from ${entry.url}`);
    try {
      await fetchToFile(entry.url, dest);
      if (!isValidOtf(dest)) {
        await fsp.unlink(dest).catch(() => {});
        throw new Error('downloaded file failed OTF/TTF magic check');
      }
      const size = fs.statSync(dest).size;
      console.log(`[ok]      ${entry.file} (${size} bytes)`);
      results.push({ file: entry.file, status: 'installed', sha256: await sha256(dest) });
    } catch (err) {
      console.error(`[fail]    ${entry.file}: ${err.message}`);
      results.push({ file: entry.file, status: 'failed', error: err.message });
    }
  }

  const licensePath = path.join(CJK_DIR, 'LICENSE.txt');
  if (!fs.existsSync(licensePath)) {
    try {
      await fetchToFile(LICENSE_URL, licensePath);
      console.log(`[ok]      LICENSE.txt`);
    } catch (err) {
      console.error(`[warn]    LICENSE.txt: ${err.message}`);
    }
  }

  const manifestPath = path.join(CJK_DIR, 'install-manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify({ installedAt: new Date().toISOString(), results }, null, 2));

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.error(`\n${failed.length} font(s) failed to install. CJK support will be unavailable.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} CJK fonts installed to ${CJK_DIR}.`);
}

main().catch((err) => {
  console.error('install-fonts failed:', err.stack || err);
  process.exit(1);
});
