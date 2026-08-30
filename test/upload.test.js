import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createChunkPlan,
  TikTokTransferError,
  uploadVideoFile,
} from "../server/upload.js";

const MEBIBYTE = 1024 * 1024;

test("chunk plans follow TikTok FILE_UPLOAD boundaries", () => {
  const small = createChunkPlan(4 * MEBIBYTE);
  assert.equal(small.totalChunkCount, 1);
  assert.equal(small.chunkSize, 4 * MEBIBYTE);
  assert.equal(small.chunks[0].length, 4 * MEBIBYTE);

  const large = createChunkPlan(70 * MEBIBYTE);
  assert.equal(large.chunkSize, 32 * MEBIBYTE);
  assert.equal(large.totalChunkCount, 2);
  assert.deepEqual(
    large.chunks.map((chunk) => chunk.length),
    [32 * MEBIBYTE, 38 * MEBIBYTE],
  );
});

test("video upload sends sequential ranged chunks only to a TikTok host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adh-upload-test-"));
  const filePath = join(directory, "video.mp4");
  const contents = Buffer.alloc(65 * MEBIBYTE, 7);
  await writeFile(filePath, contents);

  const calls = [];
  let initializedPublishId = null;
  const tiktokClient = {
    initializeUpload: async (input) => {
      assert.equal(input.videoSize, contents.length);
      assert.equal(input.totalChunkCount, 2);
      return {
        publishId: "v_inbox_file~v2.test",
        uploadUrl:
          "https://open-upload.tiktokapis.com/video/?upload_id=test&upload_token=opaque",
      };
    },
  };

  try {
    const result = await uploadVideoFile({
      filePath,
      videoSize: contents.length,
      mimeType: "video/mp4",
      accessToken: "act.test",
      tiktokClient,
      onInitialized: ({ publishId }) => {
        initializedPublishId = publishId;
      },
      fetchImpl: async (_url, options) => {
        let received = 0;
        for await (const chunk of options.body) received += chunk.length;
        calls.push({ headers: options.headers, received });
        return new Response(null, { status: calls.length === 2 ? 201 : 206 });
      },
    });
    assert.equal(result.publishId, "v_inbox_file~v2.test");
    assert.equal(initializedPublishId, result.publishId);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers["Content-Range"], `bytes 0-${32 * MEBIBYTE - 1}/${contents.length}`);
    assert.equal(calls[0].received, 32 * MEBIBYTE);
    assert.equal(calls[1].received, 33 * MEBIBYTE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("chunk upload retries 5xx and rejects a non-final success code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adh-upload-retry-test-"));
  const filePath = join(directory, "video.mp4");
  const contents = Buffer.alloc(MEBIBYTE, 3);
  await writeFile(filePath, contents);

  const tiktokClient = {
    initializeUpload: async () => ({
      publishId: "v_inbox_file~v2.retry-test",
      uploadUrl:
        "https://open-upload.tiktokapis.com/video/?upload_id=retry&upload_token=opaque",
    }),
  };

  try {
    let attempts = 0;
    const result = await uploadVideoFile({
      filePath,
      videoSize: contents.length,
      mimeType: "video/mp4",
      accessToken: "act.test",
      tiktokClient,
      fetchImpl: async (_url, options) => {
        for await (const _chunk of options.body) {
          // Consume the fresh stream on every attempt.
        }
        attempts += 1;
        return new Response(null, { status: attempts === 1 ? 500 : 201 });
      },
    });
    assert.equal(result.publishId, "v_inbox_file~v2.retry-test");
    assert.equal(attempts, 2);

    await assert.rejects(
      uploadVideoFile({
        filePath,
        videoSize: contents.length,
        mimeType: "video/mp4",
        accessToken: "act.test",
        tiktokClient,
        fetchImpl: async (_url, options) => {
          for await (const _chunk of options.body) {
            // Consume the request body before returning TikTok's response.
          }
          return new Response(null, { status: 206 });
        },
      }),
      TikTokTransferError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("video transfer can reuse chunk upload with a Direct Post initializer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adh-direct-upload-test-"));
  const filePath = join(directory, "video.mp4");
  const contents = Buffer.alloc(1024, 5);
  await writeFile(filePath, contents);
  let directInput = null;

  try {
    const result = await uploadVideoFile({
      filePath,
      videoSize: contents.length,
      mimeType: "video/mp4",
      accessToken: "act.direct",
      tiktokClient: {
        initializeUpload: async () => {
          throw new Error("draft initializer must not run");
        },
      },
      initializeTransfer: async (input) => {
        directInput = input;
        return {
          publishId: "v_pub_file~v2.transfer-test",
          uploadUrl:
            "https://open-upload.tiktokapis.com/video/?upload_id=direct&upload_token=opaque",
        };
      },
      fetchImpl: async (_url, options) => {
        for await (const _chunk of options.body) {
          // Consume the upload stream.
        }
        return new Response(null, { status: 201 });
      },
    });

    assert.equal(directInput.accessToken, "act.direct");
    assert.equal(directInput.videoSize, 1024);
    assert.equal(directInput.totalChunkCount, 1);
    assert.equal(result.publishId, "v_pub_file~v2.transfer-test");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
