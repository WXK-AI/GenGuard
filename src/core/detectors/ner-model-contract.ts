export const NER_MODEL_CONTRACT = {
  // Model hosted on HuggingFace — downloaded to IndexedDB on first use
  hfRepoId: 'XkAI/piiranha-asean-unified-v2-onnx',
  hfFilename: 'onnx/model_quantized.onnx',
  tokenizerFilename: 'tokenizer.json',
  configFilename: 'config.json',

  maxSeqLen: 256,
  architecture: 'deberta-v3',

  // EXACT order from config.json id2label
  labelList: [
    'O',
    'B-PERSON',       'I-PERSON',
    'B-ORGANISATION', 'I-ORGANISATION',
    'B-LOCATION',     'I-LOCATION',
    'B-ADDR',         'I-ADDR',
  ] as const,

  // Input tensor shapes — int64, dynamic batch + seq
  // Note: model_quantized.onnx only accepts input_ids + attention_mask (no token_type_ids)
  inputs: {
    input_ids:      { dtype: 'int64' as const, shape: [1, 256] as const },
    attention_mask: { dtype: 'int64' as const, shape: [1, 256] as const },
  },
  outputs: {
    logits: { dtype: 'float32' as const, shape: [1, 256, 9] as const },
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
    PERSON:       'medium',
    ORGANISATION: 'low',
    LOCATION:     'low',
    ADDR:         'high',
  } as const,
} as const;

export type NERLabel = typeof NER_MODEL_CONTRACT.labelList[number];
export type NEREntityType = keyof typeof NER_MODEL_CONTRACT.severityMap;
export type Severity = 'critical' | 'high' | 'medium' | 'low';
