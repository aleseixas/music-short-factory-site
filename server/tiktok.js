import { REQUIRED_TIKTOK_SCOPES } from "./config.js";

const AUTHORIZE_ENDPOINT = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/token/";
const REVOKE_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/revoke/";
const USER_INFO_ENDPOINT = "https://open.tiktokapis.com/v2/user/info/";
const UPLOAD_INIT_ENDPOINT =
  "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const STATUS_ENDPOINT =
  "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

export class TikTokApiError extends Error {
  constructor(code, status = 502, logId = null) {
    super(`TikTok API request failed (${code || "unknown_error"})`);
    this.name = "TikTokApiError";
    this.code = code || "tiktok_api_error";
    this.status = status;
    this.logId = logId;
  }
}

export function normalizeScopes(value) {
  const scopes = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,]+/);
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

export function hasRequiredScopes(scopes) {
  const granted = new Set(normalizeScopes(scopes));
  return REQUIRED_TIKTOK_SCOPES.every((scope) => granted.has(scope));
}

export function buildAuthorizeUrl({ clientKey, redirectUri, state }) {
  if (!clientKey || !redirectUri || !state) {
    throw new TypeError("clientKey, redirectUri and state are required");
  }
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", REQUIRED_TIKTOK_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body;
}

function safeErrorCode(value) {
  const code = String(value || "tiktok_api_error");
  return /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : "tiktok_api_error";
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TikTokApiError("invalid_json_response", 502);
  }
}

function assertTokenPayload(payload, responseStatus) {
  if (payload.error) {
    throw new TikTokApiError(
      safeErrorCode(payload.error),
      responseStatus >= 400 ? responseStatus : 502,
      payload.log_id || null,
    );
  }
  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token ||
    typeof payload.refresh_token !== "string" ||
    !payload.refresh_token ||
    typeof payload.open_id !== "string" ||
    !payload.open_id
  ) {
    throw new TikTokApiError("invalid_token_response", 502, payload.log_id || null);
  }
}

function assertApiPayload(payload, responseStatus) {
  const error = payload?.error;
  if (!error || error.code !== "ok") {
    throw new TikTokApiError(
      safeErrorCode(error?.code),
      responseStatus >= 400 ? responseStatus : 502,
      error?.log_id || null,
    );
  }
  return payload.data || {};
}

export function createTikTokClient({
  clientKey,
  clientSecret,
  redirectUri,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 30_000,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");

  async function request(url, options) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof TikTokApiError) throw error;
      throw new TikTokApiError("network_error", 502);
    }
    const payload = await parseResponse(response);
    if (!response.ok && !payload.error) {
      throw new TikTokApiError("http_error", response.status);
    }
    return { payload, status: response.status };
  }

  async function exchangeCode(code) {
    const { payload, status } = await request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    assertTokenPayload(payload, status);
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      openId: payload.open_id,
      scopes: normalizeScopes(payload.scope),
      expiresIn: Number(payload.expires_in),
      refreshExpiresIn: Number(payload.refresh_expires_in),
    };
  }

  async function refreshAccessToken(refreshToken) {
    const { payload, status } = await request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    assertTokenPayload(payload, status);
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      openId: payload.open_id,
      scopes: normalizeScopes(payload.scope),
      expiresIn: Number(payload.expires_in),
      refreshExpiresIn: Number(payload.refresh_expires_in),
    };
  }

  async function revokeAccess(accessToken) {
    const { payload, status } = await request(REVOKE_ENDPOINT, {
      method: "POST",
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody({
        client_key: clientKey,
        client_secret: clientSecret,
        token: accessToken,
      }),
    });
    if (payload.error || status >= 400) {
      throw new TikTokApiError(
        safeErrorCode(payload.error),
        status >= 400 ? status : 502,
        payload.log_id || null,
      );
    }
  }

  async function getUserInfo(accessToken) {
    const url = new URL(USER_INFO_ENDPOINT);
    url.searchParams.set("fields", "open_id,display_name,avatar_url");
    const { payload, status } = await request(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = assertApiPayload(payload, status);
    const user = data.user;
    if (!user || typeof user.open_id !== "string") {
      throw new TikTokApiError("invalid_user_response", 502);
    }
    return {
      openId: user.open_id,
      displayName:
        typeof user.display_name === "string" && user.display_name
          ? user.display_name
          : "TikTok creator",
      avatarUrl:
        typeof user.avatar_url === "string" && user.avatar_url
          ? user.avatar_url
          : null,
    };
  }

  async function initializeUpload({
    accessToken,
    videoSize,
    chunkSize,
    totalChunkCount,
  }) {
    const { payload, status } = await request(UPLOAD_INIT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        source_info: {
          source: "FILE_UPLOAD",
          video_size: videoSize,
          chunk_size: chunkSize,
          total_chunk_count: totalChunkCount,
        },
      }),
    });
    const data = assertApiPayload(payload, status);
    if (
      typeof data.publish_id !== "string" ||
      !data.publish_id ||
      typeof data.upload_url !== "string" ||
      !data.upload_url
    ) {
      throw new TikTokApiError("invalid_upload_init_response", 502);
    }
    return { publishId: data.publish_id, uploadUrl: data.upload_url };
  }

  async function fetchPublishStatus({ accessToken, publishId }) {
    const { payload, status } = await request(STATUS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const data = assertApiPayload(payload, status);
    if (typeof data.status !== "string" || !data.status) {
      throw new TikTokApiError("invalid_status_response", 502);
    }
    return {
      status: data.status,
      uploadedBytes: Number.isSafeInteger(data.uploaded_bytes)
        ? data.uploaded_bytes
        : 0,
      failReason:
        typeof data.fail_reason === "string" && data.fail_reason
          ? data.fail_reason
          : null,
    };
  }

  return Object.freeze({
    exchangeCode,
    refreshAccessToken,
    revokeAccess,
    getUserInfo,
    initializeUpload,
    fetchPublishStatus,
  });
}
