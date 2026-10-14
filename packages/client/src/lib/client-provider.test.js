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

test("client-provider classifies CineStream as hybrid (client catalog, backend stream)", () => {
  const info = getProviderInfo("CineStream");
  assert.equal(info.execution, "client-catalog");
  assert.equal(info.requiresBackendForStreams, true);
  assert.equal(isBackendRequiredForStream("CineStream"), true);
  assert.ok(info.backendReasons.length >= 3);
  assert.match(info.backendReasons[0], /metadata-only/i);
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
    title: "Big Buck Bunny",
    streamUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
  });
  assert.equal(plan.canResolveClientSide, true);
  assert.equal(plan.format, "mp4");
  assert.equal(plan.requiresBackend, false);
});

test("getStreamResolutionPlan identifies metadata JSON as requiring backend resolution", () => {
  const plan = getStreamResolutionPlan({
    title: "Vincenzo",
    provider: "CineStream",
    sourceUrl: "https://v3-cinemeta.strem.io/meta/series/tt13433812.json"
  });
  assert.equal(plan.canResolveClientSide, false);
  assert.equal(plan.requiresBackend, true);
  assert.equal(plan.provider, "CineStream");
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
