import "dotenv/config";

import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import multer from "multer";
import { createConfig, REQUIRED_TIKTOK_SCOPES } from "./config.js";
import { createPostgresStore } from "./postgres-store.js";
import { createStore } from "./store.js";
import {
  buildAuthorizeUrl,
  createTikTokClient,
  hasRequiredScopes,
  TikTokApiError,
} from "./tiktok.js";
import {
  ALLOWED_VIDEO_MIME_TYPES,
  cleanupTemporaryDirectory,
  createUploadMiddleware,
  removeTemporaryFile,
  TikTokTransferError,
  uploadVideoFile,
} from "./upload.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SOURCE_DIR, "..");
const GITHUB_PAGES_BASE =
  "https://aleseixas.github.io/music-short-factory-site";
const ACCESS_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const MAX_TIKTOK_CAPTION_LENGTH = 2200;
const UNRESOLVED_TRANSFER_STATUSES = new Set([
  "UPLOADING",
  "TRANSFER_UNCONFIRMED",
  "PROCESSING_UPLOAD",
]);
const DIRECT_POST_LIMIT_CODES = new Set([
  "spam_risk_too_many_posts",
  "spam_risk_user_banned_from_posting",
  "reached_active_user_cap",
]);
const ROOT_FILE_ALLOWLIST = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/about.html", "about.html"],
  ["/app.html", "app.html"],
  ["/support.html", "support.html"],
  ["/privacy.html", "privacy.html"],
  ["/terms.html", "terms.html"],
  ["/data-deletion.html", "data-deletion.html"],
  ["/404.html", "404.html"],
  ["/styles.css", "styles.css"],
  ["/script.js", "script.js"],
  ["/app.js", "app.js"],
  ["/robots.txt", "robots.txt"],
  ["/sitemap.xml", "sitemap.xml"],
]);
const TEXT_REWRITE_EXTENSIONS = new Set([".html", ".txt", ".xml"]);
const ASSET_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".webp",
]);
const VERIFICATION_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.(?:html|txt)$/i;
const MAX_VERIFICATION_FILE_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function parseCookies(header = "") {
  const cookies = Object.create(null);
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      // Ignore malformed cookies rather than reflecting their value.
    }
  }
  return cookies;
}

function serializeSessionCookie(config, value, maxAgeSeconds) {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

function setSessionCookie(res, config, session) {
  const maxAge = Math.max(0, (session.expiresAt - Date.now()) / 1000);
  res.append(
    "Set-Cookie",
    serializeSessionCookie(config, session.sessionId, maxAge),
  );
}

function clearSessionCookie(res, config) {
  res.append("Set-Cookie", serializeSessionCookie(config, "", 0));
}

function scalarQuery(value) {
  return typeof value === "string" ? value : null;
}

function publicError(status, code, message) {
  return new HttpError(status, code, message);
}

function hasScopes(scopes, requiredScopes) {
  const granted = new Set(Array.isArray(scopes) ? scopes : []);
  return requiredScopes.every((scope) => granted.has(scope));
}

function bodyString(body, name) {
  const value = body?.[name];
  return typeof value === "string" ? value : null;
}

function bodyBoolean(body, name) {
  const value = bodyString(body, name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw publicError(400, "invalid_post_settings", "Invalid publishing settings.");
}

function directPostSettings(creatorInfo, audited) {
  const returnedOptions = creatorInfo.privacyLevelOptions;
  if (audited) {
    return {
      ...creatorInfo,
      privacyLevelOptions: returnedOptions,
      directPostAllowed: true,
      unaudited: false,
      restrictionReason: null,
    };
  }

  const privateAccount =
    returnedOptions.includes("FOLLOWER_OF_CREATOR") &&
    !returnedOptions.includes("PUBLIC_TO_EVERYONE");
  const supportsPrivateView = returnedOptions.includes("SELF_ONLY");
  const directPostAllowed = privateAccount && supportsPrivateView;
  return {
    ...creatorInfo,
    privacyLevelOptions: directPostAllowed
      ? returnedOptions.filter((option) => option === "SELF_ONLY")
      : [],
    directPostAllowed,
    unaudited: true,
    restrictionReason: directPostAllowed
      ? "This unaudited client can publish only to a private account with Only me visibility."
      : "TikTok requires a private target account while this Direct Post client is unaudited.",
  };
}

function errorResponse(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

function contentSecurityPolicy(config, nonce = null) {
  const scriptSource = nonce
    ? `script-src 'self' 'nonce-${nonce}'`
    : "script-src 'self'";
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https:",
    "media-src 'self' blob:",
    "object-src 'none'",
    scriptSource,
    "style-src 'self'",
  ];
  if (config.isProduction) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

function tokenTimes(tokens, currentTime = Date.now()) {
  const expiresIn = Number(tokens.expiresIn);
  const refreshExpiresIn = Number(tokens.refreshExpiresIn);
  if (
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    !Number.isFinite(refreshExpiresIn) ||
    refreshExpiresIn <= 0
  ) {
    throw new TikTokApiError("invalid_token_expiration", 502);
  }
  return {
    accessExpiresAt: currentTime + expiresIn * 1000,
    refreshExpiresAt: currentTime + refreshExpiresIn * 1000,
  };
}

async function getAssetAllowlist() {
  const assetDir = join(PROJECT_ROOT, "assets");
  try {
    const entries = await readdir(assetDir, { withFileTypes: true });
    return new Set(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            !entry.name.startsWith(".") &&
            ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase()),
        )
        .map((entry) => entry.name),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

async function getVerificationAllowlist() {
  const verificationDir = join(PROJECT_ROOT, "verification");
  try {
    const entries = await readdir(verificationDir, { withFileTypes: true });
    return new Set(
      entries
        .filter(
          (entry) =>
            entry.isFile() && VERIFICATION_FILENAME.test(entry.name),
        )
        .map((entry) => entry.name),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

export async function createApp({
  config,
  store,
  tiktokClient,
  fetchImpl = globalThis.fetch,
  uploadMiddleware = createUploadMiddleware(config),
}) {
  const app = express();
  const assetAllowlist = await getAssetAllowlist();
  const verificationAllowlist = await getVerificationAllowlist();
  const activeUploadSessions = new Set();

  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": contentSecurityPolicy(config),
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    if (config.isProduction) {
      res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  function sessionIdFromRequest(req) {
    return parseCookies(req.headers.cookie)[config.cookieName] || null;
  }

  async function requireSession(req, _res, next) {
    const sessionId = sessionIdFromRequest(req);
    const session = await store.getSession(sessionId);
    if (!session) {
      next(publicError(401, "session_required", "Start a new session and try again."));
      return;
    }
    req.appSessionId = sessionId;
    req.appSession = session;
    next();
  }

  async function requireCsrf(req, _res, next) {
    const csrfToken = req.get("X-CSRF-Token");
    if (!(await store.validateCsrf(req.appSessionId, csrfToken))) {
      next(publicError(403, "invalid_csrf", "The request could not be verified."));
      return;
    }
    next();
  }

  function requireConnection(req, _res, next) {
    if (!req.appSession.connected) {
      next(publicError(401, "tiktok_not_connected", "Connect a TikTok account first."));
      return;
    }
    next();
  }

  function reserveUpload(req, res, next) {
    const unresolvedPreviousTransfer = UNRESOLVED_TRANSFER_STATUSES.has(
      req.appSession.lastPublish?.status,
    );
    if (
      unresolvedPreviousTransfer ||
      activeUploadSessions.has(req.appSessionId)
    ) {
      next(
        publicError(
          409,
          "upload_in_progress",
          "Check the current transfer status before starting another upload.",
        ),
      );
      return;
    }
    activeUploadSessions.add(req.appSessionId);
    const release = () => activeUploadSessions.delete(req.appSessionId);
    res.once("finish", release);
    res.once("close", release);
    next();
  }

  async function validAccessToken(sessionId, requiredScopes = []) {
    const connection = await store.getConnection(sessionId);
    if (!connection) {
      throw publicError(401, "tiktok_not_connected", "Connect a TikTok account first.");
    }
    if (!hasScopes(connection.scopes, requiredScopes)) {
      throw publicError(
        401,
        "tiktok_reauthorization_required",
        "Reconnect TikTok to authorize the required publishing permission.",
      );
    }
    const currentTime = Date.now();
    if (connection.accessExpiresAt > currentTime + ACCESS_REFRESH_WINDOW_MS) {
      return connection.accessToken;
    }
    if (connection.refreshExpiresAt <= currentTime) {
      throw publicError(
        401,
        "tiktok_reauthorization_required",
        "TikTok authorization expired. Connect the account again.",
      );
    }

    const refreshed = await tiktokClient.refreshAccessToken(
      connection.refreshToken,
    );
    if (
      refreshed.openId !== connection.openId ||
      !hasScopes(refreshed.scopes, requiredScopes)
    ) {
      throw publicError(
        401,
        "tiktok_reauthorization_required",
        "TikTok permissions changed. Connect the account again.",
      );
    }
    const times = tokenTimes(refreshed, currentTime);
    await store.updateTokens(sessionId, {
      openId: refreshed.openId,
      scopes: refreshed.scopes,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      ...times,
    });
    return refreshed.accessToken;
  }

  async function tryRevokeConnection(sessionId, connection) {
    if (!connection) return true;
    try {
      let accessToken = connection.accessToken;
      if (connection.accessExpiresAt <= Date.now()) {
        if (connection.refreshExpiresAt <= Date.now()) return false;
        accessToken = await validAccessToken(sessionId);
      }
      await tiktokClient.revokeAccess(accessToken);
      return true;
    } catch {
      return false;
    }
  }

  app.get("/api/health", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await store.ping();
      res.json({ status: "ok", database: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable", database: "unavailable" });
    }
  });

  app.get("/api/session", async (req, res) => {
    res.set("Cache-Control", "no-store");
    let session = await store.getSession(sessionIdFromRequest(req));
    if (!session) {
      const created = await store.createSession();
      setSessionCookie(res, config, created);
      session = await store.getSession(created.sessionId);
    }

    res.json({
      configured: true,
      authenticated: session.connected,
      connected: session.connected,
      csrfToken: session.csrfToken,
      profile: session.profile
        ? {
            displayName: session.profile.displayName,
            avatarUrl: session.profile.avatarUrl,
          }
        : null,
      scopes: session.scopes,
      limits: {
        maxUploadBytes: config.maxUploadBytes,
        allowedMimeTypes: ALLOWED_VIDEO_MIME_TYPES,
      },
      lastPublish: session.lastPublish,
    });
  });

  app.get("/auth/tiktok", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      let sessionId = sessionIdFromRequest(req);
      let session = await store.getSession(sessionId);
      if (!session) {
        const created = await store.createSession();
        sessionId = created.sessionId;
        session = await store.getSession(sessionId);
        setSessionCookie(res, config, created);
      }
      const state = await store.createOAuthState(
        sessionId,
        config.oauthStateTtlMs,
      );
      if (!state) throw publicError(401, "session_expired", "Start again.");
      res.redirect(
        302,
        buildAuthorizeUrl({
          clientKey: config.clientKey,
          redirectUri: config.redirectUri,
          state,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth/tiktok/callback", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const sessionId = sessionIdFromRequest(req);
    const state = scalarQuery(req.query.state);
    const redirect = new URL("/app.html", config.publicOrigin);

    if (
      !sessionId ||
      !state ||
      !(await store.consumeOAuthState(sessionId, state))
    ) {
      redirect.searchParams.set("error", "invalid_oauth_state");
      res.redirect(303, redirect.toString());
      return;
    }

    if (scalarQuery(req.query.error)) {
      redirect.searchParams.set("error", "authorization_declined");
      res.redirect(303, redirect.toString());
      return;
    }

    const code = scalarQuery(req.query.code);
    if (!code || code.length > 2048) {
      redirect.searchParams.set("error", "authorization_code_missing");
      res.redirect(303, redirect.toString());
      return;
    }

    let tokens;
    try {
      tokens = await tiktokClient.exchangeCode(code);
      if (!hasRequiredScopes(tokens.scopes)) {
        await tiktokClient.revokeAccess(tokens.accessToken).catch(() => {});
        redirect.searchParams.set("error", "required_permissions_missing");
        res.redirect(303, redirect.toString());
        return;
      }
      const profile = await tiktokClient.getUserInfo(tokens.accessToken);
      if (profile.openId !== tokens.openId) {
        throw new TikTokApiError("user_identity_mismatch", 502);
      }
      const times = tokenTimes(tokens);
      const rotated = await store.attachConnectionAndRotate(sessionId, {
        ...profile,
        scopes: tokens.scopes,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        ...times,
      });
      setSessionCookie(res, config, rotated);
      redirect.searchParams.set("connected", "1");
      res.redirect(303, redirect.toString());
    } catch {
      if (tokens?.accessToken) {
        await tiktokClient.revokeAccess(tokens.accessToken).catch(() => {});
      }
      redirect.searchParams.set("error", "tiktok_connection_failed");
      res.redirect(303, redirect.toString());
    }
  });

  app.get(
    "/api/creator-info",
    requireSession,
    requireConnection,
    async (req, res, next) => {
      try {
        const accessToken = await validAccessToken(req.appSessionId, [
          "video.publish",
        ]);
        const creatorInfo = await tiktokClient.queryCreatorInfo(accessToken);
        res
          .set("Cache-Control", "no-store")
          .json({
            creatorInfo: directPostSettings(
              creatorInfo,
              config.directPostAudited,
            ),
          });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/upload",
    requireSession,
    requireCsrf,
    requireConnection,
    reserveUpload,
    (req, res, next) => {
      uploadMiddleware(req, res, (error) => (error ? next(error) : next()));
    },
    async (req, res, next) => {
      let publish = null;
      try {
        if (!req.file) {
          throw publicError(400, "video_required", "Choose a video to upload.");
        }
        const publishMode = bodyString(req.body, "publishMode") || "draft";
        if (!new Set(["draft", "direct"]).has(publishMode)) {
          throw publicError(400, "invalid_publish_mode", "Choose a publishing method.");
        }
        if (req.body.consentConfirmed !== "true") {
          throw publicError(
            400,
            "confirmation_required",
            "Review the video and confirm this action before continuing.",
          );
        }

        const accessToken = await validAccessToken(req.appSessionId, [
          publishMode === "direct" ? "video.publish" : "video.upload",
        ]);
        let initializeTransfer = null;

        if (publishMode === "direct") {
          const latestCreatorInfo = directPostSettings(
            await tiktokClient.queryCreatorInfo(accessToken),
            config.directPostAudited,
          );
          if (!latestCreatorInfo.directPostAllowed) {
            throw publicError(
              403,
              "direct_post_unavailable",
              latestCreatorInfo.restrictionReason,
            );
          }

          const title = bodyString(req.body, "caption");
          if (title === null || title.length > MAX_TIKTOK_CAPTION_LENGTH) {
            throw publicError(
              400,
              "invalid_caption",
              `The caption must be ${MAX_TIKTOK_CAPTION_LENGTH} characters or fewer.`,
            );
          }
          const privacyLevel = bodyString(req.body, "privacyLevel");
          if (!latestCreatorInfo.privacyLevelOptions.includes(privacyLevel)) {
            throw publicError(
              400,
              "privacy_option_unavailable",
              "Select a privacy option currently available for this TikTok account.",
            );
          }

          const durationSeconds = Number(
            bodyString(req.body, "videoDurationSeconds"),
          );
          if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            throw publicError(
              400,
              "video_duration_required",
              "Wait for the video duration to load before publishing.",
            );
          }
          if (durationSeconds > latestCreatorInfo.maxVideoPostDurationSec) {
            throw publicError(
              400,
              "video_too_long",
              `This TikTok account accepts videos up to ${latestCreatorInfo.maxVideoPostDurationSec} seconds.`,
            );
          }

          const allowComment = bodyBoolean(req.body, "allowComment");
          const allowDuet = bodyBoolean(req.body, "allowDuet");
          const allowStitch = bodyBoolean(req.body, "allowStitch");
          if (
            (allowComment && latestCreatorInfo.commentDisabled) ||
            (allowDuet && latestCreatorInfo.duetDisabled) ||
            (allowStitch && latestCreatorInfo.stitchDisabled)
          ) {
            throw publicError(
              400,
              "interaction_unavailable",
              "One selected interaction is no longer available for this account.",
            );
          }

          const commercialContent = bodyBoolean(
            req.body,
            "commercialContent",
          );
          const brandOrganicToggle = bodyBoolean(req.body, "brandOrganic");
          const brandContentToggle = bodyBoolean(req.body, "brandContent");
          if (
            (!commercialContent &&
              (brandOrganicToggle || brandContentToggle)) ||
            (commercialContent &&
              !brandOrganicToggle &&
              !brandContentToggle)
          ) {
            throw publicError(
              400,
              "commercial_disclosure_required",
              "Complete the commercial content disclosure before publishing.",
            );
          }
          if (brandContentToggle && privacyLevel === "SELF_ONLY") {
            throw publicError(
              400,
              "branded_content_privacy_conflict",
              "Branded content cannot use Only me visibility.",
            );
          }

          initializeTransfer = (transfer) =>
            tiktokClient.initializeDirectPost({
              ...transfer,
              postInfo: {
                title,
                privacyLevel,
                disableComment:
                  latestCreatorInfo.commentDisabled || !allowComment,
                disableDuet: latestCreatorInfo.duetDisabled || !allowDuet,
                disableStitch:
                  latestCreatorInfo.stitchDisabled || !allowStitch,
                brandContentToggle,
                brandOrganicToggle,
              },
            });
        }

        const result = await uploadVideoFile({
          filePath: req.file.path,
          videoSize: req.file.size,
          mimeType: req.file.mimetype,
          accessToken,
          tiktokClient,
          fetchImpl,
          initializeTransfer,
          onInitialized: async ({ publishId }) => {
            publish = await store.recordPublish(
              req.appSessionId,
              publishId,
              "UPLOADING",
              publishMode,
            );
          },
        });
        publish = await store.updatePublish(
          req.appSessionId,
          result.publishId,
          {
            status: result.status,
            uploadedBytes: req.file.size,
            failReason: null,
          },
        );
        res.status(202).set("Cache-Control", "no-store").json({ publish });
      } catch (error) {
        if (publish?.publishId) {
          await store
            .updatePublish(req.appSessionId, publish.publishId, {
              status: "TRANSFER_UNCONFIRMED",
              uploadedBytes: 0,
              failReason: null,
            })
            .catch(() => {
              console.error("Upload failure status persistence failed");
            });
        }
        next(error);
      } finally {
        if (req.file?.path) {
          await removeTemporaryFile(req.file.path).catch(() => {
            console.error("Temporary upload cleanup failed");
          });
        }
      }
    },
  );

  app.get(
    "/api/publish/status",
    requireSession,
    requireConnection,
    async (req, res, next) => {
      try {
        const publishId = scalarQuery(req.query.publishId);
        if (
          !publishId ||
          publishId.length > 256 ||
          !/^[A-Za-z0-9._~-]+$/.test(publishId)
        ) {
          throw publicError(400, "invalid_publish_id", "Invalid upload reference.");
        }
        if (!(await store.getPublish(req.appSessionId, publishId))) {
          throw publicError(404, "publish_not_found", "Upload reference not found.");
        }
        const accessToken = await validAccessToken(req.appSessionId);
        const status = await tiktokClient.fetchPublishStatus({
          accessToken,
          publishId,
        });
        const publish = await store.updatePublish(
          req.appSessionId,
          publishId,
          status,
        );
        res.set("Cache-Control", "no-store").json({ publish });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/disconnect",
    requireSession,
    requireCsrf,
    async (req, res, next) => {
      try {
        const connection = await store.getConnection(req.appSessionId);
        const authorizationRevoked = await tryRevokeConnection(
          req.appSessionId,
          connection,
        );
        if (connection) await store.disconnect(req.appSessionId);
        res.set("Cache-Control", "no-store").json({
          disconnected: true,
          authorizationRevoked,
          ...(authorizationRevoked
            ? {}
            : {
                revocationNotice:
                  "The local connection was removed. Revoke the app in TikTok settings to remove any remaining authorization.",
              }),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  async function deleteData(req, res, next) {
    try {
      const connection = await store.getConnection(req.appSessionId);
      const authorizationRevoked = await tryRevokeConnection(
        req.appSessionId,
        connection,
      );
      await store.deleteUserData(req.appSessionId);
      clearSessionCookie(res, config);
      res.set("Cache-Control", "no-store").json({
        deleted: true,
        authorizationRevoked,
        ...(authorizationRevoked
          ? {}
          : {
              revocationNotice:
                "Local data was deleted. Revoke the app in TikTok settings to remove any remaining authorization.",
            }),
      });
    } catch (error) {
      next(error);
    }
  }

  app.post("/api/delete-data", requireSession, requireCsrf, deleteData);
  app.delete("/api/delete-data", requireSession, requireCsrf, deleteData);

  for (const [route, filename] of ROOT_FILE_ALLOWLIST) {
    app.get(route, async (_req, res, next) => {
      try {
        const filePath = join(PROJECT_ROOT, filename);
        if (TEXT_REWRITE_EXTENSIONS.has(extname(filename))) {
          let content = (await readFile(filePath, "utf8")).replaceAll(
            GITHUB_PAGES_BASE,
            config.publicOrigin,
          );
          if (extname(filename) === ".html" && content.includes("<script")) {
            const nonce = randomBytes(18).toString("base64");
            content = content.replaceAll(
              '<script type="application/ld+json">',
              `<script type="application/ld+json" nonce="${nonce}">`,
            );
            res.set("Content-Security-Policy", contentSecurityPolicy(config, nonce));
          }
          res.type(extname(filename)).send(content);
          return;
        }
        res.sendFile(filePath);
      } catch (error) {
        next(error);
      }
    });
  }

  app.get("/assets/:filename", (req, res, next) => {
    const filename = req.params.filename;
    if (!assetAllowlist.has(filename)) {
      next();
      return;
    }
    res.sendFile(join(PROJECT_ROOT, "assets", filename));
  });

  app.get("/:filename", async (req, res, next) => {
    const filename = req.params.filename;
    if (!verificationAllowlist.has(filename)) {
      next();
      return;
    }
    try {
      const content = await readFile(
        join(PROJECT_ROOT, "verification", filename),
      );
      if (content.byteLength > MAX_VERIFICATION_FILE_BYTES) {
        next();
        return;
      }
      res
        .set("Cache-Control", "no-store")
        .type("text/plain")
        .send(content);
    } catch (error) {
      if (error?.code === "ENOENT") {
        next();
        return;
      }
      next(error);
    }
  });

  app.use((req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
      errorResponse(res, 404, "not_found", "Endpoint not found.");
      return;
    }
    readFile(join(PROJECT_ROOT, "404.html"), "utf8")
      .then((content) => {
        res
          .status(404)
          .type("html")
          .send(content.replaceAll(GITHUB_PAGES_BASE, config.publicOrigin));
      })
      .catch(next);
  });

  app.use((error, req, res, _next) => {
    if (req.file?.path) {
      removeTemporaryFile(req.file.path).catch(() => {
        console.error("Temporary upload cleanup failed");
      });
    }

    if (error instanceof multer.MulterError) {
      const code = error.publicCode ||
        (error.code === "LIMIT_FILE_SIZE"
          ? "video_too_large"
          : "invalid_video_upload");
      const message =
        code === "video_too_large"
          ? "The selected video exceeds the upload limit."
          : code === "unsupported_video_type"
            ? "Use an MP4, MOV or WebM video."
            : "The video upload is invalid.";
      errorResponse(res, 400, code, message);
      return;
    }

    if (error instanceof HttpError) {
      errorResponse(res, error.status, error.code, error.message);
      return;
    }

    if (error instanceof TikTokApiError) {
      if (error.code === "scope_not_authorized") {
        errorResponse(
          res,
          401,
          "tiktok_reauthorization_required",
          "Reconnect TikTok to authorize Direct Post.",
        );
        return;
      }
      if (DIRECT_POST_LIMIT_CODES.has(error.code)) {
        errorResponse(
          res,
          403,
          "direct_post_temporarily_unavailable",
          "TikTok is not accepting another Direct Post for this account right now. Try again later.",
        );
        return;
      }
      if (error.code === "unaudited_client_can_only_post_to_private_accounts") {
        errorResponse(
          res,
          403,
          "private_account_required",
          "TikTok requires a private account while this Direct Post client is unaudited.",
        );
        return;
      }
      if (error.code === "privacy_level_option_mismatch") {
        errorResponse(
          res,
          400,
          "privacy_option_unavailable",
          "TikTok changed the available privacy options. Review them and try again.",
        );
        return;
      }
      const status = error.status === 401 ? 401 : error.status === 429 ? 429 : 502;
      errorResponse(
        res,
        status,
        "tiktok_request_failed",
        status === 429
          ? "TikTok rate limit reached. Wait and try again."
          : "TikTok could not complete the request. Try again.",
      );
      return;
    }

    if (error instanceof TikTokTransferError) {
      errorResponse(
        res,
        502,
        "tiktok_transfer_unconfirmed",
        "The transfer could not be confirmed. Check its status before trying again.",
      );
      return;
    }

    console.error("Unhandled application error", error?.name || "Error");
    errorResponse(res, 500, "internal_error", "The request could not be completed.");
  });

  return app;
}

export async function startServer(env = process.env) {
  const config = createConfig(env, PROJECT_ROOT);
  const store = config.databaseUrl
    ? await createPostgresStore(config)
    : createStore(config);
  const tiktokClient = createTikTokClient(config);
  await cleanupTemporaryDirectory(config.uploadDir).catch(() => {
    console.error("Startup upload cleanup failed");
  });
  const app = await createApp({ config, store, tiktokClient });
  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`Além do Hit server listening on port ${config.port}`);
  });

  const cleanupTimer = setInterval(() => {
    Promise.all([
      Promise.resolve(store.cleanupExpired()),
      cleanupTemporaryDirectory(config.uploadDir),
    ]).catch(() => {
      console.error("Scheduled cleanup failed");
    });
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanupTimer);
    server.close(async () => {
      await Promise.resolve(store.close()).catch(() => {
        console.error("Database shutdown failed");
      });
      process.exit(0);
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { app, server, store };
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntrypoint) {
  startServer().catch((error) => {
    console.error("Server startup failed", error?.message || "Unknown error");
    process.exit(1);
  });
}

export { REQUIRED_TIKTOK_SCOPES };
