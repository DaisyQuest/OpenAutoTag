import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const tmpDir = path.join(repoRoot, "tmp", "difftool-pw-" + Date.now());

/**
 * Playwright visual validation tests for the diff-tool page.
 *
 * These tests verify that the /difftool page renders correctly,
 * that all key UI elements are present and visible, and that the
 * layout is digestible by human eyes.
 *
 * The tests self-skip when Playwright is not installed.
 */

let playwright;
let createAppServer;
let createJobQueue;

try {
  playwright = await import("playwright");
} catch {
  // Playwright not installed — tests will self-skip
}

try {
  ({ createAppServer } = await import("../../orchestrator/server.js"));
  ({ createJobQueue } = await import("../../orchestrator/job-queue.js"));
} catch {
  // Server module unavailable — tests will self-skip
}

const canRun = Boolean(playwright && createAppServer);

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function startTestServer() {
  return new Promise((resolve) => {
    const queue = createJobQueue({
      processor: async () => ({ status: "completed", artifacts: {} }),
      outputRoot: tmpDir
    });
    const server = createAppServer({ queue, uploadRoot: tmpDir });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

if (!canRun) {
  test("difftool Playwright tests skipped — dependencies not available", { skip: true }, () => {});
} else {
  let server;
  let port;
  let baseUrl;
  let browser;

  test.before(async () => {
    await mkdir(tmpDir, { recursive: true });
    ({ server, port, baseUrl } = await startTestServer());
    browser = await playwright.chromium.launch({ headless: true });
  });

  test.after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("difftool page loads and shows branded header", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      // Check page title
      const title = await page.title();
      assert.ok(title.includes("PDF Diff Tool"), `Title should include 'PDF Diff Tool', got: ${title}`);

      // Check brand mark
      const brandText = await page.textContent(".brand-mark");
      assert.ok(brandText.includes("PDF Accessibility Engine"));

      // Check hero
      const heroText = await page.textContent(".hero-copy h1");
      assert.ok(heroText.includes("Compare"));

      // Check topbar has difftool link as active
      const activeLink = await page.textContent(".topbar-link.is-active");
      assert.ok(activeLink.includes("Diff Tool"));
    } finally {
      await page.close();
    }
  });

  test("difftool page has upload dropzones visible", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      const sourceDropzone = await page.locator("#source-dropzone");
      assert.ok(await sourceDropzone.isVisible(), "Source dropzone should be visible");

      const competitorDropzone = await page.locator("#competitor-dropzone");
      assert.ok(await competitorDropzone.isVisible(), "Competitor dropzone should be visible");
    } finally {
      await page.close();
    }
  });

  test("difftool page has mode radio buttons", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      const radios = await page.locator('input[name="writerMode"]').count();
      assert.equal(radios, 3, "Should have 3 writer mode radio buttons");

      // "auto" should be checked by default
      const autoChecked = await page.locator('input[name="writerMode"][value="auto"]').isChecked();
      assert.ok(autoChecked, "Auto mode should be checked by default");
    } finally {
      await page.close();
    }
  });

  test("difftool compare button is disabled without files", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      const btn = page.locator("#compare-btn");
      assert.ok(await btn.isDisabled(), "Compare button should be disabled without files");
    } finally {
      await page.close();
    }
  });

  test("difftool page shows empty state initially", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      const emptyState = page.locator("#empty-state");
      assert.ok(await emptyState.isVisible(), "Empty state should be visible");

      const emptyText = await emptyState.textContent();
      assert.ok(emptyText.includes("Upload documents"), "Empty state should prompt upload");
    } finally {
      await page.close();
    }
  });

  test("difftool page has variant tabs (initially hidden)", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      const tabsContainer = page.locator("#variant-tabs-container");
      assert.ok(await tabsContainer.isHidden(), "Variant tabs should be hidden initially");

      const tabCount = await page.locator(".variant-tab").count();
      assert.equal(tabCount, 3, "Should have 3 variant tabs");
    } finally {
      await page.close();
    }
  });

  test("difftool page exposes export action", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      const exportButton = page.locator("#export-btn");
      assert.ok(await exportButton.isVisible(), "Export button should be visible");
      assert.ok(await exportButton.isDisabled(), "Export button should be disabled until PDFs are selected");
      assert.equal((await exportButton.textContent()).trim(), "EXPORT");
    } finally {
      await page.close();
    }
  });

  test("difftool stylesheet is loaded and applies colours", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      // Verify the page uses our brand background
      const bodyBg = await page.evaluate(() => {
        return window.getComputedStyle(document.body).backgroundImage;
      });
      assert.ok(bodyBg && bodyBg !== "none", "Body should have a branded background");

      // Verify the compare button has styled background
      const btnBg = await page.evaluate(() => {
        const btn = document.getElementById("compare-btn");
        return window.getComputedStyle(btn).backgroundColor;
      });
      assert.ok(btnBg && btnBg !== "rgba(0, 0, 0, 0)", "Compare button should have styled background");
    } finally {
      await page.close();
    }
  });

  test("difftool foreground/background pairs meet 7.5 contrast", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      const ratios = await page.evaluate(() => {
        function parseRgb(value) {
          const match = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (!match) return null;
          return [Number(match[1]), Number(match[2]), Number(match[3])];
        }

        function luminance([r, g, b]) {
          return [r, g, b]
            .map((channel) => {
              const c = channel / 255;
              return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            })
            .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
        }

        function ratio(foreground, background) {
          const fg = parseRgb(foreground);
          const bg = parseRgb(background);
          if (!fg || !bg) return 0;
          const lighter = Math.max(luminance(fg), luminance(bg));
          const darker = Math.min(luminance(fg), luminance(bg));
          return (lighter + 0.05) / (darker + 0.05);
        }

        return [
          ".upload-card",
          ".mode-label-desc",
          "#compare-btn",
          "#export-btn",
          ".variant-tab.active"
        ].map((selector) => {
          const element = document.querySelector(selector);
          const style = window.getComputedStyle(element);
          const backgroundElement = style.backgroundColor === "rgba(0, 0, 0, 0)" ? element.closest(".upload-card") || element.parentElement : element;
          const background = window.getComputedStyle(backgroundElement).backgroundColor;
          return {
            selector,
            ratio: ratio(style.color, background)
          };
        });
      });

      for (const item of ratios) {
        assert.ok(item.ratio >= 7.5, `${item.selector} contrast ${item.ratio.toFixed(2)} should be >= 7.5`);
      }
    } finally {
      await page.close();
    }
  });

  test("difftool page layout is responsive", async () => {
    const page = await browser.newPage();
    try {
      // Desktop
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${baseUrl}/difftool`, { waitUntil: "domcontentloaded" });

      const gridCols = await page.evaluate(() => {
        const grid = document.querySelector(".difftool-grid");
        return window.getComputedStyle(grid).gridTemplateColumns;
      });
      assert.ok(gridCols.includes("320px"), "Desktop should have sidebar column");

      // Mobile
      await page.setViewportSize({ width: 400, height: 800 });
      await page.waitForTimeout(200);

      const mobileCols = await page.evaluate(() => {
        const grid = document.querySelector(".difftool-grid");
        return window.getComputedStyle(grid).gridTemplateColumns;
      });
      // On mobile, grid should collapse to single column
      assert.ok(!mobileCols.includes("320px"), "Mobile should not have 320px sidebar");
    } finally {
      await page.close();
    }
  });
}
