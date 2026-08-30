import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfig } from "../server/config.js";
import { createApp } from "../server/index.js";
import { createStore } from "../server/store.js";

function testConfig(uploadDir) {
  const parsed = createConfig(
    {
      NODE_ENV: "development",
      PUBLIC_ORIGIN: "http://creator.example",
      TIKTOK_REDIRECT_URI:
        "http://creator.example/auth/tiktok/callback",
      TIKTOK_CLIENT_KEY: "test-client-key",
      TIKTOK_CLIENT_SECRET: "test-client-secret",
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      MAX_UPLOAD_BYTES: "1048576",
      TRUST_PROXY: "0",
    },
    process.cwd(),
  );
  return { ...parsed, databasePath: ":memory:", uploadDir };
}

function asyncStore(store) {
  return Object.fromEntries(
    Object.entries(store).map(([name, value]) => [
      name,
      typeof value === "function" ? async (...args) => value(...args) : value,
    ]),
  );
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server) {
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
}

test("Express serves only public files and creates a safe anonymous session", async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), "adh-app-static-test-"));
  const config = testConfig(uploadDir);
  const sqliteStore = createStore(config);
  const store = asyncStore(sqliteStore);
  const tiktokClient = {};
  const app = await createApp({ config, store, tiktokClient });
  const { server, origin } = await listen(app);

  try {
    const home = await fetch(`${origin}/`);
    assert.equal(home.status, 200);
    assert.match(
      await home.text(),
      /<link rel="canonical" href="http:\/\/creator\.example\/">/,
    );

    const privateSource = await fetch(`${origin}/server/index.js`);
    assert.equal(privateSource.status, 404);
    assert.doesNotMatch(await privateSource.text(), /createTikTokClient/);

    const response = await fetch(`${origin}/api/session`);
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^adh_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const body = await response.json();
    assert.equal(body.connected, false);
    assert.equal(typeof body.csrfToken, "string");
    assert.deepEqual(body.scopes, []);
    assert.equal(JSON.stringify(body).includes("test-client-secret"), false);

    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", database: "ok" });
  } finally {
    await close(server);
    sqliteStore.close();
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test("health check reports an unavailable persistence layer", async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), "adh-app-health-test-"));
  const config = testConfig(uploadDir);
  const sqliteStore = createStore(config);
  const store = {
    ...asyncStore(sqliteStore),
    ping: async () => {
      throw new Error("database unavailable");
    },
  };
  const app = await createApp({ config, store, tiktokClient: {} });
  const { server, origin } = await listen(app);

  try {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "unavailable",
      database: "unavailable",
    });
  } finally {
    await close(server);
    sqliteStore.close();
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test("connected creator confirms one real draft transfer and checks status", async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), "adh-app-upload-test-"));
  const config = testConfig(uploadDir);
  const sqliteStore = createStore(config);
  const store = asyncStore(sqliteStore);
  const anonymous = sqliteStore.createSession();
  const connected = sqliteStore.attachConnectionAndRotate(anonymous.sessionId, {
    openId: "open-id-reviewer",
    displayName: "Sandbox Creator",
    avatarUrl: null,
    scopes: ["user.info.basic", "video.upload"],
    accessToken: "act.sandbox",
    refreshToken: "rft.sandbox",
    accessExpiresAt: Date.now() + 60 * 60 * 1000,
    refreshExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });

  let revokedToken = null;
  const tiktokClient = {
    initializeUpload: async () => ({
      publishId: "v_inbox_file~v2.integration-test",
      uploadUrl:
        "https://open-upload.tiktokapis.com/video/?upload_id=test&upload_token=opaque",
    }),
    fetchPublishStatus: async () => ({
      status: "SEND_TO_USER_INBOX",
      uploadedBytes: 1024,
      failReason: null,
    }),
    revokeAccess: async (token) => {
      revokedToken = token;
    },
  };
  const uploadFetch = async (_url, options) => {
    assert.equal(
      sqliteStore.getPublish(
        connected.sessionId,
        "v_inbox_file~v2.integration-test",
      ).status,
      "UPLOADING",
    );
    let bytes = 0;
    for await (const chunk of options.body) bytes += chunk.length;
    assert.equal(bytes, 1024);
    return new Response(null, { status: 201 });
  };
  const app = await createApp({
    config,
    store,
    tiktokClient,
    fetchImpl: uploadFetch,
  });
  const { server, origin } = await listen(app);
  const cookie = `${config.cookieName}=${connected.sessionId}`;

  try {
    const rejected = new FormData();
    rejected.append(
      "video",
      new Blob([Buffer.alloc(1024)], { type: "video/mp4" }),
      "review.mp4",
    );
    const missingConsent = await fetch(`${origin}/api/upload`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": connected.csrfToken,
      },
      body: rejected,
    });
    assert.equal(missingConsent.status, 400);

    const confirmed = new FormData();
    confirmed.append(
      "video",
      new Blob([Buffer.alloc(1024)], { type: "video/mp4" }),
      "review.mp4",
    );
    confirmed.append("consentConfirmed", "true");
    const uploaded = await fetch(`${origin}/api/upload`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": connected.csrfToken,
      },
      body: confirmed,
    });
    assert.equal(uploaded.status, 202);
    const uploadBody = await uploaded.json();
    assert.equal(
      uploadBody.publish.publishId,
      "v_inbox_file~v2.integration-test",
    );
    assert.equal(uploadBody.publish.status, "PROCESSING_UPLOAD");
    assert.equal(uploadBody.publish.mode, "draft");

    const duplicate = new FormData();
    duplicate.append(
      "video",
      new Blob([Buffer.alloc(1024)], { type: "video/mp4" }),
      "duplicate.mp4",
    );
    duplicate.append("consentConfirmed", "true");
    const blockedDuplicate = await fetch(`${origin}/api/upload`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": connected.csrfToken,
      },
      body: duplicate,
    });
    assert.equal(blockedDuplicate.status, 409);

    const status = await fetch(
      `${origin}/api/publish/status?publishId=${encodeURIComponent(uploadBody.publish.publishId)}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(status.status, 200);
    assert.equal((await status.json()).publish.status, "SEND_TO_USER_INBOX");

    const disconnected = await fetch(`${origin}/api/disconnect`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": connected.csrfToken,
      },
    });
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json()).authorizationRevoked, true);
    assert.equal(revokedToken, "act.sandbox");
    assert.equal(sqliteStore.getSession(connected.sessionId).connected, false);
    assert.deepEqual(await readdir(uploadDir), []);
  } finally {
    await close(server);
    sqliteStore.close();
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test("connected creator loads current settings and completes Direct Post", async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), "adh-app-direct-test-"));
  const config = testConfig(uploadDir);
  const sqliteStore = createStore(config);
  const store = asyncStore(sqliteStore);
  const anonymous = sqliteStore.createSession();
  const connected = sqliteStore.attachConnectionAndRotate(anonymous.sessionId, {
    openId: "open-id-direct-reviewer",
    displayName: "Private Sandbox Creator",
    avatarUrl: null,
    scopes: ["user.info.basic", "video.upload", "video.publish"],
    accessToken: "act.direct-sandbox",
    refreshToken: "rft.direct-sandbox",
    accessExpiresAt: Date.now() + 60 * 60 * 1000,
    refreshExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });

  let creatorInfoQueries = 0;
  let directInitialization = null;
  const tiktokClient = {
    queryCreatorInfo: async () => {
      creatorInfoQueries += 1;
      return {
        avatarUrl: null,
        username: "private_creator",
        nickname: "Private Sandbox Creator",
        privacyLevelOptions: [
          "FOLLOWER_OF_CREATOR",
          "MUTUAL_FOLLOW_FRIENDS",
          "SELF_ONLY",
        ],
        commentDisabled: false,
        duetDisabled: true,
        stitchDisabled: true,
        maxVideoPostDurationSec: 60,
      };
    },
    initializeDirectPost: async (input) => {
      directInitialization = input;
      return {
        publishId: "v_pub_file~v2.integration-test",
        uploadUrl:
          "https://open-upload.tiktokapis.com/video/?upload_id=direct&upload_token=opaque",
      };
    },
    fetchPublishStatus: async () => ({
      status: "PUBLISH_COMPLETE",
      uploadedBytes: 1024,
      failReason: null,
    }),
  };
  const uploadFetch = async (_url, options) => {
    let bytes = 0;
    for await (const chunk of options.body) bytes += chunk.length;
    assert.equal(bytes, 1024);
    return new Response(null, { status: 201 });
  };
  const app = await createApp({
    config,
    store,
    tiktokClient,
    fetchImpl: uploadFetch,
  });
  const { server, origin } = await listen(app);
  const cookie = `${config.cookieName}=${connected.sessionId}`;

  function directForm(privacyLevel = "SELF_ONLY") {
    const form = new FormData();
    form.append(
      "video",
      new Blob([Buffer.alloc(1024)], { type: "video/mp4" }),
      "direct-review.mp4",
    );
    form.append("publishMode", "direct");
    form.append("consentConfirmed", "true");
    form.append("caption", "Editable review caption #music");
    form.append("privacyLevel", privacyLevel);
    form.append("allowComment", "true");
    form.append("allowDuet", "false");
    form.append("allowStitch", "false");
    form.append("commercialContent", "false");
    form.append("brandOrganic", "false");
    form.append("brandContent", "false");
    form.append("videoDurationSeconds", "30");
    return form;
  }

  try {
    const creatorResponse = await fetch(`${origin}/api/creator-info`, {
      headers: { Cookie: cookie },
    });
    assert.equal(creatorResponse.status, 200);
    const creatorBody = await creatorResponse.json();
    assert.equal(creatorBody.creatorInfo.nickname, "Private Sandbox Creator");
    assert.deepEqual(creatorBody.creatorInfo.privacyLevelOptions, ["SELF_ONLY"]);
    assert.equal(creatorBody.creatorInfo.unaudited, true);

    const invalidPrivacy = await fetch(`${origin}/api/upload`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": connected.csrfToken,
      },
      body: directForm("PUBLIC_TO_EVERYONE"),
    });
    assert.equal(invalidPrivacy.status, 400);
    assert.equal(
      (await invalidPrivacy.json()).error.code,
      "privacy_option_unavailable",
    );
    assert.equal(directInitialization, null);

    const uploaded = await fetch(`${origin}/api/upload`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": connected.csrfToken,
      },
      body: directForm(),
    });
    assert.equal(uploaded.status, 202);
    const uploadBody = await uploaded.json();
    assert.equal(uploadBody.publish.publishId, "v_pub_file~v2.integration-test");
    assert.equal(uploadBody.publish.mode, "direct");
    assert.equal(directInitialization.postInfo.privacyLevel, "SELF_ONLY");
    assert.equal(directInitialization.postInfo.title, "Editable review caption #music");
    assert.equal(directInitialization.postInfo.disableComment, false);
    assert.equal(directInitialization.postInfo.disableDuet, true);
    assert.equal(directInitialization.postInfo.disableStitch, true);
    assert.equal(creatorInfoQueries, 3);

    const status = await fetch(
      `${origin}/api/publish/status?publishId=${encodeURIComponent(uploadBody.publish.publishId)}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.publish.status, "PUBLISH_COMPLETE");
    assert.equal(statusBody.publish.mode, "direct");
    assert.deepEqual(await readdir(uploadDir), []);
  } finally {
    await close(server);
    sqliteStore.close();
    await rm(uploadDir, { recursive: true, force: true });
  }
});
