const PDF_PATH_PATTERN = /\.pdf$/i;

export function isPdfUrl(value) {
  if (!value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return PDF_PATH_PATTERN.test(parsed.pathname);
  } catch {
    return /(?:^|\/)[^?#]+\.pdf(?:[?#]|$)/i.test(String(value));
  }
}

export function uniquePdfLinks(candidates) {
  const seen = new Set();
  const results = [];

  for (const candidate of candidates || []) {
    const href = String(candidate?.href || "").trim();
    if (!isPdfUrl(href)) {
      continue;
    }

    let normalizedHref = href;
    try {
      const parsed = new URL(href);
      parsed.hash = "";
      normalizedHref = parsed.toString();
    } catch {
      normalizedHref = href.replace(/#.*$/, "");
    }

    if (seen.has(normalizedHref)) {
      continue;
    }

    seen.add(normalizedHref);
    results.push({
      href: normalizedHref,
      text: String(candidate?.text || "").trim()
    });
  }

  return results;
}
