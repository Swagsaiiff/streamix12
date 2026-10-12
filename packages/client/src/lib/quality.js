// Quality options are derived from the actual HLS levels hls.js reports.
// Never invent resolutions: if the manifest exposes no height we omit the label.

export const AUTO_QUALITY = -1;

export function qualityLabel(level) {
  if (!level) return null;
  const height = Number(level.height);
  if (Number.isFinite(height) && height > 0) return `${height}p`;
  const width = Number(level.width);
  if (Number.isFinite(width) && width > 0) {
    const approx = [4320, 2160, 1440, 1080, 720, 576, 480, 360, 240, 144].find((h) => h <= Math.round(width * 0.5625));
    if (approx) return `${approx}p`;
  }
  if (Number.isFinite(Number(level.bitrate)) && Number(level.bitrate) > 0) {
    return `${Math.round(Number(level.bitrate) / 1000)} kbps`;
  }
  return null;
}

export function buildQualityOptions(levels = [], currentLevel = AUTO_QUALITY) {
  const options = [{ value: AUTO_QUALITY, label: "Auto" }];
  const seen = new Set();
  levels.forEach((level, index) => {
    const label = qualityLabel(level);
    if (!label) return;
    if (seen.has(label)) return;
    seen.add(label);
    options.push({ value: index, label });
  });
  // "single" means the source exposes at most one real quality, so switching is pointless.
  const single = options.length <= 2;
  return { options, single, hasRealChoices: options.length > 2, current: currentLevel };
}

export function describeQualityAvailability(options) {
  if (!options || options.length <= 2) {
    return "Only one quality is available for this source";
  }
  return null;
}
