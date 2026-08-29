import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthorizeUrl,
  createTikTokClient,
  hasRequiredScopes,
} from "../server/tiktok.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("authorization URL requests only user.info.basic and video.upload", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientKey: "client-key",
      redirectUri: "https://creator.example/auth/tiktok/callback",
      state: "opaque-state",
    }),
  );
  assert.equal(url.origin, "https://www.tiktok.com");
  assert.equal(url.pathname, "/v2/auth/authorize/");
  assert.equal(url.searchParams.get("scope"), "user.info.basic,video.upload");
  assert.equal(url.searchParams.get("state"), "opaque-state");
  assert.equal(hasRequiredScopes("video.upload,user.info.basic"), true);
  assert.equal(hasRequiredScopes("user.info.basic"), false);
});

test("TikTok client exchanges, refreshes and revokes tokens without real calls", async () => {
  const requests = [];
  const responses = [
    {
      access_token: "act.one",
      refresh_token: "rft.one",
      open_id: "open-1",
      scope: "user.info.basic,video.upload",
      expires_in: 86400,
      refresh_expires_in: 31536000,
    },
    {
      access_token: "act.two",
      refresh_token: "rft.two",
      open_id: "open-1",
      scope: "video.upload,user.info.basic",
      expires_in: 86400,
      refresh_expires_in: 31536000,
    },
    {},
  ];
  const client = createTikTokClient({
    clientKey: "client-key",
    clientSecret: "server-only-secret",
    redirectUri: "https://creator.example/auth/tiktok/callback",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return jsonResponse(responses.shift());
    },
  });

  const exchanged = await client.exchangeCode("authorization-code");
  assert.equal(exchanged.accessToken, "act.one");
  assert.deepEqual(exchanged.scopes, ["user.info.basic", "video.upload"]);
  const exchangeBody = requests[0].options.body;
  assert.equal(exchangeBody.get("client_secret"), "server-only-secret");
  assert.equal(exchangeBody.get("grant_type"), "authorization_code");

  const refreshed = await client.refreshAccessToken("rft.one");
  assert.equal(refreshed.refreshToken, "rft.two");
  assert.equal(requests[1].options.body.get("refresh_token"), "rft.one");

  await client.revokeAccess("act.two");
  assert.equal(requests[2].options.body.get("token"), "act.two");
});

test("TikTok client validates user, upload initialization and status envelopes", async () => {
  const responses = [
    {
      data: {
        user: {
          open_id: "open-1",
          display_name: "Creator",
          avatar_url: "https://example.test/avatar.jpg",
        },
      },
      error: { code: "ok", message: "", log_id: "log-1" },
    },
    {
      data: {
        publish_id: "v_inbox_file~v2.test",
        upload_url:
          "https://open-upload.tiktokapis.com/video/?upload_id=test&upload_token=opaque",
      },
      error: { code: "ok", message: "", log_id: "log-2" },
    },
    {
      data: {
        status: "SEND_TO_USER_INBOX",
        uploaded_bytes: 1024,
      },
      error: { code: "ok", message: "", log_id: "log-3" },
    },
  ];
  const client = createTikTokClient({
    clientKey: "key",
    clientSecret: "secret",
    redirectUri: "https://creator.example/auth/tiktok/callback",
    fetchImpl: async () => jsonResponse(responses.shift()),
  });

  assert.equal((await client.getUserInfo("act.test")).displayName, "Creator");
  const upload = await client.initializeUpload({
    accessToken: "act.test",
    videoSize: 1024,
    chunkSize: 1024,
    totalChunkCount: 1,
  });
  assert.equal(upload.publishId, "v_inbox_file~v2.test");
  const status = await client.fetchPublishStatus({
    accessToken: "act.test",
    publishId: upload.publishId,
  });
  assert.equal(status.status, "SEND_TO_USER_INBOX");
  assert.equal(status.uploadedBytes, 1024);
});
