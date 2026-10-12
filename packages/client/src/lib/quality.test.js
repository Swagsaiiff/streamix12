import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_QUALITY, buildQualityOptions, qualityLabel, describeQualityAvailability } from "./quality.js";

test("qualityLabel uses the real height when present", () => {
  assert.equal(qualityLabel({ height: 1080 }), "1080p");
  assert.equal(qualityLabel({ height: 480 }), "480p");
});

test("qualityLabel omits a resolution when the manifest provides none", () => {
  assert.equal(qualityLabel({}), null);
  assert.equal(qualityLabel(null), null);
});

test("qualityLabel falls back to bitrate only when no resolution exists", () => {
  assert.equal(qualityLabel({ bitrate: 800000 }), "800 kbps");
});

test("buildQualityOptions always offers Auto and maps each real level once", () => {
  const { options, single } = buildQualityOptions([{ height: 1080 }, { height: 720 }, { height: 480 }], 1);
  assert.deepEqual(options, [
    { value: AUTO_QUALITY, label: "Auto" },
    { value: 0, label: "1080p" },
    { value: 1, label: "720p" },
    { value: 2, label: "480p" }
  ]);
  assert.equal(single, false);
});

test("buildQualityOptions marks single-quality sources so the selector can be disabled", () => {
  const { options, single } = buildQualityOptions([{ height: 720 }], AUTO_QUALITY);
  assert.equal(options.length, 2);
  assert.equal(single, true);
  assert.equal(describeQualityAvailability(options), "Only one quality is available for this source");
});

test("buildQualityOptions never invents levels when the manifest exposes none", () => {
  const { options, single } = buildQualityOptions([], AUTO_QUALITY);
  assert.deepEqual(options, [{ value: AUTO_QUALITY, label: "Auto" }]);
  assert.equal(single, true);
  assert.match(describeQualityAvailability(options), /Only one quality/);
});

test("buildQualityOptions skips duplicate resolutions", () => {
  const { options } = buildQualityOptions([{ height: 720 }, { height: 720 }], AUTO_QUALITY);
  assert.equal(options.filter((o) => o.label === "720p").length, 1);
});