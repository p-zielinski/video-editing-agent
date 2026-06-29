export const DEFAULT_REQUIRED_FORMATS = ["16:9", "9:16"];
const VALID_FORMATS = new Set(["16:9", "9:16"]);

export function normalizeRequiredFormats(formats) {
  if (!Array.isArray(formats)) {
    return [];
  }
  return [...new Set(formats.filter((format) => VALID_FORMATS.has(format)))];
}

/**
 * Resolve effective output formats from CLI, batchContext, and L3 recommendation.
 *
 * Priority: explicit CLI/context override > L3 recommendedFormats > CLI defaults.
 */
export function resolveEffectiveRequiredFormats({
  cliFormats = DEFAULT_REQUIRED_FORMATS,
  cliExplicit = false,
  contextFormats,
  contextExplicit = false,
  l3RecommendedFormats,
  defaults = DEFAULT_REQUIRED_FORMATS,
} = {}) {
  if (cliExplicit || contextExplicit) {
    const explicit = contextExplicit ? contextFormats : cliFormats;
    const normalized = normalizeRequiredFormats(explicit);
    return normalized.length > 0 ? normalized : defaults;
  }

  const fromL3 = normalizeRequiredFormats(l3RecommendedFormats);
  if (fromL3.length > 0) {
    return fromL3;
  }

  const normalizedCli = normalizeRequiredFormats(cliFormats);
  return normalizedCli.length > 0 ? normalizedCli : defaults;
}

export function resolveFormatsSource({
  cliExplicit = false,
  contextExplicit = false,
  l3RecommendedFormats,
} = {}) {
  if (cliExplicit || contextExplicit) {
    return "explicit";
  }
  if (normalizeRequiredFormats(l3RecommendedFormats).length > 0) {
    return "l3";
  }
  return "default";
}
