import { describe, it, expect } from 'vitest';
import { detectRegex } from '../../src/core/detectors/regex-detector';

describe('regex-detector', () => {
  // ── Malaysian IC ──────────────────────────────────────────────────────
  describe('IC_NUMBER', () => {
    it('detects standard Malaysian IC', () => {
      const { findings } = detectRegex('IC 901231-14-5678');
      const ic = findings.find((f) => f.type === 'IC_NUMBER');
      expect(ic).toBeDefined();
      expect(ic!.value).toBe('901231-14-5678');
      expect(ic!.severity).toBe('critical');
      expect(ic!.source).toBe('regex');
      expect(ic!.confidence).toBe(1.0);
    });

    it('detects multiple ICs in one text', () => {
      const { findings } = detectRegex('IC1: 901231-14-5678 IC2: 850101-01-1234');
      const ics = findings.filter((f) => f.type === 'IC_NUMBER');
      expect(ics).toHaveLength(2);
    });

    it('does not false-positive on non-IC numbers', () => {
      const { findings } = detectRegex('Order #12345 total RM 100.00');
      expect(findings.filter((f) => f.type === 'IC_NUMBER')).toHaveLength(0);
    });
  });

  // ── Phone ─────────────────────────────────────────────────────────────
  describe('PHONE', () => {
    it('detects Malaysian mobile with +60', () => {
      const { findings } = detectRegex('Call me at +60123456789');
      const phone = findings.find((f) => f.type === 'PHONE');
      expect(phone).toBeDefined();
      expect(phone!.severity).toBe('high');
    });

    it('detects ASEAN international phone prefixes', () => {
      const { findings } = detectRegex('SG: +65 9123 4567, TH: +66 8123 45678, VN: +84 912 345 678');
      const phones = findings.filter((f) => f.type === 'PHONE');
      expect(phones.length).toBeGreaterThanOrEqual(3);
    });

    it('does not detect phone substrings inside longer digit identifiers', () => {
      const { findings } = detectRegex('NIK 3273025211950003 was submitted.');
      expect(findings.find((f) => f.type === 'PHONE' && f.value === '950003')).toBeUndefined();
    });

    it('detects phone starting with 01', () => {
      const { findings } = detectRegex('Phone: 0192899378');
      expect(findings.find((f) => f.type === 'PHONE')).toBeDefined();
    });

    it('detects phone with dashes', () => {
      const { findings } = detectRegex('Nombor: 012-345 6789');
      expect(findings.find((f) => f.type === 'PHONE')).toBeDefined();
    });

    it('suppresses OCR phone fragments that overlap normalized phone output', () => {
      const { findings } = detectRegex(
        'NPWP\n+62.812.3456.7890\nOCR NORMALIZED\nNO HP: +62 812 3456 7890',
      );
      expect(findings.find((f) => f.type === 'TAX_ID' && f.value === '62.812.3456.7890')).toBeUndefined();
      expect(findings.find((f) => f.type === 'PHONE' && f.value === '+62 812 3456 7890')).toBeDefined();
    });
  });

  describe('PASSPORT', () => {
    it('detects passport-like IDs with passport context', () => {
      const { findings } = detectRegex('Passport number A12345678');
      expect(findings.find((f) => f.type === 'PASSPORT')).toBeDefined();
    });

    it('skips bare passport-like IDs without context', () => {
      const { findings } = detectRegex('Order A12345678 is ready');
      expect(findings.find((f) => f.type === 'PASSPORT')).toBeUndefined();
    });
  });

  // ── ASEAN National IDs (context-required) ─────────────────────────────
  describe('ASEAN national IDs', () => {
    it('detects Singapore NRIC with identity context', () => {
      const { findings } = detectRegex('NRIC number S1234567D belongs to the applicant.');
      expect(findings.find((f) => f.type === 'SG_NRIC')).toBeDefined();
    });

    it('skips bare Singapore NRIC-like strings without context', () => {
      const { findings } = detectRegex('Ticket S1234567D is queued.');
      expect(findings.find((f) => f.type === 'SG_NRIC')).toBeUndefined();
    });

    it('detects Indonesia NIK with KTP context', () => {
      const { findings } = detectRegex('KTP NIK 3174021234567890 was submitted.');
      expect(findings.find((f) => f.type === 'ID_NIK')).toBeDefined();
    });

    it('detects Indonesia NIK values in flattened table text with a NIK column header', () => {
      const text =
        'NameNIK (16-Digit)Phone NumberAddress' +
        'Budi Santoso3171011508900001+62 812 3456 7890Jl. Melati No. 12, Tebet, Jakarta Selatan' +
        'Siti Aminah3273025211950003+62 856 9876 5432Gg. Kelinci No. 45, Coblong, Bandung' +
        'Agus Prasetyo3578052003880005+62 819 1234 5678Jl. Manyar Kertoarjo No. 8, Mulyorejo, Surabaya' +
        'Dewi Lestari5171034106920002+62 878 5555 4444Perumahan Nusa Dua Block C, Kuta Selatan, Bali';

      const { findings } = detectRegex(text);
      const nikValues = findings.filter((f) => f.type === 'ID_NIK').map((f) => f.value);

      expect(nikValues).toEqual([
        '3171011508900001',
        '3273025211950003',
        '3578052003880005',
        '5171034106920002',
      ]);
    });

    it('detects Indonesia NIK values in spaced table text with a NIK column header', () => {
      const text =
        'Nama            NIK                 Telepon              NPWP\n' +
        'Budi Santoso    3171011508900001    +62 812 3456 7890    12.345.678.9-012.345\n' +
        'Siti Aminah     3273025211950003    +62 856 9876 5432    98.765.432.1-098.765\n' +
        'Agus Prasetyo   3578052003880005    +62 819 1234 5678    11.222.333.4-555.666';

      const { findings } = detectRegex(text);
      const nikValues = findings.filter((f) => f.type === 'ID_NIK').map((f) => f.value);

      expect(nikValues).toEqual([
        '3171011508900001',
        '3273025211950003',
        '3578052003880005',
      ]);
    });

    it('skips bare 16-digit values without NIK context', () => {
      const { findings } = detectRegex('Order 3171011508900001 was shipped.');
      expect(findings.find((f) => f.type === 'ID_NIK')).toBeUndefined();
    });

    it('does not use a distant NIK header to classify a credit card as ID_NIK', () => {
      const text =
        'NameNIK (16-Digit)Phone NumberAddress' +
        'Budi Santoso3171011508900001+62 812 3456 7890Jl. Melati No. 12, Tebet, Jakarta Selatan ' +
        'Credit card 4532015112830366';

      const { findings } = detectRegex(text);

      expect(findings.find((f) => f.type === 'ID_NIK' && f.value === '3171011508900001')).toBeDefined();
      expect(findings.find((f) => f.type === 'ID_NIK' && f.value === '4532015112830366')).toBeUndefined();
      expect(findings.find((f) => f.type === 'CREDIT_CARD' && f.value === '4532015112830366')).toBeDefined();
    });

    it('detects Thai national ID with context', () => {
      const { findings } = detectRegex('Thai national ID 1-2345-67890-12-3 was entered.');
      expect(findings.find((f) => f.type === 'TH_NATIONAL_ID')).toBeDefined();
    });

    it('detects Vietnam CCCD with context', () => {
      const { findings } = detectRegex('Citizen ID CCCD 012345678901 is on the form.');
      expect(findings.find((f) => f.type === 'VN_CCCD')).toBeDefined();
    });

    it('detects Philippines national ID with context', () => {
      const { findings } = detectRegex('PhilID number 1234-5678-9012-3456 was scanned.');
      expect(findings.find((f) => f.type === 'PH_NATIONAL_ID')).toBeDefined();
    });

    it('detects Myanmar NRC with context', () => {
      const { findings } = detectRegex('NRC 12/KaNaNa(N)123456 appears in the file.');
      expect(findings.find((f) => f.type === 'MM_NRC')).toBeDefined();
    });
  });

  // ── Email ─────────────────────────────────────────────────────────────
  describe('EMAIL', () => {
    it('detects standard email', () => {
      const { findings } = detectRegex('Send to ahmad@gmail.com please');
      const email = findings.find((f) => f.type === 'EMAIL');
      expect(email).toBeDefined();
      expect(email!.value).toBe('ahmad@gmail.com');
      expect(email!.severity).toBe('high');
    });

    it('is case-insensitive', () => {
      const { findings } = detectRegex('Email: USER@EXAMPLE.COM');
      expect(findings.find((f) => f.type === 'EMAIL')).toBeDefined();
    });
  });

  // ── Credit Card (Luhn) ────────────────────────────────────────────────
  describe('CREDIT_CARD', () => {
    it('detects valid Visa number (Luhn passes)', () => {
      const { findings } = detectRegex('Card: 4532015112830366');
      expect(findings.find((f) => f.type === 'CREDIT_CARD')).toBeDefined();
    });

    it('rejects invalid Luhn', () => {
      const { findings } = detectRegex('Card: 4532015112830367');
      expect(findings.find((f) => f.type === 'CREDIT_CARD')).toBeUndefined();
    });
  });

  // ── Bank Account (context-required) ───────────────────────────────────
  describe('BANK_ACCT', () => {
    it('detects bank account with context keyword', () => {
      const { findings } = detectRegex('Bank account number 1234567890123');
      expect(findings.find((f) => f.type === 'BANK_ACCT')).toBeDefined();
    });

    it('skips bare numbers without bank context', () => {
      const { findings } = detectRegex('Order number 1234567890123');
      expect(findings.find((f) => f.type === 'BANK_ACCT')).toBeUndefined();
    });

    it('skips numbers matching IC format even with context', () => {
      const { findings } = detectRegex('Bank transfer for IC 901231-14-5678');
      // The IC pattern should match, but not bank_acct for the same span
      const bankFindings = findings.filter((f) => f.type === 'BANK_ACCT');
      for (const bf of bankFindings) {
        expect(bf.value).not.toMatch(/^\d{6}-\d{2}-\d{4}$/);
      }
    });

    it('skips valid credit card numbers even with bank context', () => {
      const { findings } = detectRegex('Bank account number 4532015112830366');
      expect(findings.find((f) => f.type === 'BANK_ACCT')).toBeUndefined();
      expect(findings.find((f) => f.type === 'CREDIT_CARD')).toBeDefined();
    });
  });

  describe('TAX_ID and DRIVER_LICENSE', () => {
    it('detects tax IDs only with tax context', () => {
      const { findings } = detectRegex('Tax ID NPWP 12.345.678.9-012.345 belongs to the vendor.');
      expect(findings.find((f) => f.type === 'TAX_ID')).toBeDefined();
    });

    it('skips tax-like codes without tax context', () => {
      const { findings } = detectRegex('Build ABC12345678 passed.');
      expect(findings.find((f) => f.type === 'TAX_ID')).toBeUndefined();
    });

    it('detects driver license only with license context', () => {
      const { findings } = detectRegex('Driving license D123456789 was provided.');
      expect(findings.find((f) => f.type === 'DRIVER_LICENSE')).toBeDefined();
    });
  });

  // ── Postcode (context-required) ───────────────────────────────────────
  describe('MY_POSTCODE', () => {
    it('detects postcode with address context', () => {
      const { findings } = detectRegex('Alamat: Jalan 1, 50000 KL');
      expect(findings.find((f) => f.type === 'MY_POSTCODE')).toBeDefined();
    });

    it('suppresses OCR postcode fragments inside phone numbers when normalized output exists', () => {
      const { findings } = detectRegex(
        'Alamat\n+62.819.1234.5678\nOCR NORMALIZED\nNO HP: +62 819 1234 5678',
      );
      expect(findings.find((f) => f.type === 'PH_POSTCODE' && f.value === '1234')).toBeUndefined();
      expect(findings.find((f) => f.type === 'PH_POSTCODE' && f.value === '5678')).toBeUndefined();
    });

    it('skips 5-digit number without address context', () => {
      const { findings } = detectRegex('Score: 98765 points');
      expect(findings.find((f) => f.type === 'MY_POSTCODE')).toBeUndefined();
    });
  });

  // ── Developer Secrets ─────────────────────────────────────────────────
  describe('Developer secrets', () => {
    it('detects AWS access key', () => {
      const { findings } = detectRegex('AKIAIOSFODNN7EXAMPLE1');
      expect(findings.find((f) => f.type === 'AWS_KEY')).toBeDefined();
    });

    it('detects GitHub PAT', () => {
      const { findings } = detectRegex('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
      expect(findings.find((f) => f.type === 'GITHUB_PAT')).toBeDefined();
    });

    it('detects private key header', () => {
      const { findings } = detectRegex('-----BEGIN RSA PRIVATE KEY-----');
      expect(findings.find((f) => f.type === 'PRIVATE_KEY')).toBeDefined();
    });

    it('detects JWT', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_DEF-123';
      const { findings } = detectRegex(jwt);
      expect(findings.find((f) => f.type === 'JWT')).toBeDefined();
    });
  });

  // ── US SSN ────────────────────────────────────────────────────────────
  describe('US_SSN', () => {
    it('detects US SSN format', () => {
      const { findings } = detectRegex('SSN: 123-45-6789');
      expect(findings.find((f) => f.type === 'US_SSN')).toBeDefined();
    });
  });

  // ── IP Address ────────────────────────────────────────────────────────
  describe('IP_ADDRESS', () => {
    it('detects valid IPv4', () => {
      const { findings } = detectRegex('Server at 192.168.1.100');
      expect(findings.find((f) => f.type === 'IP_ADDRESS')).toBeDefined();
    });

    it('rejects out-of-range octets', () => {
      const { findings } = detectRegex('Not IP: 999.999.999.999');
      expect(findings.find((f) => f.type === 'IP_ADDRESS')).toBeUndefined();
    });
  });

  // ── Performance ───────────────────────────────────────────────────────
  describe('performance', () => {
    it('runs in under 50ms on 1000-word text', () => {
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(120);
      const { timeMs } = detectRegex(text);
      expect(timeMs).toBeLessThan(50);
    });
  });

  // ── Offsets ───────────────────────────────────────────────────────────
  describe('offsets', () => {
    it('returns correct startIndex and endIndex', () => {
      const text = 'Hello ahmad@gmail.com world';
      const { findings } = detectRegex(text);
      const email = findings.find((f) => f.type === 'EMAIL');
      expect(email).toBeDefined();
      expect(text.slice(email!.startIndex, email!.endIndex)).toBe('ahmad@gmail.com');
    });
  });

  // ── Empty / clean text ────────────────────────────────────────────────
  describe('clean text', () => {
    it('returns empty findings for clean text', () => {
      const { findings } = detectRegex('Hello, how are you today?');
      expect(findings).toHaveLength(0);
    });

    it('handles empty string', () => {
      const { findings } = detectRegex('');
      expect(findings).toHaveLength(0);
    });
  });
});
