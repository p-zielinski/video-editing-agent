/** Bump when analysis logic or upstream models change (invalidates global cache). */
export const PIPELINE_ANALYSIS_VERSION = "2";

export function getPipelineAnalysisVersion() {
  return PIPELINE_ANALYSIS_VERSION;
}
