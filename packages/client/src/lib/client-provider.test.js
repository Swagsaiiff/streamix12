import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  getProviderInfo,
  isBackendRequiredForStream,
  getStreamResolutionPlan,
  resolveClientStream
} from "./client-provider.js";

test("client-provider classifies Direct as client-side with no backend requirement", () => {
  const info = getProviderInfo("Direct");
  assert.equal(info.execution, "client");
  assert.equal(info.requiresBackend, false);
  assert.equal(isBackendRequiredForStream("Direct"), false);
});

test("client-provider classifies CineStream as client-first with no backend requirement", () => {
  const info = getProviderInfo("CineStream");
  assert.equal(info.execution, "client-first");
  assert.equal(info.requiresBackend, false);
  assert.equal(info.requiresBackendForStreams, false);
  assert.equal(isBackendRequiredForStream("CineStream"), false);
});

test("client-provider documents real reasons why VegaMovies requires backend", () => {
  const info = getProviderInfo("VegaMovies");
  assert.equal(info.execution, "backend-required");
  assert.equal(info.requiresBackend, true);
  assert.ok(info.backendReasons.length >= 2);
  assert.match(info.backendReasons[0], /Access-Control-Allow-Origin/i);
});

test("getStreamResolutionPlan identifies direct media as client-resolvable", () => {
  const plan = getStreamResolutionPlan({
    title: "Sample Video",
    streamUrl: "https://example.com/video.mp4"
  });
  assert.equal(plan.canResolveClientSide, true);
  assert.equal(plan.format, "mp4");
  assert.equal(plan.requiresBackend, false);
});

test("getStreamResolutionPlan resolves verified open titles client-side via registry", () => {
  const bbbPlan = getStreamResolutionPlan({ id: "tt1254207", title: "Big Buck Bunny", provider: "CineStream" });
  assert.equal(bbbPlan.canResolveClientSide, true);
  assert.equal(bbbPlan.format, "webm");
  assert.ok(bbbPlan.sourceUrl.includes("wikimedia.org"));

  const sintelPlan = getStreamResolutionPlan({ id: "tt1727587", title: "Sintel", provider: "CineStream" });
  assert.equal(sintelPlan.canResolveClientSide, true);
  assert.equal(sintelPlan.format, "webm");

  const samplePlan = getStreamResolutionPlan({ id: "sample-clip" });
  assert.equal(samplePlan.canResolveClientSide, true);
  assert.equal(samplePlan.format, "mkv");
  assert.equal(samplePlan.sourceUrl, "/fixtures/multi-audio-test.mkv");
});

test("getStreamResolutionPlan identifies scraper-dependent titles honestly without backend", () => {
  const plan = getStreamResolutionPlan({
    id: "tt31158589",
    title: "Don't Come Home",
    provider: "CineStream"
  });
  assert.equal(plan.canResolveClientSide, false);
  assert.equal(plan.provider, "CineStream");
  assert.match(plan.reasons[0], /No browser-accessible stream source found/i);
});

test("resolveClientStream immediately resolves direct MP4 stream without backend", () => {
  const stream = resolveClientStream({
    title: "Sample Video",
    streamUrl: "https://example.com/video.mp4"
  });
  assert.ok(stream);
  assert.equal(stream.status, "ready");
  assert.equal(stream.streamMode, "client");
  assert.equal(stream.mediaType, "mp4");
  assert.equal(stream.sourceUrl, "https://example.com/video.mp4");
});

test("resolveClientStream returns null for backend-required scraper items", () => {
  const stream = resolveClientStream({
    title: "Interstellar",
    provider: "VegaMovies",
    sourceUrl: "https://v3-cinemeta.strem.io/meta/movie/tt0816692.json"
  });
  assert.equal(stream, null);
});
