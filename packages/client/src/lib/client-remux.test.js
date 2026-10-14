import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { remuxMkv, terminateLibav } from "../poc/client-remux.js";
import { inspectMatroska } from "../poc/mkv-inspect.js";

test("remuxMkv remuxes MKV selecting track 0 without re-encoding", async () => {
  const fixturePath = path.resolve(process.cwd(), "temp/fixtures/multi-audio.mkv");
  const buffer = fs.readFileSync(fixturePath);
  const file = new File([buffer], "multi-audio.mkv");

  const result = await remuxMkv(file, { audioTrackIndex: 0 });
  assert.ok(result.blob);
  assert.ok(result.sizeBytes > 0);
  assert.equal(result.audioTrackIndex, 0);
  assert.equal(result.isTranscode, false);

  const inspected = await inspectMatroska(result.blob);
  assert.equal(inspected.container, "matroska");
  assert.equal(inspected.audioTracks.length, 1, "remuxed file must isolate the selected audio track");
  assert.equal(inspected.audioTracks[0].language, "en");

  terminateLibav();
});

test("remuxMkv remuxes MKV selecting track 1 without re-encoding", async () => {
  const fixturePath = path.resolve(process.cwd(), "temp/fixtures/multi-audio.mkv");
  const buffer = fs.readFileSync(fixturePath);
  const file = new File([buffer], "multi-audio.mkv");

  const result = await remuxMkv(file, { audioTrackIndex: 1 });
  assert.ok(result.blob);
  assert.equal(result.audioTrackIndex, 1);

  const inspected = await inspectMatroska(result.blob);
  assert.equal(inspected.container, "matroska");
  assert.equal(inspected.audioTracks.length, 1);
  assert.equal(inspected.audioTracks[0].language, "es");

  terminateLibav();
});
