export const NER_MODEL_CONTRACT = {
  // Model hosted on HuggingFace — downloaded to IndexedDB on first use
  hfRepoId: 'XkAI/piiranha-malaysia-v4-fp32',
  hfFilename: 'model_quantized.onnx',
  tokenizerFilename: 'tokenizer.json',
  configFilename: 'config.json',

  maxSeqLen: 256,
  architecture: 'deberta-v3',

  // EXACT order from config.json id2label
  labelList: [
    'O',
    'B-IC_NUMBER', 'I-IC_NUMBER',
    'B-PASSPORT',  'I-PASSPORT',
    'B-PHONE',     'I-PHONE',
    'B-PERSON',    'I-PERSON',
    'B-ADDRESS',   'I-ADDRESS',
    'B-EMAIL',     'I-EMAIL',
    'B-BANK_ACCT', 'I-BANK_ACCT',
    'B-ORG',       'I-ORG',
  ] as const,

  // Input tensor shapes — int64, dynamic batch + seq
  // Note: model_quantized.onnx only accepts input_ids + attention_mask (no token_type_ids)
  inputs: {
    input_ids:      { dtype: 'int64' as const, shape: [1, 256] as const },
    attention_mask: { dtype: 'int64' as const, shape: [1, 256] as const },
  },
  outputs: {
    logits: { dtype: 'float32' as const, shape: [1, 256, 17] as const },
  },

  // DeBERTa-v3 special tokens
  specialTokens: {
    cls: '[CLS]',
    sep: '[SEP]',
    pad: '[PAD]',
    unk: '[UNK]',
    mask: '[MASK]',
  },

  // Severity mapping for scorer
  severityMap: {
    IC_NUMBER:  'critical',
    PASSPORT:   'critical',
    BANK_ACCT:  'critical',
    PHONE:      'high',
    EMAIL:      'high',
    ADDRESS:    'high',
    PERSON:     'medium',
    ORG:        'low',
  } as const,
} as const;

export type NERLabel = typeof NER_MODEL_CONTRACT.labelList[number];
export type NEREntityType = keyof typeof NER_MODEL_CONTRACT.severityMap;
export type Severity = typeof NER_MODEL_CONTRACT.severityMap[NEREntityType];
