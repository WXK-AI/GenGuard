"""
GenGuard Backend - PII Replacer Module
Replaces detected PII with masked/placeholder text.
"""

from typing import List, Dict
from dataclasses import dataclass
from enum import Enum
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ReplacementMode(str, Enum):
    FULL = "full"           # [REDACTED]
    PARTIAL = "partial"     # ****1234
    PLACEHOLDER = "placeholder"  # [TYPE]


# Default replacement templates
REPLACEMENT_TEMPLATES = {
    "PERSON": {
        "full": "[REDACTED]",
        "partial": lambda t: t[0] + "***" if len(t) > 1 else "***",
        "placeholder": "[NAME]"
    },
    "EMAIL": {
        "full": "[REDACTED]",
        "partial": lambda t: t.split('@')[0][:2] + "***@" + t.split('@')[1] if '@' in t else "***@redacted.com",
        "placeholder": "[EMAIL]"
    },
    "PHONE": {
        "full": "[REDACTED]",
        "partial": lambda t: "***" + t[-4:] if len(t) >= 4 else "***",
        "placeholder": "[PHONE]"
    },
    "PHONE_INTL": {
        "full": "[REDACTED]",
        "partial": lambda t: t[:3] + "***" + t[-4:] if len(t) >= 7 else "***",
        "placeholder": "[PHONE]"
    },
    "NRIC": {
        "full": "[REDACTED]",
        "partial": lambda t: "******" + t[-4:] if len(t) >= 4 else "******",
        "placeholder": "[NRIC]"
    },
    "SSN": {
        "full": "[REDACTED]",
        "partial": lambda t: "***-**-" + t[-4:] if len(t) >= 4 else "***-**-****",
        "placeholder": "[SSN]"
    },
    "CREDIT_CARD": {
        "full": "[REDACTED]",
        "partial": lambda t: "****-****-****-" + t[-4:] if len(t) >= 4 else "****",
        "placeholder": "[CARD]"
    },
    "PASSPORT_MY": {
        "full": "[REDACTED]",
        "partial": lambda t: t[0] + "******" if len(t) > 1 else "******",
        "placeholder": "[PASSPORT]"
    },
    "IP_ADDRESS": {
        "full": "[REDACTED]",
        "partial": lambda t: "xxx.xxx.xxx." + t.split('.')[-1] if '.' in t else "xxx.xxx.xxx.xxx",
        "placeholder": "[IP]"
    },
    "DATE_OF_BIRTH": {
        "full": "[REDACTED]",
        "partial": lambda t: "**/**/****",
        "placeholder": "[DOB]"
    },
    "BANK_ACCOUNT": {
        "full": "[REDACTED]",
        "partial": lambda t: "******" + t[-4:] if len(t) >= 4 else "******",
        "placeholder": "[ACCOUNT]"
    },
    "ADDRESS": {
        "full": "[REDACTED]",
        "partial": lambda t: "[ADDRESS]",
        "placeholder": "[ADDRESS]"
    },
    "LOCATION": {
        "full": "[REDACTED]",
        "partial": lambda t: "[LOCATION]",
        "placeholder": "[LOCATION]"
    },
    "ORG": {
        "full": "[REDACTED]",
        "partial": lambda t: t[0] + "***" if len(t) > 1 else "***",
        "placeholder": "[ORG]"
    },
}

# Default template for unknown types
DEFAULT_TEMPLATE = {
    "full": "[REDACTED]",
    "partial": lambda t: "***",
    "placeholder": "[PII]"
}


def get_replacement(
    pii_type: str, 
    original_text: str, 
    mode: ReplacementMode = ReplacementMode.PLACEHOLDER
) -> str:
    """
    Get replacement text for a PII entity.
    
    Args:
        pii_type: Type of PII (e.g., "EMAIL", "NRIC")
        original_text: Original text to replace
        mode: Replacement mode
    
    Returns:
        Replacement text
    """
    template = REPLACEMENT_TEMPLATES.get(pii_type, DEFAULT_TEMPLATE)
    replacement_value = template.get(mode.value, template.get("placeholder"))
    
    if callable(replacement_value):
        return replacement_value(original_text)
    return replacement_value


def replace_pii_in_text(
    text: str, 
    entities: List[Dict], 
    mode: ReplacementMode = ReplacementMode.PLACEHOLDER
) -> Dict:
    """
    Replace all PII entities in text.
    
    Args:
        text: Original text
        entities: List of detected entities with start/end positions
        mode: Replacement mode
    
    Returns:
        Dict with replaced text and mapping of replacements
    """
    if not entities:
        return {
            "text": text,
            "replacements": [],
            "originalLength": len(text),
            "replacedLength": len(text)
        }
    
    # Sort entities by start position (reverse order for safe replacement)
    sorted_entities = sorted(entities, key=lambda e: e.get('start', 0), reverse=True)
    
    replaced_text = text
    replacements = []
    
    for entity in sorted_entities:
        start = entity.get('start', 0)
        end = entity.get('end', start)
        original = entity.get('text', '')
        pii_type = entity.get('type', 'PII')
        
        replacement = get_replacement(pii_type, original, mode)
        
        # Perform replacement
        replaced_text = replaced_text[:start] + replacement + replaced_text[end:]
        
        replacements.append({
            "type": pii_type,
            "original": original,
            "replacement": replacement,
            "start": start,
            "end": end
        })
    
    # Reverse to get chronological order
    replacements.reverse()
    
    logger.info(f"Replaced {len(replacements)} PII entities using '{mode.value}' mode")
    
    return {
        "text": replaced_text,
        "replacements": replacements,
        "originalLength": len(text),
        "replacedLength": len(replaced_text)
    }


def batch_replace(
    texts: List[str], 
    all_entities: List[List[Dict]], 
    mode: ReplacementMode = ReplacementMode.PLACEHOLDER
) -> List[Dict]:
    """
    Replace PII in multiple texts.
    
    Args:
        texts: List of texts
        all_entities: List of entity lists (one per text)
        mode: Replacement mode
    
    Returns:
        List of replacement results
    """
    results = []
    for text, entities in zip(texts, all_entities):
        result = replace_pii_in_text(text, entities, mode)
        results.append(result)
    return results
