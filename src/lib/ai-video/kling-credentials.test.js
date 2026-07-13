import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildKlingAuthorizationHeader,
  hasKlingCredentials,
  resolveKlingAccessKey,
} from "./kling-credentials.js";

const ACCESS_KEY = "api-key-kling-access-part-secret-part";

describe("resolveKlingAccessKey", () => {
  it("reads KLING_ACCESS_KEY from env", () => {
    assert.equal(resolveKlingAccessKey({ KLING_ACCESS_KEY: ACCESS_KEY }), ACCESS_KEY);
    assert.equal(hasKlingCredentials({ KLING_ACCESS_KEY: ACCESS_KEY }), true);
  });

  it("returns empty string when the key is missing", () => {
    assert.equal(resolveKlingAccessKey({}), "");
    assert.equal(hasKlingCredentials({}), false);
  });
});

describe("buildKlingAuthorizationHeader", () => {
  it("uses the access key directly as Bearer token", () => {
    assert.equal(
      buildKlingAuthorizationHeader(ACCESS_KEY),
      `Bearer ${ACCESS_KEY}`,
    );
  });

  it("throws when the access key is missing", () => {
    assert.throws(() => buildKlingAuthorizationHeader(""), /KLING_ACCESS_KEY/);
  });
});
