import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  enrichRecipeDisableColorGrade,
  isColorGradePolicyOff,
  resolveColorGradePolicy,
  shouldAllowColorGrade,
} from "./color-grade-policy.js";

describe("color-grade-policy", () => {
  let previousEnv;

  beforeEach(() => {
    previousEnv = process.env.COLOR_GRADE_POLICY;
    delete process.env.COLOR_GRADE_POLICY;
  });

  afterEach(() => {
    if (previousEnv == null) {
      delete process.env.COLOR_GRADE_POLICY;
    } else {
      process.env.COLOR_GRADE_POLICY = previousEnv;
    }
  });

  it("defaults to off when batchContext omits policy", () => {
    assert.equal(resolveColorGradePolicy({}), "off");
    assert.equal(isColorGradePolicyOff({}), true);
  });

  it("respects batchContext allow policy", () => {
    assert.equal(resolveColorGradePolicy({ colorGradePolicy: "allow" }), "allow");
    assert.equal(isColorGradePolicyOff({ colorGradePolicy: "allow" }), false);
  });

  it("env COLOR_GRADE_POLICY overrides batchContext", () => {
    process.env.COLOR_GRADE_POLICY = "allow";
    assert.equal(resolveColorGradePolicy({ colorGradePolicy: "off" }), "allow");
  });

  it("shouldAllowColorGrade blocks when policy is off", () => {
    assert.equal(
      shouldAllowColorGrade({}, { lutId: "warm_golden_hour" }),
      false,
    );
  });

  it("shouldAllowColorGrade allows LUT when policy is allow", () => {
    assert.equal(
      shouldAllowColorGrade(
        { colorGradePolicy: "allow" },
        { lutId: "neutral_vlog" },
      ),
      true,
    );
  });

  it("enrichRecipeDisableColorGrade strips colorGrade by default", () => {
    const recipe = {
      batchContext: { requiredFormats: ["16:9"] },
      colorGrade: { lutId: "warm_golden_hour", exposure: 0.02 },
    };

    const result = enrichRecipeDisableColorGrade(recipe);
    assert.equal(result.stripped, true);
    assert.equal(recipe.colorGrade, undefined);
    assert.equal(recipe.batchContext.colorGradePolicy, "off");
  });

  it("enrichRecipeDisableColorGrade preserves colorGrade when policy is allow", () => {
    const recipe = {
      batchContext: { colorGradePolicy: "allow" },
      colorGrade: { lutId: "warm_golden_hour" },
    };

    const result = enrichRecipeDisableColorGrade(recipe);
    assert.equal(result.stripped, false);
    assert.equal(recipe.colorGrade.lutId, "warm_golden_hour");
  });
});
