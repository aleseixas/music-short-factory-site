import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createConfig,
  parseEncryptionKey,
  REQUIRED_TIKTOK_SCOPES,
} from "../server/config.js";

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: "development",
    PUBLIC_ORIGIN: "http://localhost:3000",
    TIKTOK_REDIRECT_URI: "http://localhost:3000/auth/tiktok/callback",
    TIKTOK_CLIENT_KEY: "test-client-key",
    TIKTOK_CLIENT_SECRET: "test-client-secret",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ...overrides,
  };
}

test("configuration fixes the least-privilege TikTok scopes", () => {
  const config = createConfig(baseEnv(), process.cwd());
  assert.deepEqual(config.scopes, ["user.info.basic", "video.upload"]);
  assert.deepEqual(REQUIRED_TIKTOK_SCOPES, [
    "user.info.basic",
    "video.upload",
  ]);
  assert.equal(config.cookieName, "adh_session");
  assert.equal(config.cookieSecure, false);
});

test("production requires HTTPS and a same-origin callback", () => {
  const config = createConfig(
    baseEnv({
      NODE_ENV: "production",
      PUBLIC_ORIGIN: "https://creator.example",
      TIKTOK_REDIRECT_URI:
        "https://creator.example/auth/tiktok/callback",
    }),
    process.cwd(),
  );
  assert.equal(config.cookieName, "__Host-adh_session");
  assert.equal(config.cookieSecure, true);
  assert.equal(config.trustProxy, false);

  assert.throws(
    () =>
      createConfig(
        baseEnv({
          NODE_ENV: "production",
          PUBLIC_ORIGIN: "https://creator.example",
          TIKTOK_REDIRECT_URI:
            "https://different.example/auth/tiktok/callback",
        }),
      ),
    /must be exactly/,
  );

  assert.throws(
    () =>
      createConfig(
        baseEnv({ SESSION_COOKIE_NAME: "__Secure-test-session" }),
      ),
    /requires an HTTPS PUBLIC_ORIGIN/,
  );
});

test("encryption keys must decode to exactly 32 bytes", () => {
  const key = randomBytes(32);
  assert.deepEqual(parseEncryptionKey(key.toString("base64")), key);
  assert.deepEqual(parseEncryptionKey(key.toString("hex")), key);
  assert.throws(() => parseEncryptionKey("too-short"), /32 bytes/);
});
