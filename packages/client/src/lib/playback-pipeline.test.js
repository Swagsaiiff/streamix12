import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inspectMkvSource, remuxMkvToMp4 } from "../poc/client-remux.js";
import { browserSupportFor } from "../poc/mkv-inspect.js";
import { getStreamResolutionPlan } from "./client-provider.js";
import { clampPosition, progressKey } from "./progress.js";

test("getStreamResolutionPlan routes MP4, WebM, HLS, DASH, and MKV to client playback", () => {
  assert.equal(getStreamResolutionPlan({ streamUrl: "https://example.com/movie.mp4" }).format, "mp4");
  assert.equal(getStreamResolutionPlan({ streamUrl: "https://example.com/movie.webm" }).format, "webm");
  assert.equal(getStreamResolutionPlan({ streamUrl: "https://example.com/live.m3u8" }).format, "hls");
  assert.equal(getStreamResolutionPlan({ streamUrl: "https://example.com/manifest.mpd" }).format, "dash");
  assert.equal(getStreamResolutionPlan({ streamUrl: "https://example.com/video.mkv" }).format, "mkv");
  assert.equal(getStreamResolutionPlan({ streamUrl: "https://example.com/movie.mp4" }).requiresBackend, false);
});

test("inspectMkvSource recognizes browser-supported H.264 and AAC tracks on real MKV fixture", async () => {
  const fixturePath = path.resolve(process.cwd(), "packages/client/public/fixtures/multi-audio-test.mkv");
  const buffer = fs.readFileSync(fixturePath);
  const blob = new Blob([buffer], { type: "video/x-matroska" });

  const result = await inspectMkvSource(blob);
  assert.equal(result.isSupported, true);
  assert.equal(result.video?.codec, "avc");
  assert.equal(result.video?.height, 360);
  assert.equal(result.audioTracks.length, 2);
  assert.equal(result.audioTracks[0].codec, "aac");
  assert.equal(result.audioTracks[0].isPlayable, true);
  assert.equal(result.audioTracks[1].codec, "aac");
  assert.equal(result.audioTracks[1].isPlayable, true);
});

test("browserSupportFor rejects unsupported codecs like HEVC and E-AC-3 honestly", () => {
  const hevcSample = {
    video: { codec: "hevc", width: 1920, height: 1080 },
    audioTracks: [{ codec: "aac", language: "eng" }]
  };
  const hevcVerdict = browserSupportFor(hevcSample);
  assert.equal(hevcVerdict.verdict, "unsupported");
  assert.match(hevcVerdict.reasons[0], /HEVC \/ H\.265 video is not supported/i);

  const eac3Sample = {
    video: { codec: "h264", width: 1920, height: 1080 },
    audioTracks: [{ codec: "eac3", language: "eng" }]
  };
  const eac3Verdict = browserSupportFor(eac3Sample);
  assert.equal(eac3Verdict.verdict, "unsupported");
  assert.match(eac3Verdict.reasons[0], /E-AC-3/i);

  const mixedAudioSample = {
    video: { codec: "h264", width: 1920, height: 1080 },
    audioTracks: [
      { codec: "eac3", language: "ita" },
      { codec: "aac", language: "eng" }
    ]
  };
  const mixedVerdict = browserSupportFor(mixedAudioSample);
  assert.equal(mixedVerdict.verdict, "remux-needed");
  assert.ok(mixedVerdict.reasons.some((r) => r.includes("mixed audio")));
});

test("remuxMkvToMp4 converts MKV to FastStart MP4 and isolates requested audio track", async () => {
  const fixturePath = path.resolve(process.cwd(), "packages/client/public/fixtures/multi-audio-test.mkv");
  const buffer = fs.readFileSync(fixturePath);
  const blob = new Blob([buffer], { type: "video/x-matroska" });

  // Test isolating audio track index 0
  const track0Result = await remuxMkvToMp4(blob, { audioTrackIndex: 0 });
  assert.ok(track0Result.blob);
  assert.equal(track0Result.mimeType, "video/mp4");
  assert.equal(track0Result.audioTrackIndex, 0);
  assert.ok(track0Result.sizeBytes > 0);

  // Test isolating audio track index 1
  const track1Result = await remuxMkvToMp4(blob, { audioTrackIndex: 1 });
  assert.ok(track1Result.blob);
  assert.equal(track1Result.audioTrackIndex, 1);
  assert.ok(track1Result.sizeBytes > 0);
});

test("remuxMkvToMp4 respects AbortSignal for immediate cancellation", async () => {
  const fixturePath = path.resolve(process.cwd(), "packages/client/public/fixtures/multi-audio-test.mkv");
  const buffer = fs.readFileSync(fixturePath);
  const blob = new Blob([buffer], { type: "video/x-matroska" });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    async () => {
      await remuxMkvToMp4(blob, { signal: controller.signal });
    },
    /abort/i
  );
});

test("playback position preservation clamps position within real duration", () => {
  assert.equal(clampPosition(100, 200), 100);
  assert.equal(clampPosition(-10, 200), 0);
  assert.equal(clampPosition(250, 200), 199);
  assert.equal(clampPosition("invalid", 200), 0);
});

test("progressKey preserves episode tracking without cross-title collision", () => {
  const movieKey = progressKey({ provider: "Direct", type: "movie", id: "sample-clip" });
  const ep1Key = progressKey({ provider: "CineStream", type: "series", id: "tt13444408", season: 1, episode: 1 });
  const ep2Key = progressKey({ provider: "CineStream", type: "series", id: "tt13444408", season: 1, episode: 2 });

  assert.equal(movieKey, "Direct:movie:sample-clip");
  assert.equal(ep1Key, "CineStream:series:tt13444408:s1e1");
  assert.equal(ep2Key, "CineStream:series:tt13444408:s1e2");
  assert.notEqual(ep1Key, ep2Key);
});

test("getStreamResolutionPlan routes direct media with query strings to client resolution without backend", () => {
  const plan = getStreamResolutionPlan({
    streamUrl: "https://cdn.example.org/media/video?auth=secret123&session=abc"
  });
  assert.equal(plan.canResolveClientSide, true);
  assert.equal(plan.format, "auto");
  assert.equal(plan.requiresBackend, false);
});

test("getStreamResolutionPlan marks CineStream and VegaMovies as backend-required for stream resolution", () => {
  const cinestreamPlan = getStreamResolutionPlan({
    title: "Vincenzo",
    provider: "CineStream",
    sourceUrl: "https://v3-cinemeta.strem.io/meta/series/tt13433812.json"
  });
  assert.equal(cinestreamPlan.canResolveClientSide, false);
  assert.equal(cinestreamPlan.requiresBackend, true);
  assert.match(cinestreamPlan.reasons[0], /metadata-only/i);

  const vegaPlan = getStreamResolutionPlan({
    title: "Interstellar",
    provider: "VegaMovies"
  });
  assert.equal(vegaPlan.canResolveClientSide, false);
  assert.equal(vegaPlan.requiresBackend, true);
  assert.match(vegaPlan.reasons[0], /Access-Control-Allow-Origin/i);
});
