import { describe, it, expect, vi } from 'vitest';
import type { Finding } from '../../src/core/types';

const regexFinding: Finding = {
  type: 'EMAIL',
  value: 'ali@example.com',
  startIndex: 8,
  endIndex: 23,
  confidence: 0.99,
  severity: 'high',
  source: 'regex',
};

const nerFinding: Finding = {
  ...regexFinding,
  confidence: 0.9,
  source: 'ner',
};

vi.mock('../../src/core/detectors/regex-detector', () => ({
  detectRegex: vi.fn(() => ({ findings: [{ ...regexFinding }], timeMs: 1 })),
}));

vi.mock('../../src/core/detectors/ner-detector', () => ({
  isTokenizerReady: vi.fn(() => true),
  detectNER: vi.fn(() => Promise.resolve({ findings: [{ ...nerFinding }], timeMs: 1 })),
}));

vi.mock('../../src/lib/ort-engine', () => ({
  isReady: vi.fn(() => true),
}));

vi.mock('../../src/core/extractors/pdf-extractor', () => ({
  extractPdfFromFile: vi.fn(),
}));

vi.mock('../../src/core/extractors/docx-extractor', () => ({
  extractDocxFromFile: vi.fn(),
}));

vi.mock('../../src/core/extractors/image-ocr', () => ({
  extractTextFromImage: vi.fn(),
}));

describe('engine', () => {
  it('deduplicates source group findings the same way as top-level findings', async () => {
    const { assess } = await import('../../src/core/engine');

    const result = await assess({ text: 'Email: ali@example.com' }, {
      enableRegex: true,
      enableNer: true,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].source).toBe('ner');
    expect(result.findings[0].detectorSources).toEqual(['ner', 'regex']);
    expect(result.sourceGroups).toHaveLength(1);
    expect(result.sourceGroups[0].findings).toHaveLength(1);
    expect(result.sourceGroups[0].findings[0].source).toBe('ner');
    expect(result.sourceGroups[0].findings[0].detectorSources).toEqual(['ner', 'regex']);
  });
});
