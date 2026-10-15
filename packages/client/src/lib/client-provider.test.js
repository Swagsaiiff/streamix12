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

test("client-provider classifies MovieBox as client-side primary provider", () => {
  const info = getProviderInfo("MovieBox");
  assert.equal(info.execution, "client");
  assert.equal(info.requiresBackend, false);
  assert.equal(isBackendRequiredForStream("MovieBox"), false);
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

test("resolveClientStream returns null when no direct stream url is present", () => {
  const stream = resolveClientStream({
    title: "Interstellar",
    provider: "MovieBox"
  });
  assert.equal(stream, null);
});
