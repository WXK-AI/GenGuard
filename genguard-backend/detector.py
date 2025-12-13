"""
GenGuard Backend - PII Detection Module
Uses Piiranha NER model + regex patterns for comprehensive PII detection.
"""

from transformers import pipeline, AutoTokenizer, AutoModelForTokenClassification
import regex as re
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, asdict
from enum import Enum
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class Sensitivity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class PIIEntity:
    """Detected PII entity."""
    type: str
    text: str
    start: int
    end: int
    sensitivity: Sensitivity
    source: str  # "ner" or "regex"
    replacement: str = ""
    
    def to_dict(self) -> dict:
        d = asdict(self)
        d['sensitivity'] = self.sensitivity.value
        return d


# Sensitivity weights for risk scoring
SENSITIVITY_WEIGHTS = {
    Sensitivity.LOW: 5,
    Sensitivity.MEDIUM: 15,
    Sensitivity.HIGH: 25,
    Sensitivity.CRITICAL: 40
}

# PII type to sensitivity mapping
PII_SENSITIVITY = {
    "PERSON": Sensitivity.MEDIUM,
    "EMAIL": Sensitivity.MEDIUM,
    "PHONE": Sensitivity.MEDIUM,
    "NRIC": Sensitivity.CRITICAL,
    "SSN": Sensitivity.CRITICAL,
    "CREDIT_CARD": Sensitivity.CRITICAL,
    "PASSPORT": Sensitivity.HIGH,
    "ADDRESS": Sensitivity.MEDIUM,
    "IP_ADDRESS": Sensitivity.LOW,
    "DATE_OF_BIRTH": Sensitivity.HIGH,
    "BANK_ACCOUNT": Sensitivity.HIGH,
    "ORG": Sensitivity.LOW,
    "LOCATION": Sensitivity.LOW,
}

# Regex patterns for structured PII
PII_PATTERNS = {
    "NRIC": {
        "pattern": r'\b\d{6}[-\s]?\d{2}[-\s]?\d{4}\b',
        "sensitivity": Sensitivity.CRITICAL,
        "description": "Malaysian IC Number"
    },
    "SSN": {
        "pattern": r'\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b',
        "sensitivity": Sensitivity.CRITICAL,
        "description": "US Social Security Number"
    },
    "EMAIL": {
        "pattern": r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b',
        "sensitivity": Sensitivity.MEDIUM,
        "description": "Email Address"
    },
    "PHONE": {
        "pattern": r'(?:\+?60[-\s]?)?(?:1\d[-\s]?\d{3,4}[-\s]?\d{4}|\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4})',
        "sensitivity": Sensitivity.MEDIUM,
        "description": "Phone Number (Malaysian)"
    },
    "PHONE_INTL": {
        "pattern": r'\+\d{1,3}[-\s]?\d{2,4}[-\s]?\d{3,4}[-\s]?\d{3,4}',
        "sensitivity": Sensitivity.MEDIUM,
        "description": "International Phone Number"
    },
    "CREDIT_CARD": {
        "pattern": r'\b(?:4\d{3}|5[1-5]\d{2}|6011|3[47]\d{2})[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b',
        "sensitivity": Sensitivity.CRITICAL,
        "description": "Credit Card Number"
    },
    "PASSPORT_MY": {
        "pattern": r'\b[A-Z]{1,2}\d{7,8}\b',
        "sensitivity": Sensitivity.HIGH,
        "description": "Passport Number"
    },
    "IP_ADDRESS": {
        "pattern": r'\b(?:\d{1,3}\.){3}\d{1,3}\b',
        "sensitivity": Sensitivity.LOW,
        "description": "IP Address"
    },
    "DATE_OF_BIRTH": {
        "pattern": r'\b(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})\b',
        "sensitivity": Sensitivity.HIGH,
        "description": "Date of Birth"
    },
    "BANK_ACCOUNT": {
        "pattern": r'\b\d{10,16}\b',
        "sensitivity": Sensitivity.HIGH,
        "description": "Bank Account Number",
        "context_required": True  # Only match if context suggests bank account
    }
}

# Global NER pipeline (lazy loaded)
_ner_pipeline = None


def get_ner_pipeline():
    """Get or create NER pipeline using fast DistilBERT model."""
    global _ner_pipeline
    if _ner_pipeline is None:
        logger.info("Loading DistilBERT NER model (fast, ~66M params)...")
        try:
            # Use fast DistilBERT NER model (~250MB vs 1.1GB for Piiranha)
            _ner_pipeline = pipeline(
                "ner",
                model="dslim/distilbert-NER",
                aggregation_strategy="simple"
            )
            logger.info("DistilBERT NER model loaded successfully!")
        except Exception as e:
            logger.warning(f"Failed to load DistilBERT NER: {e}")
            _ner_pipeline = None
    return _ner_pipeline


def detect_with_ner(text: str) -> List[PIIEntity]:
    """Detect PII using Piiranha NER model."""
    entities = []
    
    try:
        ner = get_ner_pipeline()
        results = ner(text)
        
        for result in results:
            entity_type = result['entity_group'].upper()
            
            # Map Piiranha labels to our types
            type_mapping = {
                'PER': 'PERSON',
                'PERSON': 'PERSON',
                'ORG': 'ORG',
                'ORGANIZATION': 'ORG',
                'LOC': 'LOCATION',
                'LOCATION': 'LOCATION',
                'EMAIL': 'EMAIL',
                'PHONE': 'PHONE',
                'SSN': 'SSN',
                'CREDIT_CARD': 'CREDIT_CARD',
            }
            
            mapped_type = type_mapping.get(entity_type, entity_type)
            sensitivity = PII_SENSITIVITY.get(mapped_type, Sensitivity.MEDIUM)
            
            entity = PIIEntity(
                type=mapped_type,
                text=result['word'],
                start=result['start'],
                end=result['end'],
                sensitivity=sensitivity,
                source="ner"
            )
            entities.append(entity)
            
    except Exception as e:
        logger.error(f"NER detection error: {e}")
    
    return entities


def detect_with_regex(text: str) -> List[PIIEntity]:
    """Detect PII using regex patterns."""
    entities = []
    
    for pii_type, config in PII_PATTERNS.items():
        pattern = config['pattern']
        sensitivity = config['sensitivity']
        
        # Skip context-required patterns for now (e.g., bank accounts)
        if config.get('context_required'):
            continue
        
        for match in re.finditer(pattern, text, re.IGNORECASE):
            # Validate specific patterns
            matched_text = match.group()
            
            # Luhn check for credit cards
            if pii_type == 'CREDIT_CARD':
                if not _validate_luhn(re.sub(r'[\s-]', '', matched_text)):
                    continue
            
            entity = PIIEntity(
                type=pii_type,
                text=matched_text,
                start=match.start(),
                end=match.end(),
                sensitivity=sensitivity,
                source="regex"
            )
            entities.append(entity)
    
    return entities


def _validate_luhn(number: str) -> bool:
    """Validate credit card number using Luhn algorithm."""
    try:
        digits = [int(d) for d in number if d.isdigit()]
        if len(digits) < 13:
            return False
        
        checksum = 0
        for i, digit in enumerate(reversed(digits)):
            if i % 2 == 1:
                digit *= 2
                if digit > 9:
                    digit -= 9
            checksum += digit
        
        return checksum % 10 == 0
    except:
        return False


def _deduplicate_entities(entities: List[PIIEntity]) -> List[PIIEntity]:
    """Remove duplicate/overlapping entities, preferring higher sensitivity."""
    if not entities:
        return []
    
    # Sort by start position, then by sensitivity (higher first)
    sorted_entities = sorted(
        entities,
        key=lambda e: (e.start, -SENSITIVITY_WEIGHTS[e.sensitivity])
    )
    
    result = []
    for entity in sorted_entities:
        # Check if this entity overlaps with any in result
        is_duplicate = False
        for existing in result:
            if (entity.start < existing.end and entity.end > existing.start):
                # Overlap detected - keep higher sensitivity one
                if SENSITIVITY_WEIGHTS[entity.sensitivity] > SENSITIVITY_WEIGHTS[existing.sensitivity]:
                    result.remove(existing)
                    result.append(entity)
                is_duplicate = True
                break
        
        if not is_duplicate:
            result.append(entity)
    
    return sorted(result, key=lambda e: e.start)


def calculate_risk_score(entities: List[PIIEntity]) -> Tuple[int, str]:
    """
    Calculate overall risk score from detected entities.
    
    Returns:
        Tuple of (score 0-100, risk level string)
    """
    if not entities:
        return 0, "none"
    
    total_weight = sum(SENSITIVITY_WEIGHTS[e.sensitivity] for e in entities)
    
    # Normalize to 0-100 scale (cap at 100)
    score = min(100, total_weight)
    
    # Determine risk level
    if score >= 70:
        level = "critical"
    elif score >= 50:
        level = "high"
    elif score >= 25:
        level = "medium"
    else:
        level = "low"
    
    return score, level


def detect_pii(text: str) -> Dict:
    """
    Main PII detection function combining NER and regex.
    
    Args:
        text: Input text to analyze
    
    Returns:
        Dict with entities, risk score, and risk level
    """
    if not text or not text.strip():
        return {
            "entities": [],
            "riskScore": 0,
            "riskLevel": "none"
        }
    
    # Run both detection methods
    ner_entities = detect_with_ner(text)
    regex_entities = detect_with_regex(text)
    
    # Combine and deduplicate
    all_entities = ner_entities + regex_entities
    unique_entities = _deduplicate_entities(all_entities)
    
    # Calculate risk
    risk_score, risk_level = calculate_risk_score(unique_entities)
    
    # Generate replacements
    for entity in unique_entities:
        entity.replacement = _generate_replacement(entity.type, entity.text)
    
    logger.info(f"Detected {len(unique_entities)} PII entities, risk: {risk_level} ({risk_score})")
    
    return {
        "entities": [e.to_dict() for e in unique_entities],
        "riskScore": risk_score,
        "riskLevel": risk_level
    }


def _generate_replacement(pii_type: str, text: str) -> str:
    """Generate replacement text for a PII entity."""
    replacements = {
        "PERSON": "[NAME]",
        "EMAIL": "[EMAIL]",
        "PHONE": "[PHONE]",
        "PHONE_INTL": "[PHONE]",
        "NRIC": "[NRIC]",
        "SSN": "[SSN]",
        "CREDIT_CARD": "[CARD]",
        "PASSPORT_MY": "[PASSPORT]",
        "IP_ADDRESS": "[IP]",
        "DATE_OF_BIRTH": "[DOB]",
        "BANK_ACCOUNT": "[ACCOUNT]",
        "ADDRESS": "[ADDRESS]",
        "LOCATION": "[LOCATION]",
        "ORG": "[ORG]",
    }
    return replacements.get(pii_type, f"[{pii_type}]")


# Pre-load model on import
def preload_ner():
    """Pre-load NER model for faster first request."""
    try:
        get_ner_pipeline()
    except Exception as e:
        logger.warning(f"Failed to preload NER: {e}")
