import { resolve } from "node:path";

export const REQUIRED_TIKTOK_SCOPES = Object.freeze([
  "user.info.basic",
  "video.upload",
  "video.publish",
]);

const MAX_TIKTOK_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function integer(env, name, fallback, { min, max }) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(env, name, fallback) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes"].includes(raw)) return true;
  if (["0", "false", "no"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function absoluteHttpUrl(value, name, { httpsRequired = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP URL`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} cannot contain URL credentials`);
  }
  if (httpsRequired && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return url;
}

function optionalPostgresUrl(env) {
  const value = env.DATABASE_URL?.trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === "/"
  ) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  return value;
}

export function parseEncryptionKey(value) {
  const raw = value.trim();
  let key;

  if (/^[a-f\d]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }

  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function createConfig(env = process.env, cwd = process.cwd()) {
  const nodeEnv = env.NODE_ENV?.trim() || "development";
  const isProduction = nodeEnv === "production";
  const databaseUrl = optionalPostgresUrl(env);
  if (isProduction && !databaseUrl) {
    throw new Error("DATABASE_URL is required in production");
  }
  if (
    isProduction &&
    new URL(databaseUrl).searchParams.get("sslmode") !== "require"
  ) {
    throw new Error("DATABASE_URL must set sslmode=require in production");
  }
  const publicOriginUrl = absoluteHttpUrl(
    required(env, "PUBLIC_ORIGIN"),
    "PUBLIC_ORIGIN",
    { httpsRequired: isProduction },
  );
  if (
    publicOriginUrl.pathname !== "/" ||
    publicOriginUrl.search ||
    publicOriginUrl.hash
  ) {
    throw new Error("PUBLIC_ORIGIN must contain only the scheme and host");
  }
  const redirectUrl = absoluteHttpUrl(
    required(env, "TIKTOK_REDIRECT_URI"),
    "TIKTOK_REDIRECT_URI",
    { httpsRequired: isProduction },
  );

  if (redirectUrl.search || redirectUrl.hash) {
    throw new Error("TIKTOK_REDIRECT_URI cannot contain a query string or fragment");
  }

  const expectedRedirectUri = new URL(
    "/auth/tiktok/callback",
    publicOriginUrl.origin,
  ).toString();
  if (redirectUrl.toString() !== expectedRedirectUri) {
    throw new Error(
      `TIKTOK_REDIRECT_URI must be exactly ${expectedRedirectUri}`,
    );
  }

  const cookieName =
    env.SESSION_COOKIE_NAME?.trim() ||
    (isProduction ? "__Host-adh_session" : "adh_session");
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName)) {
    throw new Error("SESSION_COOKIE_NAME contains invalid characters");
  }
  if (
    (cookieName.startsWith("__Host-") || cookieName.startsWith("__Secure-")) &&
    publicOriginUrl.protocol !== "https:"
  ) {
    throw new Error("A prefixed secure session cookie requires an HTTPS PUBLIC_ORIGIN");
  }

  return Object.freeze({
    nodeEnv,
    isProduction,
    port: integer(env, "PORT", 3000, { min: 1, max: 65535 }),
    publicOrigin: publicOriginUrl.origin,
    cookieSecure: publicOriginUrl.protocol === "https:",
    redirectUri: redirectUrl.toString(),
    clientKey: required(env, "TIKTOK_CLIENT_KEY"),
    clientSecret: required(env, "TIKTOK_CLIENT_SECRET"),
    encryptionKey: parseEncryptionKey(required(env, "TOKEN_ENCRYPTION_KEY")),
    cookieName,
    sessionTtlMs:
      integer(env, "SESSION_TTL_SECONDS", 7 * 24 * 60 * 60, {
        min: 300,
        max: 30 * 24 * 60 * 60,
      }) * 1000,
    oauthStateTtlMs:
      integer(env, "OAUTH_STATE_TTL_SECONDS", 10 * 60, {
        min: 60,
        max: 30 * 60,
      }) * 1000,
    databaseUrl,
    databasePath: resolve(cwd, env.DATABASE_PATH?.trim() || "./data/app.sqlite"),
    uploadDir: resolve(
      cwd,
      env.UPLOAD_DIR?.trim() ||
        (isProduction ? "/tmp/adh-uploads" : "./data/uploads"),
    ),
    maxUploadBytes: integer(env, "MAX_UPLOAD_BYTES", 512 * 1024 * 1024, {
      min: 1,
      max: MAX_TIKTOK_VIDEO_BYTES,
    }),
    trustProxy: boolean(env, "TRUST_PROXY", false),
    directPostAudited: boolean(env, "TIKTOK_DIRECT_POST_AUDITED", false),
    scopes: REQUIRED_TIKTOK_SCOPES,
  });
}
