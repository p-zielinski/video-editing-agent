import { shouldApplyColorGrade } from "../render/color-grade.js";

export const COLOR_GRADE_POLICY_OFF = "off";
export const COLOR_GRADE_POLICY_ALLOW = "allow";
export const DEFAULT_COLOR_GRADE_POLICY = COLOR_GRADE_POLICY_OFF;

const DISABLE_REASON = "display_ready_phone_footage";

/**
 * Resolve effective color grade policy (env → batchContext → default off).
 */
export function resolveColorGradePolicy(batchContext = {}) {
  const envPolicy = process.env.COLOR_GRADE_POLICY;
  if (envPolicy === COLOR_GRADE_POLICY_ALLOW || envPolicy === COLOR_GRADE_POLICY_OFF) {
    return envPolicy;
  }
  return batchContext.colorGradePolicy ?? DEFAULT_COLOR_GRADE_POLICY;
}

export function isColorGradePolicyOff(batchContext = {}) {
  return resolveColorGradePolicy(batchContext) === COLOR_GRADE_POLICY_OFF;
}

/**
 * Whether renderer may run the color_grade pass.
 */
export function shouldAllowColorGrade(batchContext = {}, colorGrade = null) {
  if (isColorGradePolicyOff(batchContext)) {
    return false;
  }
  return shouldApplyColorGrade(colorGrade);
}

/**
 * Strip colorGrade from recipe when policy is off (deterministic safeguard).
 *
 * @returns {{ stripped: boolean, previous?: object }}
 */
export function enrichRecipeDisableColorGrade(recipe, batchContext = {}) {
  const effectiveContext = { ...batchContext, ...(recipe.batchContext ?? {}) };
  const policy = resolveColorGradePolicy(effectiveContext);

  recipe.batchContext = {
    ...(recipe.batchContext ?? {}),
    colorGradePolicy: policy,
  };

  if (policy === COLOR_GRADE_POLICY_ALLOW) {
    return { stripped: false };
  }

  const previous = recipe.colorGrade ?? null;
  if (previous != null) {
    delete recipe.colorGrade;
  }

  return {
    stripped: previous != null,
    previous,
    reason: DISABLE_REASON,
  };
}
