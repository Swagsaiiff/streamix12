import test from "node:test";
import assert from "node:assert/strict";
import { request, createStream } from "../api.js";

test("request handles 502 with empty body safely without throwing unexpected end of JSON input", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/plain" }
    });

  try {
    await assert.rejects(
      async () => {
        await request("/api/stream/series/tt13433812?season=1&episode=1", { method: "POST" });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Backend server is unreachable or offline/i);
        assert.doesNotMatch(err.message, /Unexpected end of JSON input/i);
        assert.equal(err.status, 502);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request handles HTML or non-JSON 404/500 safely with informative error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<!DOCTYPE html><html><body>Error</body></html>", {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "content-type": "text/html" }
    });

  try {
    await assert.rejects(
      async () => {
        await request("/api/stream/test");
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Request failed with status 500/i);
        assert.equal(err.status, 500);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request returns JSON body safely when response is OK", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, id: "sample123" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

  try {
    const data = await request("/api/sample");
    assert.deepEqual(data, { ok: true, id: "sample123" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createStream bypasses backend when direct sourceUrl is present", async () => {
  const stream = await createStream("series", "direct-1", {
    season: 1,
    episode: 1,
    sourceUrl: "https://example.com/direct.mp4",
    mediaType: "mp4"
  });

  assert.equal(stream.status, "ready");
  assert.equal(stream.streamMode, "client");
  assert.equal(stream.sourceUrl, "https://example.com/direct.mp4");
  assert.equal(stream.mediaType, "mp4");
  assert.equal(stream.resolution.status, "direct_stream");
});
