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
    expect(result.findings[0].source).toBe('regex');
    expect(result.findings[0].detectorSources).toEqual(['regex']);
    expect(result.sourceGroups).toHaveLength(1);
    expect(result.sourceGroups[0].findings).toHaveLength(1);
    expect(result.sourceGroups[0].findings[0].source).toBe('regex');
    expect(result.sourceGroups[0].findings[0].detectorSources).toEqual(['regex']);
  });

  it('strips HTML tags before scanning text/html files', async () => {
    const { assess } = await import('../../src/core/engine');
    const { detectRegex } = await import('../../src/core/detectors/regex-detector');
    vi.mocked(detectRegex).mockClear();

    const file = new File(
      ['<h1>Dummy Indonesia PII</h1><pre>Budi Santoso NIK 3171011508900001</pre><script>secret()</script>'],
      'indonesia-pii.html',
      { type: 'text/html' },
    );

    await assess({ files: [file] }, {
      enableRegex: true,
      enableNer: false,
    });

    expect(detectRegex).toHaveBeenCalledWith(expect.stringContaining('Dummy Indonesia PII'));
    expect(detectRegex).toHaveBeenCalledWith(expect.stringContaining('Budi Santoso NIK 3171011508900001'));
    expect(detectRegex).not.toHaveBeenCalledWith(expect.stringContaining('<h1>'));
    expect(detectRegex).not.toHaveBeenCalledWith(expect.stringContaining('<script>'));
    expect(detectRegex).not.toHaveBeenCalledWith(expect.stringContaining('secret()'));
  });

  it('normalizes OCR table text before scanning', async () => {
    const { assess } = await import('../../src/core/engine');
    const { detectRegex } = await import('../../src/core/detectors/regex-detector');
    const { extractTextFromImage } = await import('../../src/core/extractors/image-ocr');
    vi.mocked(detectRegex).mockClear();
    vi.mocked(extractTextFromImage).mockResolvedValueOnce({
      text:
        'FORMULIRVERIFIKASIPELANGGAN\n' +
        'BudiSantosomengajukanpembaruandatapelanggan,NomorNIKvangtercatatadalah3171011508900001,r\n' +
        'Nama\n' +
        'NIK\n' +
        'Telepon\n' +
        'NPWP\n' +
        'BudiSantoso\n' +
        '3171011508900001\n' +
        '+62.812.3456.7890\n' +
        '12.345.678.9-012.345\n' +
        'SitiAminah\n' +
        '3273025211950003\n' +
        '+62.856.9876.5432\n' +
        '98.765.432.1-098.765\n' +
        'AgusPrasetv03578052003880005\n' +
        '+62.819.1234.5678\n' +
        '11.222.333.4-555.666',
      timeMs: 123,
      source: 'ocr',
    });

    const file = new File(['dummy'], 'image.png', { type: 'image/png' });

    await assess({ files: [file] }, {
      enableRegex: true,
      enableNer: false,
    });

    const scanned = vi.mocked(detectRegex).mock.calls[0][0];
    expect(scanned).toContain('3171011508900001');
    expect(scanned).toContain('3273025211950003');
    expect(scanned).toContain('NIK: 3578052003880005');
    expect(scanned).toContain('NO HP: +62 812 3456 7890');
    expect(scanned).toContain('NO HP: +62 856 9876 5432');
    expect(scanned).toContain('NO HP: +62 819 1234 5678');
    expect(scanned).toContain('NPWP: 12.345.678.9-012.345');
    expect(scanned).toContain('NPWP: 98.765.432.1-098.765');
    expect(scanned).toContain('NPWP: 11.222.333.4-555.666');
    expect(scanned).toContain('FORMULIRVERIFIKASIPELANGGAN');
    expect(scanned).toContain('OCR NORMALIZED');
  });

  it('preserves raw OCR text when normalization adds helper lines', async () => {
    const { assess } = await import('../../src/core/engine');
    const { detectRegex } = await import('../../src/core/detectors/regex-detector');
    const { extractTextFromImage } = await import('../../src/core/extractors/image-ocr');
    vi.mocked(detectRegex).mockClear();
    vi.mocked(extractTextFromImage).mockResolvedValueOnce({
      text:
        'Nama\n' +
        'IC\n' +
        'Telefon\n' +
        'Alamat\n' +
        'Poskod\n' +
        'AhmadbinAl\n' +
        '901231-14-5678\n' +
        '+60123456789No.12JalanAmpang.KL\n' +
        '50450',
      timeMs: 123,
      source: 'ocr',
    });

    const file = new File(['dummy'], 'malaysia.png', { type: 'image/png' });

    await assess({ files: [file] }, {
      enableRegex: true,
      enableNer: false,
    });

    const scanned = vi.mocked(detectRegex).mock.calls[0][0];
    expect(scanned).toContain('901231-14-5678');
    expect(scanned).toContain('+60123456789No.12JalanAmpang.KL');
    expect(scanned).toContain('50450');
    expect(scanned).not.toContain('Alamat kode pos 50450');
  });
});
