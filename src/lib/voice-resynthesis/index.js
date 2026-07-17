/**
 * Voice re-synthesis providers — pointwise fragment repair (consent-gated).
 * Production default: stub only. OpenVoice integration is opt-in via env.
 */

export function resolveVoiceResynthesisConfig(env = process.env) {
  return {
    provider: env.VOICE_RESYNTHESIS_PROVIDER ?? "stub",
    enabled: env.VOICE_RESYNTHESIS_ENABLED === "1",
    maxChunkSec: Number(env.VOICE_RESYNTHESIS_MAX_CHUNK_SEC ?? 30),
    requireConsent: env.VOICE_RESYNTHESIS_REQUIRE_CONSENT !== "0",
  };
}

export function validateResynthesisMoment(moment, config = resolveVoiceResynthesisConfig()) {
  const issues = [];
  const duration = (moment.endSec ?? 0) - (moment.startSec ?? 0);

  if (duration <= 0) {
    issues.push("invalid_duration");
  }
  if (duration > config.maxChunkSec) {
    issues.push("chunk_too_long");
  }
  if (config.requireConsent && !moment.consentRequired) {
    issues.push("consent_required");
  }
  if (!moment.needsHumanReview) {
    issues.push("human_review_required");
  }

  return issues;
}

export async function runVoiceResynthesisStub({ inputPath, outputPath, moment }) {
  const { runFfmpeg } = await import("../ffmpeg.js");
  const start = Math.max(0, moment.startSec ?? 0);
  const end = moment.endSec ?? start + 1;

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-af",
    `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`,
    "-ar",
    "48000",
    "-ac",
    "1",
    outputPath,
  ], { label: "voice resynthesis stub (trim only)" });

  return {
    provider: "stub",
    status: "stubbed",
    provenance: "synthetic_fragment",
    warnings: ["stub_provider_no_resynthesis"],
  };
}

export async function runVoiceResynthesis({ inputPath, outputPath, moment, config }) {
  const resolved = config ?? resolveVoiceResynthesisConfig();
  if (!resolved.enabled || resolved.provider === "stub") {
    return runVoiceResynthesisStub({ inputPath, outputPath, moment });
  }

  const validationIssues = validateResynthesisMoment(moment, resolved);
  if (validationIssues.length > 0) {
    throw new Error(`Voice resynthesis validation failed: ${validationIssues.join(", ")}`);
  }

  throw new Error(`Voice resynthesis provider not implemented: ${resolved.provider}`);
}
