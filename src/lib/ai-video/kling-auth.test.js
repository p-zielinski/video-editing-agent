import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKlingJwt } from "./kling-auth.js";

describe("createKlingJwt", () => {
  it("returns a three-part JWT", () => {
    const token = createKlingJwt("access-key", "secret-key");
    assert.equal(token.split(".").length, 3);
  });

  it("throws when credentials missing", () => {
    assert.throws(() => createKlingJwt("", "secret"), /KLING_ACCESS_KEY/);
  });
});
