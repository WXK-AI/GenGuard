/**
 * Regex PII Detector — fast pattern-based detection for structured PII.
 * Runs in parallel with NER as a safety net. Sub-50 ms execution.
 */

import piiPatterns from './pii-patterns.json';
import type { Finding } from '../types';
import type { Severity } from './ner-model-contract';

interface PatternDef {
  name: string;
  label: string;
  regex: string;
  severity: string;
  flags: string;
  contextRequired?: boolean;
}

/** Context keywords that must appear near a postcode for it to be flagged. */
const POSTCODE_CONTEXT = /\b(?:poskod|postcode|zip|postal|kod\s?pos|alamat|address|ที่อยู่|ไปรษณีย์|địa\s+chỉ|mã\s+bưu\s+(?:chính|điện)|kode?\s?pos|alamat|barangay)\b/i;

/** Context keywords for bank account numbers. */
const BANK_CONTEXT = /\b(?:akaun|account|bank|acc|transfer|bayaran|payment|remit|wire|deposit|kredit|debit|simpanan|savings|semasa|current|rekening|tabungan|ธนาคาร|บัญชี|tài\s+khoản|ngân\s+hàng)\b/i;
/** Context keywords for passport-like IDs, which are otherwise easy to confuse with product/order IDs. */
const PASSPORT_CONTEXT = /\b(?:passport|pasport|travel\s+document|immigration|visa|หนังสือเดินทาง|hộ\s+chiếu|paspor)\b/i;
/** Context keywords for national IDs, which overlap with many order/account numeric formats. */
const NATIONAL_ID_CONTEXT = /\b(?:national\s+id|identity\s+card|id\s+(?:card|number|no)|ic|nric|fin|nik|ktp|cccd|citizen\s+id|philid|mykad|nrc|kad\s+pengenalan|kartu\s+tanda\s+penduduk|เลข(?:ประจำตัว)?ประชาชน|บัตรประชาชน|căn\s*cước|chứng\s+minh|អត្តសញ្ញាណប័ណ្ណ|បណ្ណសម្គាល់ខ្លួន|บัตรประจำตัว|kad\s+pengenalan)\b/i;
/** Context keywords for tax identifiers. */
const TAX_CONTEXT = /\b(?:tax|tin|taxpayer|npwp|gst|vat|sst|bir|lhdn|hasil|revenue|ird|iras|cukai|pajak|ภาษี|thuế|เลขประจำตัวผู้เสียภาษี)\b/i;
/** Context keywords for driver licence identifiers. */
const DRIVER_LICENSE_CONTEXT = /\b(?:driver'?s?\s+licen[cs]e|driving\s+licen[cs]e|licen[cs]e\s+(?:no|number)|lesen\s+memandu|sim\s+[abc]|ใบขับขี่|giấy\s+phép\s+lái\s+xe|surat\s+izin\s+mengemudi)\b/i;
/** Context keywords for Laos identification. */
const LAOS_ID_CONTEXT = /\b(?:laos?\s+id|lao\s+(?:id|identity|national)|ບັດປະຈຳຕົວ|ໃບອະນຸຍາດ|id\s+(?:card|number|no))\b/i;
/** Context keywords for vehicle registration plates. */
const VEHICLE_CONTEXT = /\b(?:vehicle|plate|registration|number\s+plate|kenderaan|pendaftaran|plat\s+(?:nombor|no)|kereta|car|motor|ทะเบียนรถ|biển\s+số\s+xe|plat\s+nomor|nopol)\b/i;

const CONTEXT_BY_PATTERN: Record<string, RegExp> = {
  BANK_ACCT: BANK_CONTEXT,
  PASSPORT: PASSPORT_CONTEXT,
  MY_POSTCODE: POSTCODE_CONTEXT,
  SG_POSTCODE: POSTCODE_CONTEXT,
  PH_POSTCODE: POSTCODE_CONTEXT,
  SG_NRIC: NATIONAL_ID_CONTEXT,
  ID_NIK: NATIONAL_ID_CONTEXT,
  TH_NATIONAL_ID: NATIONAL_ID_CONTEXT,
  VN_CCCD: NATIONAL_ID_CONTEXT,
  PH_NATIONAL_ID: NATIONAL_ID_CONTEXT,
  BN_IC: NATIONAL_ID_CONTEXT,
  MM_NRC: NATIONAL_ID_CONTEXT,
  KH_NATIONAL_ID: NATIONAL_ID_CONTEXT,
  LA_ID: LAOS_ID_CONTEXT,
  TAX_ID: TAX_CONTEXT,
  PH_TIN: TAX_CONTEXT,
  DRIVER_LICENSE: DRIVER_LICENSE_CONTEXT,
  MY_VEHICLE: VEHICLE_CONTEXT,
};

/** Flattened table text can put a NIK column header far from later row values. */
const ID_NIK_TABLE_CONTEXT = /\bnik\b|\bname\s*nik\b/i;
const ID_NIK_FLATTENED_ROW_CONTEXT = /[A-Za-z][A-Za-z\s.'-]{2,50}$/;
const ID_NIK_FLATTENED_NEXT_COLUMN = /^\s*\+?62[\s-]?\d/;
const CREDIT_CARD_SHAPE = /^(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}$/;
const OCR_PHONE_SHAPE = /^\+?(?:60|62)[.\s:-]?\d{2,4}(?:[.\s:-]?\d{3,4}){1,3}$/;

/** Luhn checksum validation for credit card numbers. */
function luhnCheck(digits: string): boolean {
  const nums = digits.replace(/[-\s]/g, '');
  let sum = 0;
  let alt = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = parseInt(nums[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Compile patterns once on first call. */
let compiledPatterns: Array<{
  name: string;
  regex: RegExp;
  severity: Severity | 'low';
  contextRequired: boolean;
}> | null = null;

function getPatterns() {
  if (compiledPatterns) return compiledPatterns;

  compiledPatterns = (piiPatterns.patterns as PatternDef[]).map((p) => ({
    name: p.name,
    regex: new RegExp(p.regex, p.flags),
    severity: p.severity as Severity | 'low',
    contextRequired: p.contextRequired ?? false,
  }));

  return compiledPatterns;
}

function getLineAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = text.indexOf('\n', index);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
}

/**
 * Run all regex patterns against the input text.
 * Returns findings with source: 'regex'.
 */
export function detectRegex(text: string): { findings: Finding[]; timeMs: number } {
  const t0 = performance.now();
  const patterns = getPatterns();
  const findings: Finding[] = [];

  for (const pattern of patterns) {
    // Reset lastIndex for global regexes
    pattern.regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const value = match[0];
      const startIndex = match.index;
      const endIndex = startIndex + value.length;

      // Context check — skip if required keywords aren't nearby
      if (pattern.contextRequired) {
        const windowStart = Math.max(0, startIndex - 80);
        const windowEnd = Math.min(text.length, endIndex + 80);
        const context = text.slice(windowStart, windowEnd);
        const contextRegex = CONTEXT_BY_PATTERN[pattern.name] ?? POSTCODE_CONTEXT;
        if (!contextRegex.test(context)) {
          const hasTableContext =
            pattern.name === 'ID_NIK' &&
            ID_NIK_TABLE_CONTEXT.test(text) &&
            ID_NIK_FLATTENED_ROW_CONTEXT.test(text.slice(Math.max(0, startIndex - 60), startIndex)) &&
            ID_NIK_FLATTENED_NEXT_COLUMN.test(text.slice(endIndex, endIndex + 20));
          if (!hasTableContext) continue;
        }
      }

      // Luhn validation for credit cards
      if (pattern.name === 'CREDIT_CARD' && !luhnCheck(value)) continue;

      // Skip bank account pattern if it overlaps with IC number format
      if (pattern.name === 'BANK_ACCT' && /^\d{6}-\d{2}-\d{4}$/.test(value)) continue;
      if (pattern.name === 'BANK_ACCT' && CREDIT_CARD_SHAPE.test(value) && luhnCheck(value)) continue;
      if (pattern.name === 'TAX_ID' && OCR_PHONE_SHAPE.test(value)) continue;
      if (
        (pattern.name === 'MY_POSTCODE' || pattern.name === 'SG_POSTCODE' || pattern.name === 'PH_POSTCODE') &&
        /\+?(?:60|62)[.\s:-]?\d{2,4}[.\s:-]?\d{3,4}[.\s:-]?\d{3,5}/.test(getLineAt(text, startIndex))
      ) {
        continue;
      }

      findings.push({
        type: pattern.name,
        value,
        startIndex,
        endIndex,
        confidence: 1.0,
        severity: pattern.severity,
        source: 'regex',
      });
    }
  }

  const timeMs = Math.round(performance.now() - t0);
  return { findings, timeMs };
}
