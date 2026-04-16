import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFontReport } from '../lib/font-report-renderer.js';

const SAMPLE_REPORT = {
  fontCount: 3,
  fonts: [
    {
      fontKey: 'AAAAAA+Helvetica',
      baseFont: 'Helvetica',
      subtype: 'Type1',
      embedded: false,
      encoding: 'WinAnsiEncoding',
      pages: [1, 2, 3],
      glyphsUsed: 47,
      findings: [
        {
          checkId: 'STANDARD_14_RELIANCE',
          category: 'embedding',
          severity: 'error',
          description: 'Standard 14 font used without embedding',
          repaired: false,
          repairAction: 'substitute-noto-sans',
          details: {},
        },
        {
          checkId: 'MISSING_TOUNICODE',
          category: 'encoding',
          severity: 'warning',
          description: 'ToUnicode CMap is missing',
          repaired: true,
          repairAction: 'generate-tounicode',
          details: { unicodeCoverage: ['Basic Latin', 'Latin-1 Supplement'] },
        },
      ],
      health: { score: 0.3, grade: 'F', errorCount: 1, warningCount: 1, infoCount: 0 },
    },
    {
      fontKey: 'BBBBBB+TimesNewRoman',
      baseFont: 'TimesNewRoman',
      subtype: 'TrueType',
      embedded: true,
      encoding: 'Identity-H',
      pages: [1],
      glyphsUsed: 120,
      findings: [],
      health: { score: 1.0, grade: 'A', errorCount: 0, warningCount: 0, infoCount: 0 },
    },
    {
      fontKey: 'ArialMT',
      baseFont: 'ArialMT',
      subtype: 'Type0',
      embedded: true,
      encoding: 'Identity-H',
      pages: [2, 4],
      glyphsUsed: 85,
      findings: [
        {
          checkId: 'MISSING_WIDTHS',
          category: 'metrics',
          severity: 'info',
          description: 'Font widths array is incomplete',
          repaired: false,
          repairAction: null,
          details: {},
        },
      ],
      health: { score: 0.85, grade: 'B', errorCount: 0, warningCount: 0, infoCount: 1 },
    },
  ],
  summary: {
    totalFonts: 3,
    healthyFonts: 2,
    damagedFonts: 1,
    totalFindings: 3,
    errorFindings: 1,
    warningFindings: 1,
    infoFindings: 1,
    repairsApplied: 1,
    overallFontHealth: 0.72,
    overallGrade: 'C',
  },
};

describe('renderFontReport', () => {
  it('returns HTML containing "Font Health"', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('Font Health'), 'should contain "Font Health"');
  });

  it('returns HTML containing font names from input', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('Helvetica'), 'should contain Helvetica');
    assert.ok(html.includes('TimesNewRoman'), 'should contain TimesNewRoman');
    assert.ok(html.includes('ArialMT'), 'should contain ArialMT');
  });

  it('returns a complete HTML document', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('<!DOCTYPE html>'), 'should be a full HTML document');
    assert.ok(html.includes('</html>'), 'should close html tag');
  });

  it('includes the overall health percentage', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('72%'), 'should contain overall health 72%');
  });

  it('includes the overall grade', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    // Grade C should appear in a badge
    assert.ok(html.includes('>C<'), 'should contain grade C badge');
  });

  it('includes summary stats', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('3 fonts analyzed'), 'should contain summary text');
    assert.ok(html.includes('2 healthy'), 'should contain healthy count');
  });

  it('includes font subtype badges', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('Type1'), 'should contain Type1 subtype');
    assert.ok(html.includes('TrueType'), 'should contain TrueType subtype');
    assert.ok(html.includes('Type0'), 'should contain Type0 subtype');
  });

  it('includes finding descriptions', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('Standard 14 font used without embedding'), 'should contain error finding');
    assert.ok(html.includes('ToUnicode CMap is missing'), 'should contain warning finding');
  });

  it('includes repair timeline when repairs exist', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('Repair Timeline'), 'should contain repair timeline');
    assert.ok(html.includes('generate-tounicode'), 'should contain repair action');
  });

  it('includes findings table', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('All Findings'), 'should contain findings table');
    assert.ok(html.includes('STANDARD_14_RELIANCE'), 'should contain check ID');
  });

  it('includes footer with engine attribution', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('PDF Accessibility Engine'), 'should contain engine name in footer');
  });

  it('handles empty fonts array gracefully', () => {
    const html = renderFontReport({ fonts: [], summary: { overallFontHealth: 0, overallGrade: 'F' } });
    assert.ok(html.includes('Font Health'), 'should still render with empty fonts');
    assert.ok(html.includes('<!DOCTYPE html>'), 'should be valid HTML');
  });

  it('includes per-font grade badges', () => {
    const html = renderFontReport(SAMPLE_REPORT);
    assert.ok(html.includes('>F<'), 'should contain F grade for Helvetica');
    assert.ok(html.includes('>A<'), 'should contain A grade for TimesNewRoman');
    assert.ok(html.includes('>B<'), 'should contain B grade for ArialMT');
  });
});
