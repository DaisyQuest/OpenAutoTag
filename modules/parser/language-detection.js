function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenizeWords(text) {
  return normalizeText(text).toLowerCase().match(/\p{L}+/gu) || [];
}

function countStopwordHits(tokens, stopwords) {
  return tokens.reduce((total, token) => total + (stopwords.has(token) ? 1 : 0), 0);
}

function countSpanishAccentHits(text) {
  return (text.match(/[\u00E1\u00E9\u00ED\u00F3\u00FA\u00F1\u00FC\u00BF\u00A1]/gu) || []).length;
}

function countEnglishMarkerHits(tokens) {
  const markers = new Set(["the", "and", "with", "from", "this", "that", "first", "second", "report", "note"]);
  return countStopwordHits(tokens, markers);
}

function countSpanishSuffixHits(tokens) {
  return tokens.reduce(
    (total, token) => total + (/\u00F3n$|ciones$|mente$|idad$|idades$|amiento$|amientos$/u.test(token) ? 1 : 0),
    0
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const ENGLISH_STOPWORDS = new Set([
  "the",
  "and",
  "of",
  "to",
  "in",
  "is",
  "for",
  "with",
  "on",
  "that",
  "this",
  "by",
  "from",
  "as",
  "are",
  "be",
  "or",
  "an",
  "at",
  "it",
  "not",
  "under",
  "into"
]);

const SPANISH_STOPWORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "y",
  "de",
  "del",
  "en",
  "para",
  "con",
  "por",
  "una",
  "un",
  "este",
  "esta",
  "que",
  "como",
  "se",
  "es",
  "al",
  "donde",
  "est\u00E1",
  "estan",
  "est\u00E1n"
]);

export function detectLanguageFromText(text) {
  const normalizedText = normalizeText(text).toLowerCase();
  const tokens = tokenizeWords(normalizedText);
  const wordCount = tokens.length;

  if (wordCount === 0) {
    return {
      language: "und",
      confidence: 0,
      wordCount: 0,
      scores: {
        english: 0,
        spanish: 0
      }
    };
  }

  const englishStopwordHits = countStopwordHits(tokens, ENGLISH_STOPWORDS);
  const spanishStopwordHits = countStopwordHits(tokens, SPANISH_STOPWORDS);
  const englishMarkerHits = countEnglishMarkerHits(tokens);
  const spanishAccentHits = countSpanishAccentHits(normalizedText);
  const spanishSuffixHits = countSpanishSuffixHits(tokens);
  const invertedPunctuationHits = (normalizedText.match(/[\u00BF\u00A1]/gu) || []).length;

  const englishScore = englishStopwordHits * 1.45 + englishMarkerHits * 0.65;
  const spanishScore =
    spanishStopwordHits * 1.45 + spanishAccentHits * 2.2 + spanishSuffixHits * 0.9 + invertedPunctuationHits * 2.5;

  const strongestScore = Math.max(englishScore, spanishScore);
  const weakestScore = Math.min(englishScore, spanishScore);

  if (strongestScore < 1.25 && spanishAccentHits === 0 && wordCount < 5) {
    return {
      language: "und",
      confidence: 0.2,
      wordCount,
      scores: {
        english: Number(englishScore.toFixed(3)),
        spanish: Number(spanishScore.toFixed(3))
      }
    };
  }

  const language = spanishScore > englishScore ? "es-ES" : "en-US";
  const confidence = clamp(
    0.42 + (strongestScore - weakestScore) / Math.max(strongestScore + weakestScore, 1) * 0.46 + Math.min(wordCount / 24, 0.12),
    0,
    0.99
  );

  return {
    language,
    confidence: Number(confidence.toFixed(3)),
    wordCount,
    scores: {
      english: Number(englishScore.toFixed(3)),
      spanish: Number(spanishScore.toFixed(3))
    },
    evidence: {
      englishStopwordHits,
      spanishStopwordHits,
      englishMarkerHits,
      spanishAccentHits,
      spanishSuffixHits,
      invertedPunctuationHits
    }
  };
}

export function detectLanguageFromBlocks(blocks) {
  return detectLanguageFromText((blocks || []).map((block) => block.text).join(" "));
}

export function detectDocumentLanguageFromPages(pages) {
  return detectLanguageFromText(
    (pages || []).flatMap((page) => (page.textBlocks || []).map((block) => block.text)).join(" ")
  );
}

export function annotatePagesWithLanguage(pages) {
  return (pages || []).map((page) => {
    const detection = detectLanguageFromBlocks(page.textBlocks);
    return {
      ...page,
      language: detection.language,
      languageConfidence: detection.confidence
    };
  });
}

function normalizeOcrLanguageCode(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized === "eng" || normalized === "en" || normalized === "en-us" || normalized === "english") {
    return "eng";
  }

  if (normalized === "spa" || normalized === "es" || normalized === "es-es" || normalized === "spanish") {
    return "spa";
  }

  return normalized;
}

export function parseRequestedOcrLanguages(value) {
  const rawValues = Array.isArray(value) ? value : String(value || "").split(/[+,]/);
  const languages = rawValues
    .map((item) => normalizeOcrLanguageCode(item))
    .filter(Boolean);

  return [...new Set(languages)];
}

export function resolveOcrLanguages({ explicitLanguages = [], languageDetection }) {
  if (explicitLanguages.length > 0) {
    return {
      languages: explicitLanguages,
      strategy: "explicit",
      languageHint: languageDetection?.language || "und"
    };
  }

  if (languageDetection?.language === "es-ES") {
    return {
      languages: ["spa", "eng"],
      strategy: "detected-spanish",
      languageHint: "es-ES"
    };
  }

  if (languageDetection?.language === "en-US" && Number(languageDetection?.confidence || 0) >= 0.75) {
    return {
      languages: ["eng"],
      strategy: "detected-english",
      languageHint: "en-US"
    };
  }

  return {
    languages: ["eng", "spa"],
    strategy: "bilingual-fallback",
    languageHint: languageDetection?.language || "und"
  };
}

export function normalizeDocumentLanguageTag(value, fallback = "en-US") {
  const normalized = String(value || "").trim().replace(/_/g, "-").toLowerCase();

  if (normalized === "es" || normalized === "es-es") {
    return "es-ES";
  }

  if (normalized === "en" || normalized === "en-us") {
    return "en-US";
  }

  if (/^[a-z]{2}-[a-z]{2}$/u.test(normalized)) {
    const [language, region] = normalized.split("-");
    return `${language.toLowerCase()}-${region.toUpperCase()}`;
  }

  return fallback;
}
