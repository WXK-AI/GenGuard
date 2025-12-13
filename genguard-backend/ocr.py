"""
GenGuard Backend - OCR Module
Uses PaddleOCR (PP-OCRv4) for text extraction from images and PDFs.
"""

from paddleocr import PaddleOCR
from PIL import Image
import numpy as np
import base64
import io
import fitz  # PyMuPDF for PDF
from typing import Optional
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global OCR instance (lazy loaded)
_ocr_instance: Optional[PaddleOCR] = None


def get_ocr() -> PaddleOCR:
    """Get or create PaddleOCR instance (singleton pattern)."""
    global _ocr_instance
    if _ocr_instance is None:
        logger.info("Loading PaddleOCR model (PP-OCRv4)...")
        _ocr_instance = PaddleOCR(
            use_angle_cls=True,
            lang='en',
            use_gpu=False,  # Set to True if GPU available
            show_log=False
        )
        logger.info("PaddleOCR loaded successfully!")
    return _ocr_instance


def extract_text_from_image(image_data: bytes) -> str:
    """
    Extract text from image bytes using PaddleOCR.
    
    Args:
        image_data: Raw image bytes (jpg, png, etc.)
    
    Returns:
        Extracted text as a single string.
    """
    try:
        # Convert bytes to PIL Image
        image = Image.open(io.BytesIO(image_data))
        
        # Convert to RGB if necessary
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Convert to numpy array for PaddleOCR
        img_array = np.array(image)
        
        # Run OCR
        ocr = get_ocr()
        result = ocr.ocr(img_array, cls=True)
        
        # Extract text from result
        extracted_lines = []
        if result and result[0]:
            for line in result[0]:
                if line and len(line) >= 2:
                    text = line[1][0]  # Get the text part
                    extracted_lines.append(text)
        
        full_text = ' '.join(extracted_lines)
        logger.info(f"Extracted {len(full_text)} characters from image")
        return full_text
        
    except Exception as e:
        logger.error(f"OCR error: {e}")
        raise


def extract_text_from_base64(base64_string: str) -> str:
    """
    Extract text from base64-encoded image.
    
    Args:
        base64_string: Base64 encoded image (with or without data URL prefix)
    
    Returns:
        Extracted text.
    """
    # Remove data URL prefix if present
    if ',' in base64_string:
        base64_string = base64_string.split(',')[1]
    
    image_data = base64.b64decode(base64_string)
    return extract_text_from_image(image_data)


def extract_text_from_pdf(pdf_data: bytes) -> str:
    """
    Extract text from PDF using PyMuPDF + PaddleOCR for images.
    
    Args:
        pdf_data: Raw PDF bytes
    
    Returns:
        Extracted text from all pages.
    """
    try:
        doc = fitz.open(stream=pdf_data, filetype="pdf")
        all_text = []
        
        for page_num, page in enumerate(doc):
            # First try to extract text directly
            text = page.get_text()
            if text.strip():
                all_text.append(text)
            else:
                # If no text, render page to image and OCR
                logger.info(f"Page {page_num + 1}: No text layer, using OCR")
                pix = page.get_pixmap(dpi=150)
                img_data = pix.tobytes("png")
                ocr_text = extract_text_from_image(img_data)
                all_text.append(ocr_text)
        
        doc.close()
        full_text = '\n\n'.join(all_text)
        logger.info(f"Extracted {len(full_text)} characters from PDF ({len(doc)} pages)")
        return full_text
        
    except Exception as e:
        logger.error(f"PDF extraction error: {e}")
        raise


# Pre-load OCR model on import (optional, can be deferred)
def preload_ocr():
    """Pre-load OCR model for faster first request."""
    try:
        get_ocr()
    except Exception as e:
        logger.warning(f"Failed to preload OCR: {e}")
