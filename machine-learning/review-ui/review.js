const state = {
  items: [],
  index: 0,
  summary: null,
  busy: false,
  zoomPercent: 100,
  pan: null
};

const MIN_ZOOM = 60;
const MAX_ZOOM = 500;
const ZOOM_STEP = 20;

const summaryReviewed = document.querySelector("#summary-reviewed");
const summaryRemaining = document.querySelector("#summary-remaining");
const summaryNotes = document.querySelector("#summary-notes");
const statusFilter = document.querySelector("#status-filter");
const reloadButton = document.querySelector("#reload-button");
const reviewCard = document.querySelector("#review-card");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character];
  });
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }
  return `${Math.round(numeric * 1000) / 10}%`;
}

function formatBbox(bbox) {
  if (!Array.isArray(bbox)) {
    return "n/a";
  }
  return bbox.map((value) => Number(value).toFixed(1)).join(", ");
}

function buildSampleUrl(item) {
  return `/api/items/${encodeURIComponent(item.itemKey)}/sample.svg`;
}

function clampZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 100;
  }

  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(numeric / ZOOM_STEP) * ZOOM_STEP));
}

function zoomLabel() {
  return `${state.zoomPercent}%`;
}

function zoomClass(value) {
  return `zoom-${clampZoom(value)}`;
}

function renderZoomControls() {
  return `
    <div class="sample-toolbar" aria-label="Sample zoom controls">
      <div class="zoom-button-group" role="group" aria-label="Zoom controls">
        <button class="zoom-button" type="button" data-zoom-action="out" aria-label="Zoom out" title="Zoom out">-</button>
        <label class="zoom-slider-label" for="zoom-slider">
          <span>Zoom</span>
          <input
            id="zoom-slider"
            class="zoom-slider"
            type="range"
            min="${MIN_ZOOM}"
            max="${MAX_ZOOM}"
            step="${ZOOM_STEP}"
            value="${state.zoomPercent}"
            aria-valuetext="${escapeHtml(zoomLabel())}"
          />
        </label>
        <output id="zoom-value" class="zoom-value" for="zoom-slider">${escapeHtml(zoomLabel())}</output>
        <button class="zoom-button" type="button" data-zoom-action="in" aria-label="Zoom in" title="Zoom in">+</button>
        <button class="zoom-preset" type="button" data-zoom-action="fit">Fit</button>
        <button class="zoom-preset" type="button" data-zoom-action="detail">200%</button>
      </div>
    </div>
  `;
}

function applyZoom({ preserveViewport = false } = {}) {
  const figure = reviewCard.querySelector(".sample-figure");
  const slider = reviewCard.querySelector("#zoom-slider");
  const value = reviewCard.querySelector("#zoom-value");
  const image = reviewCard.querySelector(".sample-figure img");
  let centerX = 0.5;
  let centerY = 0.5;

  if (preserveViewport && figure && figure.scrollWidth > 0 && figure.scrollHeight > 0) {
    centerX = (figure.scrollLeft + figure.clientWidth / 2) / figure.scrollWidth;
    centerY = (figure.scrollTop + figure.clientHeight / 2) / figure.scrollHeight;
  }

  if (figure) {
    for (const className of [...figure.classList]) {
      if (className.startsWith("zoom-")) {
        figure.classList.remove(className);
      }
    }
    figure.classList.add(zoomClass(state.zoomPercent));
    figure.dataset.zoomed = state.zoomPercent > 100 ? "true" : "false";
  }

  if (slider) {
    slider.value = String(state.zoomPercent);
    slider.setAttribute("aria-valuetext", zoomLabel());
  }

  if (value) {
    value.textContent = zoomLabel();
  }

  if (preserveViewport && figure && image) {
    requestAnimationFrame(() => {
      figure.scrollLeft = Math.max(0, centerX * figure.scrollWidth - figure.clientWidth / 2);
      figure.scrollTop = Math.max(0, centerY * figure.scrollHeight - figure.clientHeight / 2);
    });
  }
}

function setZoom(value, options = {}) {
  state.zoomPercent = clampZoom(value);
  applyZoom(options);
}

function handleZoomAction(action) {
  if (action === "in") {
    setZoom(state.zoomPercent + ZOOM_STEP, { preserveViewport: true });
  } else if (action === "out") {
    setZoom(state.zoomPercent - ZOOM_STEP, { preserveViewport: true });
  } else if (action === "fit") {
    setZoom(100);
  } else if (action === "detail") {
    setZoom(200, { preserveViewport: true });
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

function renderSummary() {
  const summary = state.summary || {};
  summaryReviewed.textContent = String(summary.reviewedItems || 0);
  summaryRemaining.textContent = String(summary.unreviewedItems || 0);
  summaryNotes.textContent = String(summary.notesForAgents || 0);
}

function renderAlternatives(item) {
  const alternatives = Array.isArray(item.alternatives) ? item.alternatives.slice(0, 5) : [];
  if (alternatives.length === 0) {
    return `<div class="alternative-chip">No alternatives reported</div>`;
  }

  return alternatives
    .map(
      (alternative) => `
        <span class="alternative-chip">
          <strong>${escapeHtml(alternative.label)}</strong> ${escapeHtml(formatPercent(alternative.confidence))}
        </span>
      `
    )
    .join("");
}

function renderItem() {
  const item = state.items[state.index];
  if (!item) {
    reviewCard.innerHTML = `<div class="empty-state">No matching review items.</div>`;
    return;
  }

  reviewCard.innerHTML = `
    <div class="card-header">
      <div>
        <h2>${escapeHtml(item.documentId)}</h2>
        <p class="source-path">${escapeHtml(item.sourcePdf || item.reportPath)}</p>
      </div>
      <span class="classification-pill">Prediction <strong>${escapeHtml(item.predictedLabel || "unknown")}</strong></span>
    </div>
    <div class="review-body">
      <section class="sample-layout" aria-label="Visual sample">
        <div class="sample-viewer">
          ${renderZoomControls()}
          <figure class="sample-figure ${escapeHtml(zoomClass(state.zoomPercent))}" tabindex="0" aria-label="Zoomable PDF page sample">
          <img src="${escapeHtml(buildSampleUrl(item))}" alt="Page drawing with the classified sample outlined" />
          </figure>
        </div>
        <div class="sample-context">
          <p class="sample-label">Sample text</p>
          <p class="text-block">${escapeHtml(item.text || "(no semantic text available)")}</p>
        </div>
      </section>
      <div class="meta-grid" aria-label="Prediction details">
        <div class="meta-item"><span>Deterministic</span><strong>${escapeHtml(item.deterministicDecision || "n/a")}</strong></div>
        <div class="meta-item"><span>Confidence</span><strong>${escapeHtml(formatPercent(item.confidence))}</strong></div>
        <div class="meta-item"><span>Page</span><strong>${escapeHtml(item.target?.pageNumber || "n/a")}</strong></div>
        <div class="meta-item"><span>BBox</span><strong>${escapeHtml(formatBbox(item.target?.bbox))}</strong></div>
      </div>
      <div class="alternative-list" aria-label="Classifier alternatives">
        ${renderAlternatives(item)}
      </div>
      <label class="notes-field" for="notes-input">
        <span>Notes for agents (optional)</span>
        <textarea id="notes-input" spellcheck="true" placeholder="Optional correction context, uncertainty, or visible clue."></textarea>
      </label>
      <div class="review-actions" role="group" aria-label="Human classification decision">
        <button class="decision-button yes" type="button" data-decision="yes">YES</button>
        <button class="decision-button no" type="button" data-decision="no">NO</button>
        <button class="decision-button review" type="button" data-decision="review">REVIEW</button>
      </div>
      <p id="message-line" class="message-line" aria-live="polite">${escapeHtml(state.index + 1)} of ${escapeHtml(state.items.length)}</p>
    </div>
  `;
  applyZoom();
}

async function loadQueue() {
  reviewCard.innerHTML = `<div class="empty-state">Loading review queue.</div>`;
  const [summary, queue] = await Promise.all([
    fetchJson("/api/summary"),
    fetchJson(`/api/items?status=${encodeURIComponent(statusFilter.value)}&limit=100`)
  ]);
  state.summary = summary;
  state.items = queue.items || [];
  state.index = 0;
  renderSummary();
  renderItem();
}

async function submitDecision(decision) {
  if (state.busy) {
    return;
  }

  const item = state.items[state.index];
  if (!item) {
    return;
  }

  state.busy = true;
  const buttons = reviewCard.querySelectorAll("[data-decision]");
  for (const button of buttons) button.disabled = true;

  try {
    const notes = reviewCard.querySelector("#notes-input")?.value || "";
    const payload = await fetchJson("/api/reviews", {
      method: "POST",
      body: JSON.stringify({
        itemKey: item.itemKey,
        decision,
        notes
      })
    });
    state.summary = payload.summary;
    renderSummary();
    state.items.splice(state.index, 1);
    if (state.index >= state.items.length) {
      state.index = Math.max(0, state.items.length - 1);
    }
    renderItem();
  } catch (error) {
    const messageLine = reviewCard.querySelector("#message-line");
    if (messageLine) {
      messageLine.textContent = error.message;
    }
    for (const button of buttons) button.disabled = false;
  } finally {
    state.busy = false;
  }
}

reviewCard.addEventListener("click", (event) => {
  const zoomButton = event.target.closest("[data-zoom-action]");
  if (zoomButton) {
    handleZoomAction(zoomButton.getAttribute("data-zoom-action"));
    return;
  }

  const button = event.target.closest("[data-decision]");
  if (!button) {
    return;
  }
  void submitDecision(button.getAttribute("data-decision"));
});

reviewCard.addEventListener("input", (event) => {
  if (event.target?.id !== "zoom-slider") {
    return;
  }

  setZoom(event.target.value, { preserveViewport: true });
});

reviewCard.addEventListener("wheel", (event) => {
  if (!event.ctrlKey || !event.target.closest(".sample-figure")) {
    return;
  }

  event.preventDefault();
  setZoom(state.zoomPercent + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), { preserveViewport: true });
}, { passive: false });

reviewCard.addEventListener("pointerdown", (event) => {
  const figure = event.target.closest(".sample-figure");
  if (!figure || event.button !== 0 || state.zoomPercent <= 100) {
    return;
  }

  state.pan = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startLeft: figure.scrollLeft,
    startTop: figure.scrollTop
  };
  figure.setPointerCapture(event.pointerId);
  figure.classList.add("is-panning");
});

reviewCard.addEventListener("pointermove", (event) => {
  if (!state.pan) {
    return;
  }

  const figure = event.target.closest(".sample-figure") || reviewCard.querySelector(".sample-figure");
  if (!figure) {
    return;
  }

  figure.scrollLeft = state.pan.startLeft - (event.clientX - state.pan.startX);
  figure.scrollTop = state.pan.startTop - (event.clientY - state.pan.startY);
});

function endPan(event) {
  const figure = reviewCard.querySelector(".sample-figure");
  if (figure && state.pan?.pointerId === event.pointerId) {
    figure.releasePointerCapture(event.pointerId);
    figure.classList.remove("is-panning");
  }
  state.pan = null;
}

reviewCard.addEventListener("pointerup", endPan);
reviewCard.addEventListener("pointercancel", endPan);

reviewCard.addEventListener("keydown", (event) => {
  const activeTag = document.activeElement?.tagName?.toLowerCase();
  if (activeTag === "textarea" || activeTag === "input") {
    return;
  }

  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    handleZoomAction("in");
  } else if (event.key === "-") {
    event.preventDefault();
    handleZoomAction("out");
  } else if (event.key === "0") {
    event.preventDefault();
    handleZoomAction("fit");
  }
});

reloadButton.addEventListener("click", () => {
  void loadQueue();
});

statusFilter.addEventListener("change", () => {
  void loadQueue();
});

void loadQueue();
