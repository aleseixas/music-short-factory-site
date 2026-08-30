import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SESSION_BYTES = 32;
const CSRF_BYTES = 32;
const STATE_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export function randomOpaque(bytes) {
  return randomBytes(bytes).toString("base64url");
}

export function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeHashMatch(expectedHex, value) {
  if (!expectedHex || !value) return false;
  const actual = Buffer.from(hash(value), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encryptToken(token, key) {
  if (typeof token !== "string" || !token) {
    throw new TypeError("A non-empty token is required");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError("AES-256-GCM requires a 32-byte key");
  }

  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptToken(payload, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError("AES-256-GCM requires a 32-byte key");
  }

  const [version, ivPart, tagPart, ciphertextPart, extra] = String(
    payload,
  ).split(".");
  if (version !== "v1" || !ivPart || !tagPart || !ciphertextPart || extra) {
    throw new Error("Invalid encrypted token format");
  }

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new Error("Invalid encrypted token parameters");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Encrypted token authentication failed");
  }
}

export function parseScopes(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function storedInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid stored integer: ${name}`);
  }
  return parsed;
}

export function serializePublish(row) {
  if (!row) return null;
  return {
    publishId: row.publish_id,
    mode: row.publish_mode === "direct" ? "direct" : "draft",
    status: row.status,
    uploadedBytes: storedInteger(row.uploaded_bytes ?? 0, "uploaded_bytes"),
    failReason: row.fail_reason || null,
    createdAt: storedInteger(row.created_at, "created_at"),
    updatedAt: storedInteger(row.updated_at, "updated_at"),
  };
}

export function createStore({
  databasePath,
  encryptionKey,
  sessionTtlMs,
  now = () => Date.now(),
}) {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  if (databasePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      oauth_state_hash TEXT,
      oauth_state_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS connections (
      session_hash TEXT PRIMARY KEY
        REFERENCES sessions(session_hash) ON DELETE CASCADE ON UPDATE CASCADE,
      open_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      scopes_json TEXT NOT NULL,
      access_token_ciphertext TEXT NOT NULL,
      refresh_token_ciphertext TEXT NOT NULL,
      access_expires_at INTEGER NOT NULL,
      refresh_expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS publishes (
      publish_id TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL
        REFERENCES sessions(session_hash) ON DELETE CASCADE ON UPDATE CASCADE,
      status TEXT NOT NULL,
      publish_mode TEXT NOT NULL DEFAULT 'draft',
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      fail_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS publishes_session_updated
      ON publishes(session_hash, updated_at DESC);
  `);

  const publishColumns = db.prepare("PRAGMA table_info(publishes)").all();
  if (!publishColumns.some((column) => column.name === "publish_mode")) {
    db.exec(
      "ALTER TABLE publishes ADD COLUMN publish_mode TEXT NOT NULL DEFAULT 'draft';",
    );
  }

  const statements = {
    ping: db.prepare("SELECT 1 AS value"),
    insertSession: db.prepare(`
      INSERT INTO sessions
        (session_hash, csrf_token, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `),
    getSession: db.prepare(`
      SELECT s.session_hash, s.csrf_token, s.created_at, s.expires_at,
             c.open_id, c.display_name, c.avatar_url, c.scopes_json,
             c.access_expires_at, c.refresh_expires_at
      FROM sessions s
      LEFT JOIN connections c ON c.session_hash = s.session_hash
      WHERE s.session_hash = ? AND s.expires_at > ?
    `),
    deleteSession: db.prepare("DELETE FROM sessions WHERE session_hash = ?"),
    cleanupSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    setOAuthState: db.prepare(`
      UPDATE sessions
      SET oauth_state_hash = ?, oauth_state_expires_at = ?
      WHERE session_hash = ? AND expires_at > ?
    `),
    consumeOAuthState: db.prepare(`
      UPDATE sessions
      SET oauth_state_hash = NULL, oauth_state_expires_at = NULL
      WHERE session_hash = ?
        AND oauth_state_hash = ?
        AND oauth_state_expires_at >= ?
        AND expires_at > ?
    `),
    rotateSession: db.prepare(`
      UPDATE sessions
      SET session_hash = ?, csrf_token = ?, oauth_state_hash = NULL,
          oauth_state_expires_at = NULL, expires_at = ?
      WHERE session_hash = ? AND expires_at > ?
    `),
    upsertConnection: db.prepare(`
      INSERT INTO connections (
        session_hash, open_id, display_name, avatar_url, scopes_json,
        access_token_ciphertext, refresh_token_ciphertext,
        access_expires_at, refresh_expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_hash) DO UPDATE SET
        open_id = excluded.open_id,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        scopes_json = excluded.scopes_json,
        access_token_ciphertext = excluded.access_token_ciphertext,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        access_expires_at = excluded.access_expires_at,
        refresh_expires_at = excluded.refresh_expires_at,
        updated_at = excluded.updated_at
    `),
    getConnection: db.prepare(`
      SELECT c.*
      FROM connections c
      JOIN sessions s ON s.session_hash = c.session_hash
      WHERE c.session_hash = ? AND s.expires_at > ?
    `),
    updateTokens: db.prepare(`
      UPDATE connections
      SET open_id = ?, scopes_json = ?, access_token_ciphertext = ?,
          refresh_token_ciphertext = ?, access_expires_at = ?,
          refresh_expires_at = ?, updated_at = ?
      WHERE session_hash = ?
    `),
    deleteConnection: db.prepare("DELETE FROM connections WHERE session_hash = ?"),
    deletePublishes: db.prepare("DELETE FROM publishes WHERE session_hash = ?"),
    getOpenId: db.prepare(
      "SELECT open_id FROM connections WHERE session_hash = ?",
    ),
    deleteUserSessions: db.prepare(`
      DELETE FROM sessions
      WHERE session_hash IN (
        SELECT session_hash FROM connections WHERE open_id = ?
      )
    `),
    insertPublish: db.prepare(`
      INSERT INTO publishes
        (publish_id, session_hash, status, publish_mode, uploaded_bytes,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `),
    getPublish: db.prepare(`
      SELECT * FROM publishes WHERE publish_id = ? AND session_hash = ?
    `),
    getLastPublish: db.prepare(`
      SELECT * FROM publishes
      WHERE session_hash = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `),
    updatePublish: db.prepare(`
      UPDATE publishes
      SET status = ?, uploaded_bytes = ?, fail_reason = ?, updated_at = ?
      WHERE publish_id = ? AND session_hash = ?
    `),
  };

  function sessionHash(sessionId) {
    return typeof sessionId === "string" && sessionId ? hash(sessionId) : null;
  }

  function cleanupExpired() {
    return statements.cleanupSessions.run(now()).changes;
  }

  function createSession() {
    cleanupExpired();
    const sessionId = randomOpaque(SESSION_BYTES);
    const csrfToken = randomOpaque(CSRF_BYTES);
    const createdAt = now();
    const expiresAt = createdAt + sessionTtlMs;
    statements.insertSession.run(hash(sessionId), csrfToken, createdAt, expiresAt);
    return { sessionId, csrfToken, expiresAt };
  }

  function getSession(sessionId) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    const row = statements.getSession.get(key, now());
    if (!row) return null;
    const lastPublish = serializePublish(statements.getLastPublish.get(key));
    return {
      sessionId,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      connected: Boolean(row.open_id),
      profile: row.open_id
        ? {
            openId: row.open_id,
            displayName: row.display_name,
            avatarUrl: row.avatar_url || null,
          }
        : null,
      scopes: parseScopes(row.scopes_json),
      lastPublish,
    };
  }

  function validateCsrf(sessionId, csrfToken) {
    const session = getSession(sessionId);
    if (!session || typeof csrfToken !== "string") return false;
    const expected = Buffer.from(session.csrfToken, "utf8");
    const actual = Buffer.from(csrfToken, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function createOAuthState(sessionId, ttlMs) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    const state = randomOpaque(STATE_BYTES);
    const currentTime = now();
    const result = statements.setOAuthState.run(
      hash(state),
      currentTime + ttlMs,
      key,
      currentTime,
    );
    return result.changes === 1 ? state : null;
  }

  function consumeOAuthState(sessionId, state) {
    const key = sessionHash(sessionId);
    if (!key || typeof state !== "string" || !state) return false;
    const currentTime = now();
    const result = statements.consumeOAuthState.run(
      key,
      hash(state),
      currentTime,
      currentTime,
    );
    return result.changes === 1;
  }

  function attachConnectionAndRotate(sessionId, connection) {
    const oldHash = sessionHash(sessionId);
    if (!oldHash) throw new Error("Session not found");
    const newSessionId = randomOpaque(SESSION_BYTES);
    const newCsrfToken = randomOpaque(CSRF_BYTES);
    const newHash = hash(newSessionId);
    const currentTime = now();
    const expiresAt = currentTime + sessionTtlMs;

    db.exec("BEGIN IMMEDIATE");
    try {
      const rotated = statements.rotateSession.run(
        newHash,
        newCsrfToken,
        expiresAt,
        oldHash,
        currentTime,
      );
      if (rotated.changes !== 1) throw new Error("Session not found or expired");

      statements.upsertConnection.run(
        newHash,
        connection.openId,
        connection.displayName,
        connection.avatarUrl || null,
        JSON.stringify(connection.scopes),
        encryptToken(connection.accessToken, encryptionKey),
        encryptToken(connection.refreshToken, encryptionKey),
        connection.accessExpiresAt,
        connection.refreshExpiresAt,
        currentTime,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return { sessionId: newSessionId, csrfToken: newCsrfToken, expiresAt };
  }

  function getConnection(sessionId) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    const row = statements.getConnection.get(key, now());
    if (!row) return null;
    return {
      openId: row.open_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url || null,
      scopes: parseScopes(row.scopes_json),
      accessToken: decryptToken(row.access_token_ciphertext, encryptionKey),
      refreshToken: decryptToken(row.refresh_token_ciphertext, encryptionKey),
      accessExpiresAt: row.access_expires_at,
      refreshExpiresAt: row.refresh_expires_at,
    };
  }

  function updateTokens(sessionId, tokens) {
    const key = sessionHash(sessionId);
    if (!key) return false;
    const result = statements.updateTokens.run(
      tokens.openId,
      JSON.stringify(tokens.scopes),
      encryptToken(tokens.accessToken, encryptionKey),
      encryptToken(tokens.refreshToken, encryptionKey),
      tokens.accessExpiresAt,
      tokens.refreshExpiresAt,
      now(),
      key,
    );
    return result.changes === 1;
  }

  function disconnect(sessionId) {
    const key = sessionHash(sessionId);
    if (!key) return false;
    db.exec("BEGIN IMMEDIATE");
    try {
      statements.deletePublishes.run(key);
      const result = statements.deleteConnection.run(key);
      db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function deleteSession(sessionId) {
    const key = sessionHash(sessionId);
    return key ? statements.deleteSession.run(key).changes === 1 : false;
  }

  function deleteUserData(sessionId) {
    const key = sessionHash(sessionId);
    if (!key) return false;
    const connection = statements.getOpenId.get(key);
    if (!connection) return statements.deleteSession.run(key).changes === 1;
    return statements.deleteUserSessions.run(connection.open_id).changes > 0;
  }

  function recordPublish(
    sessionId,
    publishId,
    status = "PROCESSING_UPLOAD",
    mode = "draft",
  ) {
    const key = sessionHash(sessionId);
    if (!key) throw new Error("Session not found");
    const currentTime = now();
    statements.insertPublish.run(
      publishId,
      key,
      status,
      mode === "direct" ? "direct" : "draft",
      currentTime,
      currentTime,
    );
    return getPublish(sessionId, publishId);
  }

  function getPublish(sessionId, publishId) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    return serializePublish(statements.getPublish.get(publishId, key));
  }

  function updatePublish(sessionId, publishId, data) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    const result = statements.updatePublish.run(
      data.status,
      Number.isSafeInteger(data.uploadedBytes) ? data.uploadedBytes : 0,
      data.failReason || null,
      now(),
      publishId,
      key,
    );
    return result.changes === 1 ? getPublish(sessionId, publishId) : null;
  }

  return Object.freeze({
    ping: () => Boolean(statements.ping.get()?.value),
    cleanupExpired,
    createSession,
    getSession,
    validateCsrf,
    createOAuthState,
    consumeOAuthState,
    attachConnectionAndRotate,
    getConnection,
    updateTokens,
    disconnect,
    deleteSession,
    deleteUserData,
    recordPublish,
    getPublish,
    updatePublish,
    close: () => db.close(),
  });
}
