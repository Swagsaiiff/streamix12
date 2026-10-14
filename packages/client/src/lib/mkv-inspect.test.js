import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inspectMatroska, browserSupportFor } from "../poc/mkv-inspect.js";

test("inspectMatroska extracts container, video and dual audio tracks from real MKV fixture", async () => {
  const fixturePath = path.resolve(process.cwd(), "temp/fixtures/multi-audio.mkv");
  const buffer = fs.readFileSync(fixturePath);
  const blob = new Blob([buffer]);

  const result = await inspectMatroska(blob);
  assert.equal(result.container, "matroska");
  assert.ok(result.durationSeconds > 4 && result.durationSeconds < 6, `duration ${result.durationSeconds} should be ~5s`);
  assert.ok(result.video, "video track should be present");
  assert.equal(result.video.codec, "h264");
  assert.equal(result.video.width, 320);
  assert.equal(result.video.height, 240);

  assert.equal(result.audioTracks.length, 2, "must find both audio tracks");
  assert.equal(result.audioTracks[0].language, "en");
  assert.equal(result.audioTracks[0].codec, "aac");
  assert.equal(result.audioTracks[1].language, "es");
  assert.equal(result.audioTracks[1].codec, "aac");

  const support = browserSupportFor(result);
  assert.equal(support.verdict, "remux-needed");
  assert.ok(support.reasons.some((r) => r.includes("remux to MP4 is required") || r.includes("Matroska")));
});

test("inspectMatroska extracts 45s fixture with tracks and subtitles", async () => {
  const fixturePath = path.resolve(process.cwd(), "temp/fixture/multi-audio-test.mkv");
  const buffer = fs.readFileSync(fixturePath);
  const blob = new Blob([buffer]);

  const result = await inspectMatroska(blob);
  assert.equal(result.container, "matroska");
  assert.ok(result.durationSeconds > 40 && result.durationSeconds < 50);
  assert.equal(result.video?.width, 640);
  assert.equal(result.video?.height, 360);
  assert.equal(result.audioTracks.length, 2);
  assert.equal(result.audioTracks[0].language, "eng");
  assert.equal(result.audioTracks[1].language, "spa");
  assert.equal(result.subtitleTracks, 1);
});

test("browserSupportFor correctly classifies native WebM vs remux-needed vs unsupported", () => {
  const webmNative = {
    video: { codec: "vp9", width: 1920, height: 1080 },
    audioTracks: [{ codec: "opus", language: "eng" }]
  };
  assert.equal(browserSupportFor(webmNative).verdict, "native");

  const mkvRemux = {
    video: { codec: "h264", width: 1920, height: 1080 },
    audioTracks: [{ codec: "aac", language: "eng" }]
  };
  assert.equal(browserSupportFor(mkvRemux).verdict, "remux-needed");

  const noVideo = {
    video: null,
    audioTracks: []
  };
  assert.equal(browserSupportFor(noVideo).verdict, "unsupported");
});

test("inspectMatroska handles malformed or non-MKV data gracefully", async () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const result = await inspectMatroska(new Blob([garbage]));
  assert.equal(result.container, "matroska");
  assert.equal(result.video, null);
  assert.equal(result.audioTracks.length, 0);
  assert.ok(result.warnings.length > 0);
});
