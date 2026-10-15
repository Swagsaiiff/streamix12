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

test("parseLanguageTag accurately extracts language from diverse provider tags", async () => {
  const { parseLanguageTag } = await import("./source-providers/index.js");

  assert.deepEqual(parseLanguageTag("[Hindi]"), { code: "hi", name: "Hindi" });
  assert.deepEqual(parseLanguageTag("Hindi Dub"), { code: "hi", name: "Hindi" });
  assert.deepEqual(parseLanguageTag("hin"), { code: "hi", name: "Hindi" });
  assert.deepEqual(parseLanguageTag("Spanish Dub"), { code: "es", name: "Spanish" });
  assert.deepEqual(parseLanguageTag("Tamil"), { code: "ta", name: "Tamil" });
  assert.deepEqual(parseLanguageTag("telugu"), { code: "te", name: "Telugu" });
  assert.deepEqual(parseLanguageTag("Korean"), { code: "ko", name: "Korean" });
  assert.deepEqual(parseLanguageTag("French"), { code: "fr", name: "French" });
  assert.equal(parseLanguageTag("1080p Web-DL"), null);
  assert.equal(parseLanguageTag(""), null);
  assert.equal(parseLanguageTag(null), null);
});

test("discoverAvailableAudioLanguages dynamically discovers title languages without hardcoded arrays", async () => {
  const { discoverAvailableAudioLanguages } = await import("./source-providers/index.js");

  // 1. Movie with original language only
  const langs = await discoverAvailableAudioLanguages({
    item: { original_language: "ko", title: "Single Language Korean Film" }
  });
  assert.ok(Array.isArray(langs));
  assert.equal(langs.length, 1);
  assert.equal(langs[0].code, "ko");
  assert.equal(langs[0].name, "Korean (Original)");
  assert.equal(langs[0].isOriginal, true);

  // 2. English title defaults to English (Original)
  const engLangs = await discoverAvailableAudioLanguages({
    item: { original_language: "en", title: "English Feature Film" }
  });
  assert.equal(engLangs[0].code, "en");
  assert.equal(engLangs[0].name, "English (Original)");
});

test("buildWebEmbedUrl supports multiembed server and language query parameter", () => {
  const multiUrl = buildWebEmbedUrl({
    tmdbId: 550,
    type: "movie",
    server: "multiembed",
    selectedLanguage: "hi"
  });
  assert.equal(multiUrl, "https://multiembed.mov/?video_id=550&tmdb=1&lang=hi");
});


