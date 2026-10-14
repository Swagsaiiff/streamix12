// Minimal, dependency-free Matroska (MKV/WebM) header inspector.
// Parses the EBML structure of the first part of a file in the browser so the PoC can report the
// real container, codecs, resolution, duration and audio tracks without any server involvement.

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  LANGUAGE: 0x22b59c,
  NAME: 0x536e,
  AUDIO: 0xe1,
  CHANNELS: 0x9f,
  SAMPLING_FREQUENCY: 0xb5,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba
};

const CONTAINER_IDS = new Set([ID.EBML, ID.SEGMENT, ID.INFO, ID.TRACKS, ID.TRACK_ENTRY, ID.AUDIO, ID.VIDEO]);

const CODEC_NAMES = {
  V_VP8: { codec: "vp8", browser: "native", note: "VP8 (WebM)" },
  V_VP9: { codec: "vp9", browser: "native", note: "VP9 (WebM)" },
  V_AV1: { codec: "av1", browser: "native", note: "AV1 (WebM)" },
  V_MPEG4_ISO_AVC: { codec: "h264", browser: "needs-remux", note: "H.264/AVC in Matroska (browsers need MP4/WebM)" },
  "V_MPEG4/ISO/AVC": { codec: "h264", browser: "needs-remux", note: "H.264/AVC in Matroska (browsers need MP4/WebM)" },
  "V_MPEGH/ISO/HEVC": { codec: "hevc", browser: "unsupported", note: "HEVC/H.265 is not playable in most browsers" },
  "V_MPEG2": { codec: "mpeg2", browser: "unsupported", note: "MPEG-2 is not supported by browsers" },
  A_AAC: { codec: "aac", browser: "needs-remux", note: "AAC in Matroska (browsers need MP4/WebM)" },
  "A_AAC": { codec: "aac", browser: "needs-remux", note: "AAC in Matroska" },
  A_OPUS: { codec: "opus", browser: "native", note: "Opus (WebM)" },
  A_VORBIS: { codec: "vorbis", browser: "native", note: "Vorbis (WebM)" },
  A_AC3: { codec: "ac3", browser: "needs-transcode", note: "AC-3 is not playable in browsers" },
  "A_AC3": { codec: "ac3", browser: "needs-transcode", note: "AC-3 is not playable in browsers" },
  A_EAC3: { codec: "eac3", browser: "needs-transcode", note: "E-AC-3 is not playable in browsers" },
  A_DTS: { codec: "dts", browser: "needs-transcode", note: "DTS is not playable in browsers" },
  A_TRUEHD: { codec: "truehd", browser: "needs-transcode", note: "TrueHD is not playable in browsers" },
  A_FLAC: { codec: "flac", browser: "needs-remux", note: "FLAC in MP4/WebM may play" },
  A_MPEG_L3: { codec: "mp3", browser: "needs-remux", note: "MP3 in Matroska" },
  "A_MPEG/L3": { codec: "mp3", browser: "needs-remux", note: "MP3 in Matroska" }
};

function describeCodec(codecId, type) {
  if (!codecId) return { codec: null, browser: "unknown", note: null };
  const normalized = String(codecId).trim().toUpperCase().replace(/\//g, "_");
  const direct = CODEC_NAMES[codecId] ?? CODEC_NAMES[normalized];
  if (direct) return { codec: direct.codec, browser: direct.browser, note: direct.note };
  return {
    codec: String(codecId),
    browser: type === "audio" ? "needs-transcode" : "unknown",
    note: `Unknown codec id "${codecId}"`
  };
}

async function readSlice(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

// Reads an EBML element id (1-4 bytes, leading 1 bit marks the length) and a size VINT.
function readId(view, offset) {
  const first = view.getUint8(offset);
  let length = 1;
  if (first & 0x80) length = 1;
  else if (first & 0x40) length = 2;
  else if (first & 0x20) length = 3;
  else if (first & 0x10) length = 4;
  else return null;
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + view.getUint8(offset + i);
  return { value, length };
}

function readSize(view, offset) {
  const first = view.getUint8(offset);
  let length = 1;
  if (first & 0x80) length = 1;
  else if (first & 0x40) length = 2;
  else if (first & 0x20) length = 3;
  else if (first & 0x10) length = 4;
  else if (first & 0x08) length = 5;
  else if (first & 0x04) length = 6;
  else if (first & 0x02) length = 7;
  else if (first & 0x01) length = 8;
  else return { value: null, length: 1, unknown: true };

  const bytes = [];
  for (let i = 0; i < length; i += 1) bytes.push(view.getUint8(offset + i));
  bytes[0] &= 0xff >> length;
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  const allOnes = bytes.every((byte, index) => byte === (index === 0 ? (0xff >> length) : 0xff));
  return { value, length, unknown: allOnes };
}

function readString(view, offset, length) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  return new TextDecoder().decode(bytes).replace(/\0+$/, "");
}

function readUint(view, offset, length) {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + view.getUint8(offset + i);
  return value;
}

function readFloat(view, offset, length) {
  if (length === 4) return view.getFloat32(offset);
  if (length === 8) return view.getFloat64(offset);
  return null;
}

export async function inspectMatroska(blob, { headerBytes = 6 * 1024 * 1024 } = {}) {
  const bytes = await readSlice(blob, 0, Math.min(headerBytes, blob.size));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const result = {
    container: "matroska",
    fileSize: blob.size,
    durationSeconds: null,
    timestampScaleNs: null,
    video: null,
    audioTracks: [],
    subtitleTracks: 0,
    warnings: [],
    parsedBytes: bytes.byteLength,
    complete: true
  };

  const stack = [{ id: ID.SEGMENT, end: view.byteLength, depth: 0 }];
  let offset = 0;
  let currentTrack = null;

  while (offset < view.byteLength && offset < bytes.byteLength) {
    const idInfo = readId(view, offset);
    if (!idInfo) break;
    const sizeInfo = readSize(view, offset + idInfo.length);
    if (!sizeInfo) break;
    const headerEnd = offset + idInfo.length + sizeInfo.length;
    const elementId = idInfo.value;
    const size = sizeInfo.value;
    const dataEnd = sizeInfo.unknown ? view.byteLength : Math.min(headerEnd + size, view.byteLength);

    if (sizeInfo.unknown && size === null) {
      result.warnings.push(`unknown size for element 0x${elementId.toString(16)}`);
    }
    if (headerEnd + (size ?? 0) > view.byteLength) {
      result.complete = false;
      result.warnings.push("header window ended before all elements were parsed (increase headerBytes)");
    }

    switch (elementId) {
      case ID.TIMESTAMP_SCALE:
        result.timestampScaleNs = readUint(view, headerEnd, size);
        break;
      case ID.DURATION: {
        const duration = readFloat(view, headerEnd, size);
        const scale = result.timestampScaleNs ?? 1_000_000;
        if (duration != null) result.durationSeconds = (duration * scale) / 1e9;
        break;
      }
      case ID.TRACK_TYPE:
        if (currentTrack) currentTrack.trackType = readUint(view, headerEnd, size);
        break;
      case ID.TRACK_NUMBER:
        if (currentTrack) currentTrack.number = readUint(view, headerEnd, size);
        break;
      case ID.CODEC_ID:
        if (currentTrack) currentTrack.codecId = readString(view, headerEnd, size);
        break;
      case ID.LANGUAGE:
        if (currentTrack) currentTrack.language = readString(view, headerEnd, size);
        break;
      case ID.NAME:
        if (currentTrack) currentTrack.name = readString(view, headerEnd, size);
        break;
      case ID.CHANNELS:
        if (currentTrack?.audio) currentTrack.audio.channels = readUint(view, headerEnd, size);
        break;
      case ID.SAMPLING_FREQUENCY:
        if (currentTrack?.audio) currentTrack.audio.sampleRate = readFloat(view, headerEnd, size);
        break;
      case ID.PIXEL_WIDTH:
        if (currentTrack?.video) currentTrack.video.width = readUint(view, headerEnd, size);
        break;
      case ID.PIXEL_HEIGHT:
        if (currentTrack?.video) currentTrack.video.height = readUint(view, headerEnd, size);
        break;
      default:
        break;
    }

    if (elementId === ID.TRACK_ENTRY) {
      currentTrack = { trackType: null, number: null, codecId: null, language: null, name: null, audio: null, video: null };
    }
    if (elementId === ID.AUDIO && currentTrack) currentTrack.audio = { channels: null, sampleRate: null };
    if (elementId === ID.VIDEO && currentTrack) currentTrack.video = { width: null, height: null };

    const isContainer = CONTAINER_IDS.has(elementId);

    if (isContainer && !sizeInfo.unknown) {
      stack.push({ id: elementId, end: dataEnd, depth: stack.length });
      offset = headerEnd;
      continue;
    }

    offset = dataEnd;
    // Finalise a track entry when its container scope ends.
    while (stack.length > 0 && offset >= stack[stack.length - 1].end) {
      const closing = stack.pop();
      if (closing.id === ID.TRACK_ENTRY && currentTrack) {
        const type = currentTrack.trackType;
        const codec = describeCodec(currentTrack.codecId, type === 2 ? "audio" : "video");
        if (type === 1) {
          result.video = {
            number: currentTrack.number,
            codecId: currentTrack.codecId,
            ...codec,
            width: currentTrack.video?.width ?? null,
            height: currentTrack.video?.height ?? null
          };
        } else if (type === 2) {
          result.audioTracks.push({
            number: currentTrack.number,
            codecId: currentTrack.codecId,
            ...codec,
            language: currentTrack.language,
            name: currentTrack.name,
            channels: currentTrack.audio?.channels ?? null,
            sampleRate: currentTrack.audio?.sampleRate ?? null
          });
        } else if (type === 17) {
          result.subtitleTracks += 1;
        }
        currentTrack = null;
      }
      if (closing.id === ID.SEGMENT) break;
    }
    if (stack.length === 0) break;
  }

  if (!result.video) result.warnings.push("no video track found in the parsed header window");
  if (result.audioTracks.length === 0) result.warnings.push("no audio tracks found in the parsed header window");
  return result;
}

export function browserSupportFor(inspection) {
  const verdicts = [];
  if (!inspection?.video) return { verdict: "unsupported", reasons: ["No video track detected"] };

  const codec = inspection.video.codec;
  const vpFamily = ["vp8", "vp9", "av1"].includes(codec);
  const audioTracks = inspection.audioTracks || [];
  const audioNative = audioTracks.every((track) => ["opus", "vorbis", "flac", "mp3"].includes(track.codec));
  const audioRemuxOnly = audioTracks.some((track) => ["aac"].includes(track.codec));
  const hasPlayableAudio = audioTracks.some((track) => ["aac", "opus", "vorbis", "flac", "mp3"].includes(track.codec));
  const audioUnsupported = audioTracks.some((track) => ["ac3", "eac3", "dts", "truehd"].includes(track.codec));

  // Check HEVC support
  if (codec === "hevc") {
    const canPlayHevc =
      typeof document !== "undefined" &&
      Boolean(
        document.createElement("video").canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
        document.createElement("video").canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"')
      );
    if (!canPlayHevc) {
      return {
        verdict: "unsupported",
        reasons: ["HEVC / H.265 video is not supported by your browser. Server-side HLS transcoding is required."]
      };
    }
  }

  if (codec === "mpeg2") {
    return { verdict: "unsupported", reasons: ["MPEG-2 video is not supported by browsers"] };
  }

  if (audioUnsupported && !hasPlayableAudio) {
    return {
      verdict: "unsupported",
      reasons: [
        `Audio uses unsupported codec (${audioTracks.map((t) => t.codec?.toUpperCase()).join(", ")}). Browsers cannot decode E-AC-3 / Dolby Digital Plus client-side without server-side transcoding.`
      ]
    };
  }

  if (vpFamily && audioNative) {
    verdicts.push("Container codecs are WebM-compatible: native playback may work");
    return { verdict: "native", reasons: verdicts };
  }

  if (codec === "h264") {
    verdicts.push("Video is H.264/AVC; the Matroska container is not natively playable in browsers, remux is required");
  }

  if (audioRemuxOnly) {
    verdicts.push("AAC audio can be remuxed without re-encoding");
  }

  if (audioUnsupported && hasPlayableAudio) {
    verdicts.push("Contains mixed audio tracks including unsupported E-AC-3 / AC-3; selecting compatible AAC/Opus tracks is required");
  }

  return { verdict: "remux-needed", reasons: verdicts };
}
