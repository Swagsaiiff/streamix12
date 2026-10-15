import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DirectSourceProvider,
  MovieBoxSourceProvider,
  SourceDiscoveryEngine
} from "./source-providers/index.js";

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

test("SourceDiscoveryEngine returns clean Stream Not Available error on failure", async () => {
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
