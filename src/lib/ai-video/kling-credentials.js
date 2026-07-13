function trimEnv(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveKlingAccessKey(env = process.env) {
  return trimEnv(env.KLING_ACCESS_KEY);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function hasKlingCredentials(env = process.env) {
  return Boolean(resolveKlingAccessKey(env));
}

/**
 * @param {string} accessKey
 * @returns {string}
 */
export function buildKlingAuthorizationHeader(accessKey) {
  if (!accessKey) {
    throw new Error("Brak KLING_ACCESS_KEY");
  }
  return `Bearer ${accessKey}`;
}
