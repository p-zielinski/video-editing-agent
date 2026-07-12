import { findRecipeBrandSafetyViolations } from "../editorial/brand-safety-enrich.js";

export function validateBrandSafetyText(recipe) {
  return findRecipeBrandSafetyViolations(recipe).map((violation) => ({
    severity: "error",
    code: "V27-SAFETY-01",
    message: `${violation.path}: nieocenzurowany termin ${violation.safetyClass}`,
  }));
}
