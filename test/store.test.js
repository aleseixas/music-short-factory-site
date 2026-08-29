import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createStore,
  decryptToken,
  encryptToken,
} from "../server/store.js";

test("AES-256-GCM encrypts tokens and rejects tampering", () => {
  const key = randomBytes(32);
  const plaintext = "act.test-secret-access-token";
  const ciphertext = encryptToken(plaintext, key);
  assert.doesNotMatch(ciphertext, /test-secret-access-token/);
  assert.equal(decryptToken(ciphertext, key), plaintext);

  const parts = ciphertext.split(".");
  const alteredBytes = Buffer.from(parts[3], "base64url");
  alteredBytes[0] ^= 1;
  parts[3] = alteredBytes.toString("base64url");
  const tampered = parts.join(".");
  assert.throws(() => decryptToken(tampered, key), /authentication failed/);
});

test("sessions use one-time OAuth state and rotate after authorization", () => {
  let currentTime = 1_800_000_000_000;
  const store = createStore({
    databasePath: ":memory:",
    encryptionKey: randomBytes(32),
    sessionTtlMs: 60_000,
    now: () => currentTime,
  });

  try {
    const anonymous = store.createSession();
    assert.equal(store.validateCsrf(anonymous.sessionId, anonymous.csrfToken), true);
    assert.equal(store.validateCsrf(anonymous.sessionId, "wrong-token"), false);

    const state = store.createOAuthState(anonymous.sessionId, 10_000);
    assert.equal(store.consumeOAuthState(anonymous.sessionId, state), true);
    assert.equal(store.consumeOAuthState(anonymous.sessionId, state), false);

    const connected = store.attachConnectionAndRotate(anonymous.sessionId, {
      openId: "open-id-1",
      displayName: "Test Creator",
      avatarUrl: "https://example.test/avatar.jpg",
      scopes: ["user.info.basic", "video.upload"],
      accessToken: "act.test-access",
      refreshToken: "rft.test-refresh",
      accessExpiresAt: currentTime + 20_000,
      refreshExpiresAt: currentTime + 50_000,
    });

    assert.equal(store.getSession(anonymous.sessionId), null);
    const session = store.getSession(connected.sessionId);
    assert.equal(session.connected, true);
    assert.equal(session.profile.displayName, "Test Creator");
    assert.deepEqual(session.scopes, ["user.info.basic", "video.upload"]);

    const connection = store.getConnection(connected.sessionId);
    assert.equal(connection.accessToken, "act.test-access");
    assert.equal(connection.refreshToken, "rft.test-refresh");

    const publish = store.recordPublish(
      connected.sessionId,
      "v_inbox_file~v2.test",
    );
    assert.equal(publish.status, "PROCESSING_UPLOAD");
    assert.equal(
      store.getSession(connected.sessionId).lastPublish.publishId,
      "v_inbox_file~v2.test",
    );

    currentTime += 61_000;
    assert.equal(store.getSession(connected.sessionId), null);
    store.cleanupExpired();
    assert.equal(store.getConnection(connected.sessionId), null);
  } finally {
    store.close();
  }
});
