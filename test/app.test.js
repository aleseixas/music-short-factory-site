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
  const store = createStore(config);
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
  } finally {
    await close(server);
    store.close();
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test("connected creator confirms one real draft transfer and checks status", async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), "adh-app-upload-test-"));
  const config = testConfig(uploadDir);
  const store = createStore(config);
  const anonymous = store.createSession();
  const connected = store.attachConnectionAndRotate(anonymous.sessionId, {
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
    assert.equal(store.getSession(connected.sessionId).connected, false);
    assert.deepEqual(await readdir(uploadDir), []);
  } finally {
    await close(server);
    store.close();
    await rm(uploadDir, { recursive: true, force: true });
  }
});
