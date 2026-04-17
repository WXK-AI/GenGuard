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

    it('detects phone starting with 01', () => {
      const { findings } = detectRegex('Phone: 0192899378');
      expect(findings.find((f) => f.type === 'PHONE')).toBeDefined();
    });

    it('detects phone with dashes', () => {
      const { findings } = detectRegex('Nombor: 012-345 6789');
      expect(findings.find((f) => f.type === 'PHONE')).toBeDefined();
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
  });

  // ── Postcode (context-required) ───────────────────────────────────────
  describe('MY_POSTCODE', () => {
    it('detects postcode with address context', () => {
      const { findings } = detectRegex('Alamat: Jalan 1, 50000 KL');
      expect(findings.find((f) => f.type === 'MY_POSTCODE')).toBeDefined();
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
