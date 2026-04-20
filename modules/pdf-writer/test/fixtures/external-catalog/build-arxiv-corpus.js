#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultCategoriesPath = path.join(scriptDir, "arxiv-categories.json");
const defaultManifestPath = path.join(scriptDir, "manifest.json");
const defaultDownloadRoot = path.join(scriptDir, "downloads");
const defaultStatePath = path.join(scriptDir, "state", "last-download-report.json");
const apiBase = "https://export.arxiv.org/api/query";
const defaultUserAgent = "OpenAutoTag-pdf-writer-fixtures/0.1 (+local noncommercial fixture generation)";
const defaultApiDelayMs = 3100;
const defaultDownloadDelayMs = 1500;
const defaultPageSize = 200;
const defaultPerCategory = 100;
const defaultMaxFileBytes = 25 * 1024 * 1024;
const defaultMaxDownloads = 25;
const sourceDocs = [
  "https://info.arxiv.org/help/api/index.html",
  "https://info.arxiv.org/help/api/tou.html",
  "https://info.arxiv.org/help/api/basics.html",
  "https://info.arxiv.org/help/api/user-manual.html",
  "https://arxiv.org/category_taxonomy"
];

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eqIndex = token.indexOf("=");
    const rawKey = token.slice(2, eqIndex === -1 ? undefined : eqIndex);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (eqIndex !== -1) {
      options[key] = token.slice(eqIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
      continue;
    }
    options[key] = true;
  }
  return {
    command: positionals[0] || "discover",
    options
  };
}

function readIntOption(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid --${name}: ${value}`);
  }
  return parsed;
}

function readStringOption(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function collapseWhitespace(text) {
  return decodeXmlEntities(text).replace(/\s+/g, " ").trim();
}

function extractFirst(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

function extractAll(text, pattern) {
  return [...text.matchAll(pattern)].map(match => match[1]);
}

function parseTagAttributes(attributeText) {
  const attributes = {};
  for (const match of attributeText.matchAll(/\b([A-Za-z:._-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }
  return attributes;
}

function parseArxivId(url) {
  const match = /\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/.exec(url);
  if (!match) return null;
  return match[1];
}

function normalizeArxivUrl(url) {
  return String(url || "")
    .replace(/^http:\/\/arxiv\.org\//, "https://arxiv.org/")
    .replace(/^http:\/\/export\.arxiv\.org\//, "https://export.arxiv.org/");
}

function sanitizeIdForPath(arxivId) {
  return String(arxivId).replace(/[/:]/g, "_");
}

function parseAtomFeed(xmlText) {
  const totalResults = Number.parseInt(
    extractFirst(xmlText, /<opensearch:totalResults>(\d+)<\/opensearch:totalResults>/),
    10
  );
  const entries = [...xmlText.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => {
    const entryXml = match[1];
    const abstractUrl = normalizeArxivUrl(collapseWhitespace(extractFirst(entryXml, /<id>([\s\S]*?)<\/id>/)));
    const linkTags = [...entryXml.matchAll(/<link\b([^>]*?)\/>/g)].map(linkMatch => parseTagAttributes(linkMatch[1]));
    const pdfUrl = normalizeArxivUrl(linkTags.find(link => link.title === "pdf")?.href || "");
    const arxivId = parseArxivId(pdfUrl || abstractUrl);
    const primaryCategoryTag = extractFirst(entryXml, /<arxiv:primary_category\b([^>]*?)\/>/);
    const primaryCategory = primaryCategoryTag ? parseTagAttributes(primaryCategoryTag).term || null : null;
    const categories = [...entryXml.matchAll(/<category\b([^>]*?)\/>/g)]
      .map(categoryMatch => parseTagAttributes(categoryMatch[1]).term || null)
      .filter(Boolean);
    const authors = extractAll(entryXml, /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)
      .map(collapseWhitespace)
      .filter(Boolean);
    const doi = collapseWhitespace(extractFirst(entryXml, /<arxiv:doi>([\s\S]*?)<\/arxiv:doi>/) || "");
    return {
      arxivId,
      baseId: arxivId ? arxivId.replace(/v\d+$/, "") : null,
      title: collapseWhitespace(extractFirst(entryXml, /<title>([\s\S]*?)<\/title>/)),
      abstractUrl,
      pdfUrl,
      publishedAt: collapseWhitespace(extractFirst(entryXml, /<published>([\s\S]*?)<\/published>/)),
      updatedAt: collapseWhitespace(extractFirst(entryXml, /<updated>([\s\S]*?)<\/updated>/)),
      primaryCategory,
      categories,
      authors,
      doi: doi || null
    };
  }).filter(entry => entry.arxivId && entry.pdfUrl && entry.primaryCategory);

  return {
    totalResults: Number.isFinite(totalResults) ? totalResults : entries.length,
    entries
  };
}

async function fetchText(url, userAgent) {
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "application/atom+xml,text/xml;q=0.9,*/*;q=0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function loadCategories(filePath) {
  const data = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`category file is empty: ${filePath}`);
  }
  return data;
}

function buildQueryUrl(categoryId, start, maxResults, sortBy, sortOrder) {
  const params = new URLSearchParams({
    search_query: `cat:${categoryId}`,
    start: String(start),
    max_results: String(maxResults),
    sortBy,
    sortOrder
  });
  return `${apiBase}?${params.toString()}`;
}

async function discoverCorpus(config) {
  const categories = await loadCategories(config.categoriesPath);
  const globalIds = new Set();
  const manifestCategories = [];
  const items = [];

  for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
    const category = categories[categoryIndex];
    const selected = [];
    const localIds = new Set();
    let start = 0;
    let totalResults = null;

    while (selected.length < config.perCategory) {
      const url = buildQueryUrl(category.id, start, config.pageSize, config.sortBy, config.sortOrder);
      console.error(`[discover] ${category.id}: start=${start} max_results=${config.pageSize}`);
      const xml = await fetchText(url, config.userAgent);
      const feed = parseAtomFeed(xml);
      totalResults = feed.totalResults;
      if (feed.entries.length === 0) break;

      for (const entry of feed.entries) {
        if (entry.primaryCategory !== category.id) continue;
        if (localIds.has(entry.arxivId)) continue;
        if (globalIds.has(entry.arxivId)) {
          throw new Error(`duplicate arXiv id across primary categories: ${entry.arxivId}`);
        }
        localIds.add(entry.arxivId);
        globalIds.add(entry.arxivId);
        selected.push({
          id: `arxiv:${entry.arxivId}`,
          arxivId: entry.arxivId,
          baseId: entry.baseId,
          title: entry.title,
          authors: entry.authors,
          abstractUrl: entry.abstractUrl,
          pdfUrl: entry.pdfUrl,
          publishedAt: entry.publishedAt,
          updatedAt: entry.updatedAt,
          primaryCategory: category.id,
          categories: entry.categories,
          doi: entry.doi,
          source: "arxiv",
          localRelativePath: path.posix.join("downloads", category.id, `${sanitizeIdForPath(entry.arxivId)}.pdf`)
        });
        if (selected.length >= config.perCategory) break;
      }

      start += config.pageSize;
      if (selected.length >= config.perCategory || start >= totalResults) break;
      await delay(config.apiDelayMs);
    }

    if (selected.length !== config.perCategory) {
      throw new Error(
        `${category.id}: expected ${config.perCategory} primary-category papers, found ${selected.length}`
      );
    }

    manifestCategories.push({
      ...category,
      count: selected.length
    });
    items.push(...selected);

    if (categoryIndex < categories.length - 1) {
      await delay(config.apiDelayMs);
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: {
      name: "arXiv public API",
      apiBase,
      docs: sourceDocs
    },
    policy: {
      targetCategories: manifestCategories.length,
      perCategory: config.perCategory,
      primaryCategoryOnly: true,
      pageSize: config.pageSize,
      sortBy: config.sortBy,
      sortOrder: config.sortOrder,
      apiDelayMs: config.apiDelayMs,
      defaultDownloadDelayMs: defaultDownloadDelayMs,
      defaultMaxFileBytes: defaultMaxFileBytes
    },
    categories: manifestCategories,
    items
  };

  await mkdir(path.dirname(config.manifestPath), { recursive: true });
  await writeFile(config.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function loadManifest(filePath) {
  const manifest = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(manifest.items) || !Array.isArray(manifest.categories)) {
    throw new Error(`invalid manifest: ${filePath}`);
  }
  return manifest;
}

async function isExistingPdf(filePath) {
  if (!existsSync(filePath)) return false;
  const fileStat = await stat(filePath);
  return fileStat.isFile() && fileStat.size >= 5;
}

function selectItemsRoundRobin(items, categories, maxDownloads) {
  const grouped = new Map(categories.map(category => [category.id, []]));
  for (const item of items) {
    const bucket = grouped.get(item.primaryCategory);
    if (bucket) bucket.push(item);
  }
  const selected = [];
  let progressed = true;
  while (selected.length < maxDownloads && progressed) {
    progressed = false;
    for (const category of categories) {
      const bucket = grouped.get(category.id);
      if (!bucket || bucket.length === 0) continue;
      selected.push(bucket.shift());
      progressed = true;
      if (selected.length >= maxDownloads) break;
    }
  }
  return selected;
}

async function downloadCorpus(config) {
  const manifest = await loadManifest(config.manifestPath);
  const categories = config.onlyCategories.length > 0
    ? manifest.categories.filter(category => config.onlyCategories.includes(category.id))
    : manifest.categories;
  const filteredItems = manifest.items.filter(item =>
    categories.some(category => category.id === item.primaryCategory)
  );
  const maxDownloads = Math.min(config.maxDownloads, filteredItems.length);
  const selectedItems = selectItemsRoundRobin(filteredItems, categories, maxDownloads);

  await mkdir(config.downloadRoot, { recursive: true });
  await mkdir(path.dirname(config.statePath), { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    manifestPath: path.resolve(config.manifestPath),
    downloadRoot: path.resolve(config.downloadRoot),
    attempted: 0,
    downloaded: 0,
    skippedExisting: 0,
    skippedOversize: 0,
    skippedInvalidPdf: 0,
    failed: 0,
    maxDownloads,
    categories: Object.fromEntries(categories.map(category => [category.id, 0])),
    failures: []
  };

  for (let index = 0; index < selectedItems.length; index += 1) {
    const item = selectedItems[index];
    report.attempted += 1;
    const targetPath = path.join(config.downloadRoot, item.primaryCategory, `${sanitizeIdForPath(item.arxivId)}.pdf`);

    if (await isExistingPdf(targetPath)) {
      report.skippedExisting += 1;
      continue;
    }

    console.error(`[download] ${index + 1}/${selectedItems.length} ${item.primaryCategory} ${item.arxivId}`);
    let response;
    try {
      response = await fetch(item.pdfUrl, {
        headers: {
          "user-agent": config.userAgent,
          accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1"
        }
      });
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }

      const declaredBytes = Number.parseInt(response.headers.get("content-length") || "", 10);
      if (Number.isFinite(declaredBytes) && declaredBytes > config.maxFileBytes) {
        report.skippedOversize += 1;
        response.body?.cancel?.();
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > config.maxFileBytes) {
        report.skippedOversize += 1;
        continue;
      }
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        report.skippedInvalidPdf += 1;
        continue;
      }

      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, buffer);
      report.downloaded += 1;
      report.categories[item.primaryCategory] += 1;
    } catch (error) {
      report.failed += 1;
      if (report.failures.length < 20) {
        report.failures.push({
          arxivId: item.arxivId,
          category: item.primaryCategory,
          pdfUrl: item.pdfUrl,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (index < selectedItems.length - 1) {
      await delay(config.downloadDelayMs);
    }
  }

  await writeFile(config.statePath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function printUsageAndExit() {
  console.error("usage:");
  console.error("  node build-arxiv-corpus.js discover [--manifest path] [--categories path]");
  console.error("  node build-arxiv-corpus.js download [--manifest path] [--download-root path]");
  process.exitCode = 1;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (!["discover", "download"].includes(command)) {
    printUsageAndExit();
    return;
  }

  if (command === "discover") {
    const manifest = await discoverCorpus({
      categoriesPath: readStringOption(options.categories, defaultCategoriesPath),
      manifestPath: readStringOption(options.manifest, defaultManifestPath),
      perCategory: readIntOption(options.perCategory, defaultPerCategory, "per-category"),
      pageSize: readIntOption(options.pageSize, defaultPageSize, "page-size"),
      apiDelayMs: readIntOption(options.apiDelayMs, defaultApiDelayMs, "api-delay-ms"),
      sortBy: readStringOption(options.sortBy, "submittedDate"),
      sortOrder: readStringOption(options.sortOrder, "descending"),
      userAgent: readStringOption(options.userAgent, defaultUserAgent)
    });
    process.stdout.write(`${JSON.stringify({
      manifestPath: path.resolve(readStringOption(options.manifest, defaultManifestPath)),
      categories: manifest.categories.length,
      items: manifest.items.length
    }, null, 2)}\n`);
    return;
  }

  const onlyCategories = readStringOption(options.onlyCategories, "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const report = await downloadCorpus({
    manifestPath: readStringOption(options.manifest, defaultManifestPath),
    downloadRoot: readStringOption(options.downloadRoot, defaultDownloadRoot),
    statePath: readStringOption(options.state, defaultStatePath),
    userAgent: readStringOption(options.userAgent, defaultUserAgent),
    maxDownloads: readIntOption(options.maxDownloads, defaultMaxDownloads, "max-downloads"),
    maxFileBytes: readIntOption(options.maxFileBytes, defaultMaxFileBytes, "max-file-bytes"),
    downloadDelayMs: readIntOption(options.downloadDelayMs, defaultDownloadDelayMs, "download-delay-ms"),
    onlyCategories
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
