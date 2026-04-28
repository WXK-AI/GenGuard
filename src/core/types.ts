import type { NEREntityType, Severity } from './detectors/ner-model-contract';

export interface Finding {
  type: NEREntityType | string;
  value: string;
  startIndex: number;
  endIndex: number;
  confidence: number;
  severity: Severity | 'low';
  source: 'ner' | 'regex' | 'ocr';
  /** Which input this finding came from (e.g. "Textbox", "report.pdf"). */
  inputSource?: string;
}

export interface SourceGroup {
  label: string;
  findings: Finding[];
  score: number;
  level: 'Safe' | 'Caution' | 'High' | 'Critical';
}

export interface RiskAssessment {
  score: number;
  level: 'Safe' | 'Caution' | 'High' | 'Critical';
  findings: Finding[];
  topRisks: Finding[];
  suggestions: string[];
  computeTimeMs: number;
  breakdown: {
    regexCount: number;
    nerCount: number;
    ocrCount: number;
  };
  /** Findings grouped by input source (textbox, each file). */
  sourceGroups: SourceGroup[];
}

export type ModelStatus = 'not_loaded' | 'downloading' | 'loading' | 'ready' | 'error';

export interface ModelStatusInfo {
  ner: ModelStatus;
  nerProgress?: number; // 0-100 download progress
  nerError?: string;
}

// Messages between service worker, content scripts, and side panel
export type MessageType =
  | { type: 'ASSESS_TEXT'; text: string }
  | { type: 'ASSESS_FILE'; file: ArrayBuffer; filename: string; mimeType: string }
  | { type: 'GET_HISTORY' }
  | { type: 'SET_SETTINGS'; settings: Partial<GenGuardSettings> }
  | { type: 'CLEAR_CACHE' }
  | { type: 'GET_MODEL_STATUS' }
  | { type: 'OPEN_SIDE_PANEL' }
  | { type: 'RISK_UPDATE'; assessment: RiskAssessment };

export interface GenGuardSettings {
  enabled: boolean;
  nerConfidenceThreshold: number;
  enableRegex: boolean;
  enableNer: boolean;
  enableOcr: boolean;
  inlineHighlight: {
    enabled: boolean;
    intensity: 'subtle' | 'normal' | 'bold';
    redactionMask: 'brackets' | 'asterisks' | 'redacted';
  };
}

export const DEFAULT_NER_CONFIDENCE_THRESHOLD = 0.35;

export const DEFAULT_SETTINGS: GenGuardSettings = {
  enabled: true,
  nerConfidenceThreshold: DEFAULT_NER_CONFIDENCE_THRESHOLD,
  enableRegex: true,
  enableNer: true,
  enableOcr: true,
  inlineHighlight: {
    enabled: true,
    intensity: 'normal',
    redactionMask: 'brackets',
  },
};
