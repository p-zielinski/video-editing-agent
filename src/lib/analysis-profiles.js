export const PROFILES = {
  preview: {
    visionStub: true,
    faceStub: true,
    audioStub: true,
    objectsStub: true,
    twelvelabsStub: true,
    globalCacheDisabled: false,
  },
  production: {
    visionStub: false,
    faceStub: false,
    audioStub: false,
    objectsStub: false,
    twelvelabsStub: false,
    globalCacheDisabled: false,
  },
  ci: {
    visionStub: true,
    faceStub: true,
    audioStub: true,
    objectsStub: true,
    twelvelabsStub: true,
    globalCacheDisabled: true,
  },
};

const PROFILE_FLAG_KEYS = [
  "visionStub",
  "faceStub",
  "audioStub",
  "objectsStub",
  "twelvelabsStub",
  "globalCacheDisabled",
];

/**
 * Merge analysis profile defaults with explicit CLI flags (explicit wins).
 *
 * @param {string|undefined} profileName
 * @param {Record<string, boolean|undefined>} explicitFlags
 */
export function resolveAnalysisProfile(profileName, explicitFlags = {}) {
  if (profileName && !PROFILES[profileName]) {
    throw new Error(
      `Nieznany profil analizy: ${profileName}. Dostępne: ${Object.keys(PROFILES).join(", ")}`,
    );
  }

  const base = profileName ? { ...PROFILES[profileName] } : {};
  const resolved = { ...base };

  for (const key of PROFILE_FLAG_KEYS) {
    if (explicitFlags[key] !== undefined) {
      resolved[key] = explicitFlags[key];
    }
  }

  return resolved;
}

export function listEnabledAnalysisStubs(flags) {
  const labels = {
    visionStub: "vision",
    faceStub: "face",
    audioStub: "audio",
    objectsStub: "objects",
    twelvelabsStub: "twelvelabs",
  };
  return Object.entries(labels)
    .filter(([key]) => flags[key] === true)
    .map(([, label]) => label);
}
