import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderRepairReport } from '../lib/repair-report-renderer.js';

const SAMPLE_REPORT = {
  inputPath: 'document.pdf',
  outputPath: 'repaired.pdf',
  fileSize: 570396,
  corruptionScore: 0.15,
  healthScore: 0.85,
  repairEffectiveness: 0.67,
  riskLevel: 'low',
  humanSummary: '3 issues found, 2 repaired successfully.',
  repairs: [
    { type: 'xref-table', severity: 'error', description: 'Cross-reference table rebuilt from 47 discovered objects', repaired: true, details: { objectsFound: 47, originalXrefValid: false } },
    { type: 'flate-stream', severity: 'warning', description: '1 FlateFilter stream corrupted, partially recovered', repaired: true, details: { corruptStreams: 1, recoveredStreams: 1 } },
    { type: 'fonts', severity: 'info', description: '2 fonts missing ToUnicode CMap', repaired: false, details: { scanned: 4, healthy: 2, missingToUnicode: 2 } },
  ],
  summary: { totalChecks: 8, issuesFound: 3, issuesRepaired: 2, issuesUnrepairable: 1, overallStatus: 'repaired' },
};

describe('renderRepairReport', () => {
  it('returns HTML containing "Health Score"', () => {
    const html = renderRepairReport(SAMPLE_REPORT);
    assert.ok(html.includes('Health Score'), 'should contain "Health Score"');
  });

  it('returns HTML containing the document name', () => {
    const html = renderRepairReport(SAMPLE_REPORT);
    assert.ok(html.includes('document.pdf'), 'should contain document name');
  });

  it('returns a complete HTML document', () => {
    const html = renderRepairReport(SAMPLE_REPORT);
    assert.ok(html.includes('<!DOCTYPE html>'), 'should be a full HTML document');
    assert.ok(html.includes('</html>'), 'should close html tag');
  });

  it('includes the health score percentage', () => {
    const html = renderRepairReport(SAMPLE_REPORT);
    assert.ok(html.includes('85'), 'should contain health score value 85');
  });

  it('includes the risk badge', () => {
    const html = renderRepairReport(SAMPLE_REPORT);
    assert.ok(html.includes('LOW RISK'), 'should contain risk level badge');
  });

  it('includes repair timeline entries', () => {
    const html = renderRepairReport(SAMPLE_REPORT);
    assert.ok(html.includes('Repair Timeline'), 'should contain timeline section');
    assert.ok(html.includes('Cross-Reference Table'), 'should contain human-readable check name');
  });
});
