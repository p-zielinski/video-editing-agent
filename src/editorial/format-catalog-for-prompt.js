import { SAFE_ALLOWED_TECHNIQUE_IDS } from "./technique-budget.js";
import { getTechniqueRenderSupport } from "../render/render-capabilities.js";
import { DIRECTOR_BRIEF_CAPS } from "./brief-caps.js";

function formatParamSummary(params = {}) {
  const parts = [];
  for (const [key, def] of Object.entries(params)) {
    const bits = [key];
    if (def.type) {
      bits.push(def.type);
    }
    if (def.min != null || def.max != null) {
      bits.push(`${def.min ?? "—"}…${def.max ?? "—"}`);
    }
    if (def.default != null) {
      bits.push(`def=${JSON.stringify(def.default)}`);
    }
    if (def.values?.length) {
      bits.push(`[${def.values.join("|")}]`);
    }
    parts.push(bits.join(":"));
  }
  return parts.length ? parts.join("; ") : null;
}

function filterTechniquesForLevel(techniques, level) {
  if (level !== "safe") {
    return techniques;
  }
  return techniques.filter((t) => SAFE_ALLOWED_TECHNIQUE_IDS.has(t.id));
}

function collectGated(t) {
  const gated = [];
  if (t.constraints?.requiresCreativityLevel) {
    gated.push(`level≥${t.constraints.requiresCreativityLevel}`);
  }
  if (t.constraints?.allowMidSentenceCuts) {
    gated.push("allowMidSentenceCuts");
  }
  if (t.constraints?.requiresSpatialAnchor) {
    gated.push("spatialRef");
  }
  return gated;
}

function buildBudgetSummary(budget) {
  if (!budget) {
    return undefined;
  }
  return {
    level: budget.level,
    allowMidSentenceCuts: budget.allowMidSentenceCuts,
    maxZoomMoments: budget.maxZoomMoments,
    minZoomGapSec: budget.minZoomGapSec,
    maxTotalZoomDutySec: Math.round(budget.maxTotalZoomDutySec * 10) / 10,
    maxTotalTechniqueMoments: budget.maxTotalTechniqueMoments,
  };
}

function buildFullTechniqueRows(filtered) {
  return filtered.map((t) => {
    const gated = collectGated(t);
    const forbidden = (t.constraints?.forbiddenOnSegmentRole ?? []).join(",") || "—";
    const renderSupport = t.renderSupport ?? getTechniqueRenderSupport(t.id);
    const row = {
      id: t.id,
      category: t.category,
      label: t.label,
      whenToUse: t.whenToUse,
      params: formatParamSummary(t.params),
      gated: gated.length ? gated.join(", ") : null,
      forbiddenOn: forbidden,
      syncHints: (t.syncHints ?? []).slice(0, 3),
      ...(t.narrativeFunctions?.length
        ? { narrativeFunctions: t.narrativeFunctions.slice(0, 4) }
        : {}),
      ...(t.visualIntensity ? { visualIntensity: t.visualIntensity } : {}),
    };
    if (renderSupport === "stub" || renderSupport === "partial") {
      row.renderSupport = renderSupport;
    }
    return row;
  });
}

function buildCompactTechniqueRows(filtered) {
  return filtered.map((t) => {
    const gated = collectGated(t);
    const forbidden = (t.constraints?.forbiddenOnSegmentRole ?? []).join(",") || "—";
    const renderSupport = t.renderSupport ?? getTechniqueRenderSupport(t.id);
    const row = {
      id: t.id,
      category: t.category,
      label: t.label,
      gated: gated.length ? gated.join(", ") : null,
      forbiddenOn: forbidden,
    };
    if (renderSupport === "stub" || renderSupport === "partial") {
      row.renderSupport = renderSupport;
    }
    return row;
  });
}

/**
 * Id-list catalog for drill-down / ultra-slim prompts (no whenToUse/params echo).
 */
export function formatCatalogIdListForPrompt(catalog, budget) {
  const level = budget?.level ?? "balanced";
  const filtered = filterTechniquesForLevel(catalog.techniques, level);
  return {
    catalogVersion: catalog.version,
    packId: catalog.packId,
    techniqueCount: filtered.length,
    creativityLevel: level,
    compact: true,
    techniqueIds: filtered.map((t) => t.id),
    constraintsNote: "Use only listed technique ids; respect creativityBudget and forbiddenOn from prior draft",
    budget: buildBudgetSummary(budget),
  };
}

/**
 * Skrócona tabela technik do wstrzyknięcia w prompt Directora.
 * When JSON exceeds maxChars, drops whenToUse/params/syncHints into compact rows.
 *
 * @param {object} catalog
 * @param {object} [budget]
 * @param {{ maxChars?: number }} [options] — default Infinity (full table); director passes TECHNIQUE_CATALOG_MAX_CHARS
 */
export function formatCatalogForPrompt(catalog, budget, options = {}) {
  const level = budget?.level ?? "balanced";
  const filtered = filterTechniquesForLevel(catalog.techniques, level);
  const maxChars = options.maxChars ?? Infinity;

  const full = {
    catalogVersion: catalog.version,
    packId: catalog.packId,
    techniqueCount: filtered.length,
    creativityLevel: level,
    techniques: buildFullTechniqueRows(filtered),
    budget: buildBudgetSummary(budget),
  };

  if (maxChars === Infinity || JSON.stringify(full).length <= maxChars) {
    return full;
  }

  const compact = {
    catalogVersion: catalog.version,
    packId: catalog.packId,
    techniqueCount: filtered.length,
    creativityLevel: level,
    compact: true,
    techniques: buildCompactTechniqueRows(filtered),
    budget: buildBudgetSummary(budget),
  };

  if (JSON.stringify(compact).length <= maxChars) {
    return compact;
  }

  // Last resort: id list only (always under TECHNIQUE_CATALOG_MAX_CHARS for current packs).
  return formatCatalogIdListForPrompt(catalog, budget);
}

/** @deprecated use options.maxChars — kept for callers that pass budget-only */
export function formatCatalogForPromptWithBudget(catalog, budget) {
  return formatCatalogForPrompt(catalog, budget, {
    maxChars: DIRECTOR_BRIEF_CAPS.TECHNIQUE_CATALOG_MAX_CHARS,
  });
}
