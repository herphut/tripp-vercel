// src/lib/redact.ts
export function redactPII(text: string) {
  if (!text) return text;
  return text
    // emails
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    // phone numbers (naive)
    .replace(/\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]*)?\d{3}[-.\s]?\d{4}\b/g, "[phone]")
    // street-ish (very naive; tune later)
    .replace(/\b\d{1,5}\s+([A-Za-z0-9.'-]+\s){1,4}(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln)\b/gi, "[address]")
    // ssn
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]")
    // credit card-like
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, "[card]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[card]");

}
