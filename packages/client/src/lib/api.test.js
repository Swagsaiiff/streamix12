import { test } from "node:test";
import assert from "node:assert/strict";
import { createStream } from "../api.js";

test("createStream resolves direct MP4 stream without backend", async () => {
  const stream = await createStream("movie", "direct", {
    streamUrl: "https://example.com/test.mp4",
    mediaType: "mp4",
    title: "Direct Test"
  });

  assert.equal(stream.status, "ready");
  assert.equal(stream.streamMode, "client");
  assert.equal(stream.mediaType, "mp4");
  assert.equal(stream.resolution.status, "direct_stream");
});

test("createStream throws clean Stream Not Available when title cannot be resolved", async () => {
  await assert.rejects(
    async () => {
      await createStream("series", "nonexistent-9999", {
        title: "Completely Nonexistent Series XYZ 2099",
        year: 2099
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, "STREAM_NOT_AVAILABLE");
      assert.equal(err.message, "Stream Not Available");
      return true;
    }
  );
});
