/**
 * OCR Model Contract — PaddleOCR PP-OCRv5 ONNX exports.
 *
 * Source: monkt/paddleocr-onnx (HuggingFace public mirror)
 *   - detection/v5/det.onnx        — PP-OCRv5 text detection (DBNet)
 *   - languages/english/rec.onnx   — PP-OCRv5 English mobile recognition (SVTR/CRNN, height=32)
 *   - languages/english/dict.txt   — character dictionary (one char per line, UTF-8)
 *
 * Both models are downloaded once into IndexedDB and run via onnxruntime-web
 * inside the side panel page context (same constraints as the NER model).
 */

export const OCR_MODEL_CONTRACT = {
  hfRepoId: 'monkt/paddleocr-onnx',
  detFilename: 'detection/v5/det.onnx',
  recFilename: 'languages/english/rec.onnx',
  dictFilename: 'languages/english/dict.txt',

  // ── Detection (DB) ───────────────────────────────────────────────────────
  det: {
    // Resize image so longest side ≤ maxSide and both H, W are divisible by 32
    maxSide: 960,
    sizeMultiple: 32,
    // ImageNet normalization (standard for PP-OCR det)
    mean: [0.485, 0.456, 0.406] as const,
    std:  [0.229, 0.224, 0.225] as const,
    // DB postprocess thresholds
    binaryThreshold: 0.3,  // prob > this → "text" pixel
    boxThreshold:    0.5,  // average prob inside box must exceed this
    minBoxSize:      3,    // min width/height of a box (in detection-map pixels)
    // Expand each detected box outward by this fraction (helps capture descenders)
    unclipRatio:     1.3,
  },

  // ── Recognition (CRNN/SVTR) ──────────────────────────────────────────────
  rec: {
    // Fixed input height; width is dynamic but resized to keep aspect ratio
    inputHeight: 48,
    // Max width per crop. Long lines must NOT be squished — PaddleOCR's
    // recognition is highly sensitive to horizontal compression. Set this
    // generously; the batch is padded to its own max width regardless.
    maxWidth: 1600,
    // Normalization: (pixel/255 - 0.5) / 0.5  →  range [-1, 1]
    mean: [0.5, 0.5, 0.5] as const,
    std:  [0.5, 0.5, 0.5] as const,
    // CTC blank id (PaddleOCR convention: 0 is blank, dict starts at id 1)
    blankId: 0,
  },

  // Input/output tensor names (from PaddlePaddle → ONNX export)
  detIo: {
    inputName:  'x',
    outputName: 'sigmoid_0.tmp_0',
  },
  recIo: {
    inputName:  'x',
    outputName: 'softmax_5.tmp_0',
  },
} as const;

export type OcrContract = typeof OCR_MODEL_CONTRACT;
