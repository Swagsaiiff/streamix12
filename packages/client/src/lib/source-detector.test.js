import test from "node:test";
import assert from "node:assert/strict";
import {
  detectFormatFromUrl,
  detectFormatFromBytes,
  detectFormatFromContentType,
  probeMediaSource
} from "./source-detector.js";

test("detectFormatFromUrl correctly classifies file extensions and query parameters", () => {
  assert.equal(detectFormatFromUrl("https://example.com/video.mp4"), "mp4");
  assert.equal(detectFormatFromUrl("https://example.com/video.webm"), "webm");
  assert.equal(detectFormatFromUrl("https://example.com/live/playlist.m3u8"), "hls");
  assert.equal(detectFormatFromUrl("https://example.com/manifest.mpd"), "dash");
  assert.equal(detectFormatFromUrl("https://example.com/movie.mkv"), "mkv");
  assert.equal(detectFormatFromUrl("https://r2.example.com/path?response-content-disposition=Vincenzo.S01E01.mkv"), "mkv");
  assert.equal(detectFormatFromUrl("https://v3-cinemeta.strem.io/meta/series/tt13433812.json"), "json");
  assert.equal(detectFormatFromUrl("https://example.com/player.html"), "html");
  assert.equal(detectFormatFromUrl("https://example.com/watch.php?id=123"), "html");
});

test("detectFormatFromBytes recognizes media container signatures and text formats", () => {
  // MP4 with ftyp box at byte 4
  const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  assert.equal(detectFormatFromBytes(mp4Bytes), "mp4");

  // EBML Matroska header: 1A 45 DF A3 ... matroska
  const mkvHeader = Buffer.from("1a45dfa3a34286810142f7810142f281084282886d6174726f736b61", "hex");
  assert.equal(detectFormatFromBytes(new Uint8Array(mkvHeader)), "mkv");

  // EBML WebM header: 1A 45 DF A3 ... webm
  const webmHeader = Buffer.from("1a45dfa3a34286810142f7810142f281044282847765626d", "hex");
  assert.equal(detectFormatFromBytes(new Uint8Array(webmHeader)), "webm");

  // HLS playlist text
  const hlsBytes = new TextEncoder().encode("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nchunk.m3u8");
  assert.equal(detectFormatFromBytes(hlsBytes), "hls");

  // DASH MPD manifest text
  const dashBytes = new TextEncoder().encode('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">');
  assert.equal(detectFormatFromBytes(dashBytes), "dash");

  // HTML page text
  const htmlBytes = new TextEncoder().encode("<!DOCTYPE html><html><head><title>Cloudflare Block</title></head></html>");
  assert.equal(detectFormatFromBytes(htmlBytes), "html");

  // JSON document text
  const jsonBytes = new TextEncoder().encode('{"meta":{"id":"tt123","title":"Movie"}}');
  assert.equal(detectFormatFromBytes(jsonBytes), "json");
});

test("detectFormatFromContentType classifies standard MIME types", () => {
  assert.equal(detectFormatFromContentType("video/mp4"), "mp4");
  assert.equal(detectFormatFromContentType("video/webm"), "webm");
  assert.equal(detectFormatFromContentType("application/vnd.apple.mpegurl"), "hls");
  assert.equal(detectFormatFromContentType("application/x-mpegurl"), "hls");
  assert.equal(detectFormatFromContentType("application/dash+xml"), "dash");
  assert.equal(detectFormatFromContentType("video/x-matroska"), "mkv");
  assert.equal(detectFormatFromContentType("text/html; charset=utf-8"), "html");
  assert.equal(detectFormatFromContentType("application/json; charset=utf-8"), "json");
});

test("probeMediaSource flags 403 Forbidden and expired URLs honestly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Forbidden", {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "text/plain" }
    });

  try {
    const res = await probeMediaSource("https://r2.example.com/expired-token.mp4");
    assert.equal(res.format, "blocked");
    assert.equal(res.isPlayable, false);
    assert.match(res.error, /Stream URL is blocked or expired \(HTTP 403\)/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeMediaSource flags HTML web pages returned instead of video", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<!DOCTYPE html><html><body>Error page</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });

  try {
    const res = await probeMediaSource("https://example.com/watch/video");
    assert.equal(res.format, "html");
    assert.equal(res.isPlayable, false);
    assert.match(res.error, /HTML/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeMediaSource rejects JSON metadata endpoints passed as streams", async () => {
  const res = await probeMediaSource("https://v3-cinemeta.strem.io/meta/series/tt13433812.json");
  assert.equal(res.format, "json");
  assert.equal(res.isPlayable, false);
  assert.match(res.error, /JSON metadata endpoint/i);
});

test("detectFormatFromUrl returns unknown for extensionless URLs and does not assume mkv", () => {
  assert.equal(detectFormatFromUrl("https://example.com/stream/vincenzo-1080p"), "unknown");
  assert.equal(detectFormatFromUrl("https://fastdl.icu/download/token12345"), "unknown");
  assert.equal(detectFormatFromUrl("https://vcloud.beer/view/abc"), "unknown");
});

test("probeMediaSource detects format from redirect location", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    url: "https://storage.example.com/files/vincenzo-s01e01.mp4",
    headers: new Headers({ "content-type": "application/octet-stream" }),
    arrayBuffer: async () => new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]).buffer
  });

  try {
    const res = await probeMediaSource("https://example.com/api/get-link?id=123");
    assert.equal(res.format, "mp4");
    assert.equal(res.isPlayable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeMediaSource detects format from Content-Disposition header", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    url: "https://example.com/download/123",
    headers: new Headers({
      "content-disposition": 'attachment; filename="episode.webm"',
      "content-type": "application/octet-stream"
    }),
    arrayBuffer: async () => new Uint8Array([]).buffer
  });

  try {
    const res = await probeMediaSource("https://example.com/download/123");
    assert.equal(res.format, "webm");
    assert.equal(res.isPlayable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeMediaSource flags HTTP 410 as expired link", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 410,
    ok: false,
    headers: new Headers({ "content-type": "text/plain" }),
    arrayBuffer: async () => new Uint8Array([]).buffer
  });

  try {
    const res = await probeMediaSource("https://example.com/expired-stream");
    assert.equal(res.format, "expired");
    assert.equal(res.isPlayable, false);
    assert.match(res.error, /HTTP 410/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeMediaSource marks corsBlocked when fetch fails with network error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };

  try {
    const res = await probeMediaSource("https://cors-blocked.example.com/video.mkv");
    assert.equal(res.corsBlocked, true);
    assert.equal(res.format, "mkv"); // format known from extension
  } finally {
    globalThis.fetch = originalFetch;
  }
});
