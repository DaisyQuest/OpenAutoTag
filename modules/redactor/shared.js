export const SSN_PATTERN =
  /(?<!\d)(?:(?!000|666)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}|(?!000|666)\d{3}(?!00)\d{2}(?!0000)\d{4})(?!\d)/g;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function maskSsnMatch(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? `***-**-${digits.slice(-4)}` : "***-**-****";
}

export function findSsnMatchesInText(text) {
  const matches = [];
  const source = String(text || "");
  const expression = new RegExp(SSN_PATTERN);
  let match;

  while ((match = expression.exec(source))) {
    matches.push({
      index: match.index,
      value: match[0],
      maskedText: maskSsnMatch(match[0])
    });
  }

  return matches;
}

export function applySsnMasking(text) {
  const source = String(text || "");
  const matches = findSsnMatchesInText(source);

  if (!matches.length) {
    return {
      text: source,
      matches: []
    };
  }

  let cursor = 0;
  let masked = "";

  for (const match of matches) {
    masked += source.slice(cursor, match.index);
    masked += match.maskedText;
    cursor = match.index + match.value.length;
  }

  masked += source.slice(cursor);

  return {
    text: masked,
    matches
  };
}

export function estimateMatchBbox(block, match, page) {
  const [x = 0, y = 0, width = 0, height = 0] = block.bbox || [];
  const text = String(block.text || "");
  const totalCharacters = Math.max(text.length, 1);
  const startRatio = clamp(match.index / totalCharacters, 0, 1);
  const endRatio = clamp((match.index + match.value.length) / totalCharacters, 0, 1);
  const boxX = x + width * startRatio;
  const boxWidth = Math.max(8, width * Math.max(endRatio - startRatio, 0.06));
  const padX = Math.max(2, Math.min(width * 0.015, 6));
  const padY = Math.max(1, Math.min(height * 0.2, 4));
  const pageWidth = page?.width ?? boxX + boxWidth + padX * 2;
  const pageHeight = page?.height ?? y + height + padY * 2;
  const maxWidth = Math.max(8, pageWidth - boxX);

  return [
    Number(clamp(boxX - padX, 0, pageWidth).toFixed(3)),
    Number(clamp(y - padY, 0, pageHeight).toFixed(3)),
    Number(clamp(boxWidth + padX * 2, 8, maxWidth).toFixed(3)),
    Number(clamp(height + padY * 2, 8, pageHeight - y + padY).toFixed(3))
  ];
}

export function buildBlockLookup(layoutDocument) {
  const blocksById = new Map();

  for (const page of layoutDocument.pages || []) {
    for (const block of page.textBlocks || []) {
      blocksById.set(block.id, {
        block,
        page
      });
    }
  }

  return blocksById;
}

export function finalizeRedactionReport({
  workloadId,
  sourcePdf,
  outputPdf,
  plan,
  outputMode,
  accessibilityTreeRedacted = false
}) {
  return {
    schemaVersion: "1.0.0",
    workloadId,
    status: "completed",
    sourcePdf,
    outputPdf,
    accessibilityTreeRedacted,
    summary: {
      pagesProcessed: plan.summary?.pagesProcessed ?? 0,
      candidateMatches: plan.summary?.candidateMatches ?? 0,
      redactedMatches: plan.summary?.redactedMatches ?? 0,
      pagesRedacted: plan.summary?.pagesRedacted ?? 0,
      outputMode
    },
    matches: plan.matches || []
  };
}
