import { uniquePdfLinks } from "./link-utils.js";

const runButton = document.querySelector("#run-button");
const statusText = document.querySelector("#status-text");
const resultCount = document.querySelector("#result-count");
const resultList = document.querySelector("#result-list");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function renderResults(links) {
  resultCount.textContent = String(links.length);
  resultList.innerHTML = "";

  for (const link of links) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = link.text || "Untitled PDF";

    const url = document.createElement("div");
    url.className = "result-url";
    url.textContent = link.href;

    item.append(label, url);
    resultList.append(item);
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function collectPageLinks(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return Array.from(document.querySelectorAll("a[href]")).map((anchor) => ({
        href: anchor.href,
        text: (anchor.textContent || "").replace(/\s+/g, " ").trim()
      }));
    }
  });

  return result || [];
}

async function openLinksInBackground(links) {
  for (const [index, link] of links.entries()) {
    await chrome.tabs.create({
      url: link.href,
      active: false
    });

    if (index < links.length - 1) {
      await sleep(200);
    }
  }
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  statusText.textContent = "Scanning the active page for PDF links...";

  try {
    const activeTab = await getActiveTab();
    if (!activeTab?.id) {
      throw new Error("No active tab is available.");
    }

    const links = uniquePdfLinks(await collectPageLinks(activeTab.id));
    renderResults(links);

    if (links.length === 0) {
      statusText.textContent = "No PDF links were found on this page.";
      return;
    }

    statusText.textContent = `Opening ${links.length} PDF link${links.length === 1 ? "" : "s"} in background tabs...`;
    await openLinksInBackground(links);
    statusText.textContent = `Opened ${links.length} PDF link${links.length === 1 ? "" : "s"}.`;
  } catch (error) {
    statusText.textContent = error.message || "The extension failed.";
  } finally {
    runButton.disabled = false;
  }
});
