import crypto from "node:crypto";

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64url");
}

/**
 * HS256 JWT for Kling API (valid ~30 minutes).
 * @param {string} accessKey
 * @param {string} secretKey
 * @returns {string}
 */
export function createKlingJwt(accessKey, secretKey) {
  if (!accessKey || !secretKey) {
    throw new Error("Kling API wymaga KLING_ACCESS_KEY i KLING_SECRET_KEY");
  }

  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: accessKey,
    exp: now + 1800,
    nbf: now - 5,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
