# GenGuard - Privacy Risk Assessment for GenAI

Real-time PII detection and masking for ChatGPT and Google Gemini using **PaddleOCR** and **Piiranha NER model**.

## Architecture

```
┌─────────────────────┐         ┌─────────────────────────────┐
│  Chrome Extension   │  HTTP   │   Python Backend (Local)    │
│  (Lightweight JS)   │ ◄─────► │   http://localhost:5000     │
│                     │         │                             │
│  • Monitor input    │         │   • PaddleOCR (PP-OCRv4)    │
│  • Show warnings    │         │   • Piiranha PII Detection  │
│  • Auto-replace     │         │   • Risk Scoring            │
└─────────────────────┘         └─────────────────────────────┘
```

## Quick Start

### 1. Start Python Backend

```bash
cd genguard-backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

The API will be available at `http://localhost:5000`

### 2. Load Chrome Extension

1. Go to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `genguard-extension/` folder

### 3. Test It

1. Go to [gemini.google.com](https://gemini.google.com) or [chatgpt.com](https://chatgpt.com)
2. Type: `My IC is 990101-14-1234`
3. You should see a warning overlay!

## Features

- 🔍 **PaddleOCR** - Fast, accurate OCR for images
- 🧠 **Piiranha NER** - ML-based PII detection
- 📊 **Risk Scoring** - 0-100 scale with levels (Low/Medium/High/Critical)
- 🔒 **Auto-Replace** - One-click PII masking
- 📄 **File Support** - Images, PDFs, text files

## Detected PII Types

| Type | Sensitivity | Example |
|------|-------------|---------|
| Malaysian IC (NRIC) | Critical | 990101-14-1234 |
| SSN | Critical | 123-45-6789 |
| Credit Card | Critical | 4111-1111-1111-1111 |
| Email | Medium | user@example.com |
| Phone | Medium | +60123456789 |
| Names | Medium | John Smith |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/analyze/text` | POST | Analyze text for PII |
| `/analyze/image` | POST | OCR + PII detection |
| `/analyze/file` | POST | Upload file for analysis |
| `/replace` | POST | Replace PII in text |

## Project Structure

```
MINE/
├── genguard-backend/       # Python Backend
│   ├── main.py             # FastAPI app
│   ├── ocr.py              # PaddleOCR wrapper
│   ├── detector.py         # Piiranha + regex
│   ├── replacer.py         # PII masking
│   └── requirements.txt
│
└── genguard-extension/     # Chrome Extension
    ├── manifest.json
    └── src/
        ├── content/        # ChatGPT & Gemini scripts
        ├── popup/          # Extension popup
        └── background/     # Service worker
```

## Requirements

- Python 3.10+
- Chrome Browser
- 4GB+ RAM (for PaddleOCR + Piiranha models)
