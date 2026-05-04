import { describe, expect, it } from 'vitest';
import { NER_MODEL_CONTRACT } from '../../src/core/detectors/ner-model-contract';

describe('NER_MODEL_CONTRACT', () => {
  it('uses the ASEAN Piiranha v1 model label set', () => {
    expect(NER_MODEL_CONTRACT.labelList).toEqual([
      'O',
      'B-PERSON', 'I-PERSON',
      'B-ORGANISATION', 'I-ORGANISATION',
      'B-LOCATION', 'I-LOCATION',
      'B-ADDR', 'I-ADDR',
    ]);
  });

  it('expects ASEAN Piiranha v1 ONNX logits', () => {
    expect(NER_MODEL_CONTRACT.outputs.logits.shape).toEqual([1, 256, 9]);
  });

  it('maps severity for all ASEAN Piiranha v1 NER entity types', () => {
    expect(NER_MODEL_CONTRACT.severityMap).toEqual({
      PERSON: 'medium',
      ORGANISATION: 'low',
      LOCATION: 'low',
      ADDR: 'high',
    });
  });
});
