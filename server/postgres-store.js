import { timingSafeEqual } from "node:crypto";
import pg from "pg";
import {
  decryptToken,
  encryptToken,
  hash,
  parseScopes,
  randomOpaque,
  serializePublish,
} from "./store.js";

const { Pool } = pg;
const SESSION_BYTES = 32;
const CSRF_BYTES = 32;
const STATE_BYTES = 32;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    oauth_state_hash TEXT,
    oauth_state_expires_at BIGINT,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS connections (
    session_hash TEXT PRIMARY KEY
      REFERENCES sessions(session_hash) ON DELETE CASCADE ON UPDATE CASCADE,
    open_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    scopes_json TEXT NOT NULL,
    access_token_ciphertext TEXT NOT NULL,
    refresh_token_ciphertext TEXT NOT NULL,
    access_expires_at BIGINT NOT NULL,
    refresh_expires_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS publishes (
    publish_id TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL
      REFERENCES sessions(session_hash) ON DELETE CASCADE ON UPDATE CASCADE,
    status TEXT NOT NULL,
    publish_mode TEXT NOT NULL DEFAULT 'draft',
    uploaded_bytes BIGINT NOT NULL DEFAULT 0,
    fail_reason TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS publishes_session_updated
    ON publishes(session_hash, updated_at DESC);

  ALTER TABLE publishes
    ADD COLUMN IF NOT EXISTS publish_mode TEXT NOT NULL DEFAULT 'draft';
`;

function storedInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid stored integer: ${name}`);
  }
  return parsed;
}

function sessionHash(sessionId) {
  return typeof sessionId === "string" && sessionId ? hash(sessionId) : null;
}

function serializeConnection(row, encryptionKey) {
  if (!row) return null;
  return {
    openId: row.open_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || null,
    scopes: parseScopes(row.scopes_json),
    accessToken: decryptToken(row.access_token_ciphertext, encryptionKey),
    refreshToken: decryptToken(row.refresh_token_ciphertext, encryptionKey),
    accessExpiresAt: storedInteger(
      row.access_expires_at,
      "access_expires_at",
    ),
    refreshExpiresAt: storedInteger(
      row.refresh_expires_at,
      "refresh_expires_at",
    ),
  };
}

export async function createPostgresStore({
  databaseUrl,
  encryptionKey,
  sessionTtlMs,
  now = () => Date.now(),
}) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
  });

  pool.on("error", (error) => {
    console.error(
      "Unexpected PostgreSQL pool error",
      error?.code || error?.name || "Error",
    );
  });

  try {
    await pool.query(SCHEMA_SQL);
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }

  async function ping() {
    await pool.query({ text: "SELECT 1", query_timeout: 5_000 });
    return true;
  }

  async function cleanupExpired() {
    const result = await pool.query(
      "DELETE FROM sessions WHERE expires_at <= $1",
      [now()],
    );
    return result.rowCount;
  }

  async function createSession() {
    await cleanupExpired();
    const sessionId = randomOpaque(SESSION_BYTES);
    const csrfToken = randomOpaque(CSRF_BYTES);
    const createdAt = now();
    const expiresAt = createdAt + sessionTtlMs;
    await pool.query(
      `INSERT INTO sessions
         (session_hash, csrf_token, created_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [hash(sessionId), csrfToken, createdAt, expiresAt],
    );
    return { sessionId, csrfToken, expiresAt };
  }

  async function getSession(sessionId) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    const currentTime = now();
    const result = await pool.query(
      `SELECT s.csrf_token, s.expires_at,
              c.open_id, c.display_name, c.avatar_url, c.scopes_json
       FROM sessions s
       LEFT JOIN connections c ON c.session_hash = s.session_hash
       WHERE s.session_hash = $1 AND s.expires_at > $2`,
      [key, currentTime],
    );
    const row = result.rows[0];
    if (!row) return null;

    const publishResult = await pool.query(
      `SELECT * FROM publishes
       WHERE session_hash = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [key],
    );
    return {
      sessionId,
      csrfToken: row.csrf_token,
      expiresAt: storedInteger(row.expires_at, "expires_at"),
      connected: Boolean(row.open_id),
      profile: row.open_id
        ? {
            openId: row.open_id,
            displayName: row.display_name,
            avatarUrl: row.avatar_url || null,
          }
        : null,
      scopes: parseScopes(row.scopes_json),
      lastPublish: serializePublish(publishResult.rows[0]),
    };
  }

  async function validateCsrf(sessionId, csrfToken) {
    const session = await getSession(sessionId);
    if (!session || typeof csrfToken !== "string") return false;
    const expected = Buffer.from(session.csrfToken, "utf8");
    const actual = Buffer.from(csrfToken, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async function createOAuthState(sessionId, ttlMs) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    const state = randomOpaque(STATE_BYTES);
    const currentTime = now();
    const result = await pool.query(
      `UPDATE sessions
       SET oauth_state_hash = $1, oauth_state_expires_at = $2
       WHERE session_hash = $3 AND expires_at > $4
       RETURNING session_hash`,
      [hash(state), currentTime + ttlMs, key, currentTime],
    );
    return result.rowCount === 1 ? state : null;
  }

  async function consumeOAuthState(sessionId, state) {
    const key = sessionHash(sessionId);
    if (!key || typeof state !== "string" || !state) return false;
    const currentTime = now();
    const result = await pool.query(
      `UPDATE sessions
       SET oauth_state_hash = NULL, oauth_state_expires_at = NULL
       WHERE session_hash = $1
         AND oauth_state_hash = $2
         AND oauth_state_expires_at >= $3
         AND expires_at > $4
       RETURNING session_hash`,
      [key, hash(state), currentTime, currentTime],
    );
    return result.rowCount === 1;
  }

  async function attachConnectionAndRotate(sessionId, connection) {
    const oldHash = sessionHash(sessionId);
    if (!oldHash) throw new Error("Session not found");

    const newSessionId = randomOpaque(SESSION_BYTES);
    const newCsrfToken = randomOpaque(CSRF_BYTES);
    const newHash = hash(newSessionId);
    const currentTime = now();
    const expiresAt = currentTime + sessionTtlMs;
    const accessTokenCiphertext = encryptToken(
      connection.accessToken,
      encryptionKey,
    );
    const refreshTokenCiphertext = encryptToken(
      connection.refreshToken,
      encryptionKey,
    );
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const rotated = await client.query(
        `UPDATE sessions
         SET session_hash = $1, csrf_token = $2, oauth_state_hash = NULL,
             oauth_state_expires_at = NULL, expires_at = $3
         WHERE session_hash = $4 AND expires_at > $5
         RETURNING session_hash`,
        [newHash, newCsrfToken, expiresAt, oldHash, currentTime],
      );
      if (rotated.rowCount !== 1) {
        throw new Error("Session not found or expired");
      }

      await client.query(
        `INSERT INTO connections (
           session_hash, open_id, display_name, avatar_url, scopes_json,
           access_token_ciphertext, refresh_token_ciphertext,
           access_expires_at, refresh_expires_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (session_hash) DO UPDATE SET
           open_id = EXCLUDED.open_id,
           display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url,
           scopes_json = EXCLUDED.scopes_json,
           access_token_ciphertext = EXCLUDED.access_token_ciphertext,
           refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
           access_expires_at = EXCLUDED.access_expires_at,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           updated_at = EXCLUDED.updated_at`,
        [
          newHash,
          connection.openId,
          connection.displayName,
          connection.avatarUrl || null,
          JSON.stringify(connection.scopes),
          accessTokenCiphertext,
          refreshTokenCiphertext,
          connection.accessExpiresAt,
          connection.refreshExpiresAt,
          currentTime,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return { sessionId: newSessionId, csrfToken: newCsrfToken, expiresAt };
  }

  async function getConnection(sessionId) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    const result = await pool.query(
      `SELECT c.*
       FROM connections c
       JOIN sessions s ON s.session_hash = c.session_hash
       WHERE c.session_hash = $1 AND s.expires_at > $2`,
      [key, now()],
    );
    return serializeConnection(result.rows[0], encryptionKey);
  }

  async function updateTokens(sessionId, tokens) {
    const key = sessionHash(sessionId);
    if (!key) return false;
    const result = await pool.query(
      `UPDATE connections
       SET open_id = $1, scopes_json = $2, access_token_ciphertext = $3,
           refresh_token_ciphertext = $4, access_expires_at = $5,
           refresh_expires_at = $6, updated_at = $7
       WHERE session_hash = $8`,
      [
        tokens.openId,
        JSON.stringify(tokens.scopes),
        encryptToken(tokens.accessToken, encryptionKey),
        encryptToken(tokens.refreshToken, encryptionKey),
        tokens.accessExpiresAt,
        tokens.refreshExpiresAt,
        now(),
        key,
      ],
    );
    return result.rowCount === 1;
  }

  async function disconnect(sessionId) {
    const key = sessionHash(sessionId);
    if (!key) return false;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM publishes WHERE session_hash = $1", [key]);
      const result = await client.query(
        "DELETE FROM connections WHERE session_hash = $1 RETURNING session_hash",
        [key],
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function deleteSession(sessionId) {
    const key = sessionHash(sessionId);
    if (!key) return false;
    const result = await pool.query(
      "DELETE FROM sessions WHERE session_hash = $1 RETURNING session_hash",
      [key],
    );
    return result.rowCount === 1;
  }

  async function deleteUserData(sessionId) {
    const key = sessionHash(sessionId);
    if (!key) return false;
    const result = await pool.query(
      `WITH target_open_id AS (
         SELECT open_id FROM connections WHERE session_hash = $1
       )
       DELETE FROM sessions
       WHERE session_hash = $1
          OR session_hash IN (
            SELECT c.session_hash
            FROM connections c
            JOIN target_open_id t ON t.open_id = c.open_id
          )
       RETURNING session_hash`,
      [key],
    );
    return result.rowCount > 0;
  }

  async function recordPublish(
    sessionId,
    publishId,
    status = "PROCESSING_UPLOAD",
    mode = "draft",
  ) {
    const key = sessionHash(sessionId);
    if (!key) throw new Error("Session not found");
    const currentTime = now();
    const result = await pool.query(
      `INSERT INTO publishes
         (publish_id, session_hash, status, publish_mode, uploaded_bytes,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6)
       RETURNING *`,
      [
        publishId,
        key,
        status,
        mode === "direct" ? "direct" : "draft",
        currentTime,
        currentTime,
      ],
    );
    return serializePublish(result.rows[0]);
  }

  async function getPublish(sessionId, publishId) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    const result = await pool.query(
      `SELECT * FROM publishes
       WHERE publish_id = $1 AND session_hash = $2`,
      [publishId, key],
    );
    return serializePublish(result.rows[0]);
  }

  async function updatePublish(sessionId, publishId, data) {
    const key = sessionHash(sessionId);
    if (!key) return null;
    const result = await pool.query(
      `UPDATE publishes
       SET status = $1, uploaded_bytes = $2, fail_reason = $3, updated_at = $4
       WHERE publish_id = $5 AND session_hash = $6
       RETURNING *`,
      [
        data.status,
        Number.isSafeInteger(data.uploadedBytes) ? data.uploadedBytes : 0,
        data.failReason || null,
        now(),
        publishId,
        key,
      ],
    );
    return serializePublish(result.rows[0]);
  }

  return Object.freeze({
    ping,
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
    close: () => pool.end(),
  });
}
