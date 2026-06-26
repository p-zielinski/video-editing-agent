import { SAFE_ALLOWED_TECHNIQUE_IDS } from "./technique-budget.js";

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

/**
 * Skrócona tabela technik do wstrzyknięcia w prompt Directora.
 */
export function formatCatalogForPrompt(catalog, budget) {
  const level = budget?.level ?? "balanced";
  const filtered = filterTechniquesForLevel(catalog.techniques, level);

  const rows = filtered.map((t) => {
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
    const forbidden = (t.constraints?.forbiddenOnSegmentRole ?? []).join(",") || "—";

    return {
      id: t.id,
      category: t.category,
      label: t.label,
      whenToUse: t.whenToUse,
      params: formatParamSummary(t.params),
      gated: gated.length ? gated.join(", ") : null,
      forbiddenOn: forbidden,
      syncHints: (t.syncHints ?? []).slice(0, 3),
    };
  });

  return {
    catalogVersion: catalog.version,
    packId: catalog.packId,
    techniqueCount: rows.length,
    creativityLevel: level,
    techniques: rows,
    budget: budget
      ? {
          level: budget.level,
          allowMidSentenceCuts: budget.allowMidSentenceCuts,
          maxZoomMoments: budget.maxZoomMoments,
          minZoomGapSec: budget.minZoomGapSec,
          maxTotalZoomDutySec: Math.round(budget.maxTotalZoomDutySec * 10) / 10,
          maxTotalTechniqueMoments: budget.maxTotalTechniqueMoments,
        }
      : undefined,
  };
}
