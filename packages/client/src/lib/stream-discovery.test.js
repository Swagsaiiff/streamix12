import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DirectSourceProvider,
  MovieBoxSourceProvider,
  SourceDiscoveryEngine
} from "./source-providers/index.js";
import { buildWebEmbedUrl } from "./source-providers/moviebox-source-provider.js";

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

test("MovieBoxSourceProvider is registered as primary provider in SourceDiscoveryEngine", () => {
  const engine = new SourceDiscoveryEngine();
  const moviebox = engine.providers.find((p) => p.id === "moviebox");
  assert.ok(moviebox, "MovieBox provider should be registered");
  assert.equal(moviebox.isAvailable(), true);
});

test("buildWebEmbedUrl constructs dynamic embed URLs using TMDB ID and respects audio language", () => {
  const movieEmbed = buildWebEmbedUrl({ tmdbId: 550, type: "movie" });
  assert.equal(movieEmbed, "https://vidsrc.to/embed/movie/550");

  const movieEmbedHindi = buildWebEmbedUrl({ tmdbId: 550, type: "movie", selectedLanguage: "hi" });
  assert.equal(movieEmbedHindi, "https://vidsrc.to/embed/movie/550?lang=hi");

  const tvEmbed = buildWebEmbedUrl({ tmdbId: 1399, type: "series", season: 2, episode: 5 });
  assert.equal(tvEmbed, "https://vidsrc.to/embed/tv/1399/2/5");

  const tvEmbedFrench = buildWebEmbedUrl({ tmdbId: 1399, type: "series", season: 2, episode: 5, selectedLanguage: "fr" });
  assert.equal(tvEmbedFrench, "https://vidsrc.to/embed/tv/1399/2/5?lang=fr");
});

test("MovieBoxSourceProvider falls back to Web Embed when direct stream is not found", async () => {
  const provider = new MovieBoxSourceProvider();
  const res = await provider.resolveStreams({
    tmdbId: 550,
    title: "Fight Club",
    type: "movie"
  });

  assert.ok(res.sources.length > 0);
  const stream = res.sources[0];
  assert.ok(stream.url.includes("vidsrc.to/embed/movie/550") || stream.url.includes("moviebox"));
});

test("SourceDiscoveryEngine returns clean Stream Not Available error on failure when no TMDB ID or streams exist", async () => {
  const engine = new SourceDiscoveryEngine();

  await assert.rejects(
    async () => {
      await engine.discoverStream({
        id: "nonexistent-999999",
        title: "Nonexistent Movie Title XYZ 2099",
        year: 2099
      });
    },
    (err) => {
      assert.equal(err.code, "STREAM_NOT_AVAILABLE");
      assert.equal(err.message, "Stream Not Available");
      assert.ok(Array.isArray(err.diagnostics));
      return true;
    }
  );
});

test("DirectSourceProvider ignores query with no direct stream url", async () => {
  const provider = new DirectSourceProvider();
  const res = await provider.resolveStreams({ title: "No URL Film" });
  assert.equal(res.sources.length, 0);
  assert.equal(res.diagnostics.length, 1);
});

test("Embed vs Direct source detection differentiates iframe embed URLs from direct media streams", () => {
  const isEmbedStream = (url) => {
    const isDirectMedia =
      typeof url === "string" &&
      (url.includes(".m3u8") || url.includes(".mp4")) &&
      !url.includes("vidsrc") &&
      !url.includes("/embed");

    return (
      !isDirectMedia &&
      typeof url === "string" &&
      url.startsWith("http") &&
      (url.includes("vidsrc") ||
        url.includes("embed") ||
        url.includes("multiembed") ||
        url.includes("autoembed"))
    );
  };

  assert.equal(isEmbedStream("https://vidsrc.to/embed/tv/1234/1/1"), true);
  assert.equal(isEmbedStream("https://multiembed.mov/?video_id=1234"), true);
  assert.equal(isEmbedStream("https://autoembed.co/movie/tmdb/550"), true);
  assert.equal(isEmbedStream("https://example.com/stream/index.m3u8"), false);
  assert.equal(isEmbedStream("https://cdn.example.com/video.mp4"), false);
});

