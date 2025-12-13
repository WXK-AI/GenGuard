"""
GenGuard Backend - Main FastAPI Application
API for PII detection using PaddleOCR and Piiranha model.
"""

from fastapi import FastAPI, HTTPException, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import base64
import logging
import uvicorn

from detector import detect_pii, preload_ner
from ocr import extract_text_from_image, extract_text_from_base64, extract_text_from_pdf, preload_ocr
from replacer import replace_pii_in_text, ReplacementMode

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="GenGuard API",
    description="PII Detection API using PaddleOCR and Piiranha",
    version="1.0.0"
)

# Configure CORS for browser extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "chrome-extension://*",
        "http://localhost:*",
        "https://chatgpt.com",
        "https://chat.openai.com",
        "https://gemini.google.com",
        "*"  # Allow all origins for development
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================== Request/Response Models ====================

class TextAnalyzeRequest(BaseModel):
    text: str


class ImageAnalyzeRequest(BaseModel):
    image: str  # Base64 encoded image
    filename: Optional[str] = "image.png"


class ReplaceRequest(BaseModel):
    text: str
    entities: List[dict]
    mode: Optional[str] = "placeholder"  # full, partial, placeholder


class AnalyzeResponse(BaseModel):
    entities: List[dict]
    riskScore: int
    riskLevel: str
    text: Optional[str] = None  # For OCR, includes extracted text


class ReplaceResponse(BaseModel):
    text: str
    replacements: List[dict]
    originalLength: int
    replacedLength: int


class HealthResponse(BaseModel):
    status: str
    ocr_ready: bool
    ner_ready: bool


# ==================== API Endpoints ====================

@app.get("/", response_model=dict)
async def root():
    """Root endpoint with API info."""
    return {
        "name": "GenGuard API",
        "version": "1.0.0",
        "status": "running",
        "endpoints": [
            "GET /health",
            "POST /analyze/text",
            "POST /analyze/image",
            "POST /analyze/file",
            "POST /replace"
        ]
    }


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    ocr_ready = False
    ner_ready = False
    
    try:
        from ocr import _ocr_instance
        ocr_ready = _ocr_instance is not None
    except:
        pass
    
    try:
        from detector import _ner_pipeline
        ner_ready = _ner_pipeline is not None
    except:
        pass
    
    return HealthResponse(
        status="healthy",
        ocr_ready=ocr_ready,
        ner_ready=ner_ready
    )


@app.post("/analyze/text", response_model=AnalyzeResponse)
async def analyze_text(request: TextAnalyzeRequest):
    """
    Analyze plain text for PII.
    
    Args:
        request: Text to analyze
    
    Returns:
        Detected entities with risk score
    """
    try:
        logger.info(f"Analyzing text ({len(request.text)} chars)")
        result = detect_pii(request.text)
        return AnalyzeResponse(**result)
    except Exception as e:
        logger.error(f"Text analysis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze/image", response_model=AnalyzeResponse)
async def analyze_image(request: ImageAnalyzeRequest):
    """
    Run OCR on image and analyze for PII.
    
    Args:
        request: Base64 encoded image
    
    Returns:
        Detected entities with risk score and extracted text
    """
    try:
        logger.info(f"Analyzing image: {request.filename}")
        
        # Extract text using PaddleOCR
        extracted_text = extract_text_from_base64(request.image)
        
        if not extracted_text.strip():
            return AnalyzeResponse(
                entities=[],
                riskScore=0,
                riskLevel="none",
                text=""
            )
        
        # Detect PII in extracted text
        result = detect_pii(extracted_text)
        result['text'] = extracted_text
        
        return AnalyzeResponse(**result)
        
    except Exception as e:
        logger.error(f"Image analysis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze/file")
async def analyze_file(file: UploadFile = File(...)):
    """
    Analyze uploaded file for PII.
    Supports: .txt, .pdf, .jpg, .png
    
    Args:
        file: Uploaded file
    
    Returns:
        Detected entities with risk score
    """
    try:
        content = await file.read()
        filename = file.filename or "unknown"
        content_type = file.content_type or ""
        
        logger.info(f"Analyzing file: {filename} ({content_type})")
        
        extracted_text = ""
        
        # Handle different file types
        if content_type.startswith("text/") or filename.endswith(".txt"):
            extracted_text = content.decode('utf-8', errors='ignore')
            
        elif content_type == "application/pdf" or filename.endswith(".pdf"):
            extracted_text = extract_text_from_pdf(content)
            
        elif content_type.startswith("image/") or filename.endswith(('.jpg', '.jpeg', '.png')):
            extracted_text = extract_text_from_image(content)
            
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type: {content_type}"
            )
        
        if not extracted_text.strip():
            return {
                "entities": [],
                "riskScore": 0,
                "riskLevel": "none",
                "text": "",
                "filename": filename
            }
        
        # Detect PII
        result = detect_pii(extracted_text)
        result['text'] = extracted_text
        result['filename'] = filename
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"File analysis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/replace", response_model=ReplaceResponse)
async def replace_pii(request: ReplaceRequest):
    """
    Replace PII in text with masked values.
    
    Args:
        request: Text, entities, and replacement mode
    
    Returns:
        Replaced text with mapping
    """
    try:
        mode = ReplacementMode(request.mode) if request.mode else ReplacementMode.PLACEHOLDER
        
        result = replace_pii_in_text(
            text=request.text,
            entities=request.entities,
            mode=mode
        )
        
        return ReplaceResponse(**result)
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid mode: {request.mode}")
    except Exception as e:
        logger.error(f"Replace error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== Startup Events ====================

@app.on_event("startup")
async def startup_event():
    """Pre-load models on startup for faster first request."""
    logger.info("GenGuard API starting...")
    logger.info("Pre-loading models (this may take a moment)...")
    
    # Pre-load OCR and NER models
    try:
        preload_ocr()
        logger.info("✓ PaddleOCR loaded")
    except Exception as e:
        logger.warning(f"OCR preload failed: {e}")
    
    try:
        preload_ner()
        logger.info("✓ Piiranha NER loaded")
    except Exception as e:
        logger.warning(f"NER preload failed: {e}")
    
    logger.info("=" * 50)
    logger.info("GenGuard API ready!")
    logger.info("Server: http://localhost:5000")
    logger.info("Docs:   http://localhost:5000/docs")
    logger.info("=" * 50)


# ==================== Main ====================

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=5000,
        reload=True,
        log_level="info"
    )
