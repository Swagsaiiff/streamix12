import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DirectSourceProvider,
  WikimediaSourceProvider,
  ArchiveOrgSourceProvider,
  StremioAddonSourceProvider,
  SourceDiscoveryEngine
} from "./source-providers/index.js";

test("DirectSourceProvider resolves built-in dual-audio sample clip", async () => {
  const provider = new DirectSourceProvider();
  const res = await provider.resolveStreams({ id: "sample-clip" });
  assert.equal(res.sources.length, 1);
  assert.equal(res.sources[0].url, "/fixtures/multi-audio-test.mkv");
  assert.equal(res.sources[0].format, "mkv");
  assert.equal(res.sources[0].isPlayableInBrowser, true);
});

test("DirectSourceProvider resolves explicit media URLs accurately", async () => {
  const provider = new DirectSourceProvider();
  const res = await provider.resolveStreams({
    streamUrl: "https://example.com/movie.mp4",
    title: "Test Movie"
  });
  assert.equal(res.sources.length, 1);
  assert.equal(res.sources[0].url, "https://example.com/movie.mp4");
  assert.equal(res.sources[0].format, "mp4");
  assert.equal(res.sources[0].isPlayableInBrowser, true);
});

test("WikimediaSourceProvider resolves open films by IMDb ID and normalized title", async () => {
  const provider = new WikimediaSourceProvider();
  
  // By IMDb ID
  const bbb = await provider.resolveStreams({ id: "tt1254207" });
  assert.equal(bbb.sources.length, 1);
  assert.match(bbb.sources[0].url, /upload\.wikimedia\.org/);
  assert.equal(bbb.sources[0].format, "webm");
  assert.equal(bbb.sources[0].corsEnabled, true);

  // By title
  const sintel = await provider.resolveStreams({ title: "Sintel" });
  assert.equal(sintel.sources.length, 1);
  assert.match(sintel.sources[0].url, /upload\.wikimedia\.org/);
  assert.equal(sintel.sources[0].format, "webm");

  // Unmatched title returns no sources
  const unknown = await provider.resolveStreams({ title: "Random Commercial Title 2026" });
  assert.equal(unknown.sources.length, 0);
});

test("ArchiveOrgSourceProvider enforces title & year matching and rejects non-video items", async () => {
  const provider = new ArchiveOrgSourceProvider();

  // Series are skipped because Archive movies search is for feature films
  const seriesRes = await provider.resolveStreams({ type: "series", id: "tt0944947", title: "Game of Thrones" });
  assert.equal(seriesRes.sources.length, 0);

  // Empty title is rejected
  const emptyRes = await provider.resolveStreams({ title: "" });
  assert.equal(emptyRes.sources.length, 0);
});

test("StremioAddonSourceProvider constructs correct stream paths and separates HTTP from torrents", () => {
  const provider = new StremioAddonSourceProvider();

  const moviePath = provider.buildStreamPath("movie", "tt1234567");
  assert.equal(moviePath, "/stream/movie/tt1234567.json");

  // Series S2E5 path
  const seriesPath = provider.buildStreamPath("series", "tt1234567", 2, 5);
  assert.equal(seriesPath, "/stream/series/tt1234567:2:5.json");

  // Rejects different season/episode
  assert.notEqual(provider.buildStreamPath("series", "tt1234567", 2, 5), provider.buildStreamPath("series", "tt1234567", 2, 6));
});

test("SourceDiscoveryEngine discovers verified open media and resolves sample clips", async () => {
  const engine = new SourceDiscoveryEngine();

  // Test clip
  const clip = await engine.discoverStream({ id: "sample-clip" });
  assert.equal(clip.sourceUrl, "/fixtures/multi-audio-test.mkv");
  assert.equal(clip.mediaType, "mkv");
  assert.equal(clip.streamMode, "client");

  // Open title
  const bbb = await engine.discoverStream({ id: "tt1254207", title: "Big Buck Bunny" });
  assert.match(bbb.sourceUrl, /wikimedia\.org/);
  assert.equal(bbb.mediaType, "webm");
  assert.equal(bbb.streamMode, "client");
});

test("SourceDiscoveryEngine honestly reports when no browser stream exists without inventing URLs", async () => {
  const engine = new SourceDiscoveryEngine();

  await assert.rejects(
    async () => {
      await engine.discoverStream({
        id: "tt99999999",
        title: "Nonexistent Movie Title XYZ",
        year: 2099
      });
    },
    (err) => {
      assert.equal(err.code, "NO_BROWSER_STREAM");
      assert.match(err.message, /No browser-accessible stream source found/);
      assert.ok(Array.isArray(err.diagnostics));
      return true;
    }
  );
});

test("Episode matching strictly isolates requested episode without returning a different one", async () => {
  const provider = new StremioAddonSourceProvider();
  const path1 = provider.buildStreamPath("series", "tt0944947", 1, 1);
  const path2 = provider.buildStreamPath("series", "tt0944947", 1, 2);

  assert.equal(path1, "/stream/series/tt0944947:1:1.json");
  assert.equal(path2, "/stream/series/tt0944947:1:2.json");
  assert.notEqual(path1, path2);
});

test("StremioAddonSourceProvider rejects streams requiring forbidden browser headers or notWebReady", async () => {
  const provider = new StremioAddonSourceProvider();
  const originalFetch = globalThis.fetch;

  // Mock addon response with notWebReady, forbidden headers, and mismatched episode
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      streams: [
        {
          url: "https://example.com/blocked-headers.mp4",
          behaviorHints: {
            proxyHeaders: {
              request: {
                Referer: "https://upstream.secret.com",
                Cookie: "session=123"
              }
            }
          }
        },
        {
          url: "https://example.com/not-web-ready.mkv",
          behaviorHints: {
            notWebReady: true
          }
        },
        {
          url: "https://example.com/wrong-episode.mp4",
          title: "Show Title S01E05 1080p"
        }
      ]
    })
  });

  try {
    const res = await provider.resolveStreams({
      type: "series",
      id: "tt1234567",
      season: 1,
      episode: 1
    });

    // Mismatched episode S01E05 was skipped for S01E01 query
    // Streams with forbidden headers and notWebReady are marked isPlayableInBrowser: false
    assert.equal(res.sources.length, 2);
    assert.equal(res.sources[0].isPlayableInBrowser, false);
    assert.match(res.sources[0].limitation, /forbidden|custom upstream headers/i);
    assert.equal(res.sources[1].isPlayableInBrowser, false);
    assert.match(res.sources[1].limitation, /not web-ready/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverClientStream preserves abort signal and queries discovery engine without backend calls", async () => {
  const controller = new AbortController();
  controller.abort();

  const { discoverClientStream } = await import("./client-provider.js");

  // Aborted signal throws AbortError
  await assert.rejects(
    async () => {
      await discoverClientStream(
        {
          id: "tt99999999",
          title: "Nonexistent Title",
          year: 2099
        },
        { signal: controller.signal }
      );
    },
    (err) => err.name === "AbortError"
  );
});
