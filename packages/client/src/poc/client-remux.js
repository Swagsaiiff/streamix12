// Client-side MKV remux and audio processing using Mediabunny (range-based FastStart MP4)
// and libav.js (FFmpeg WebAssembly fallback).
// Everything runs strictly in the browser: no server FFmpeg, no HLS session, no backend endpoints.

import {
  Input,
  Output,
  Conversion,
  UrlSource,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  ALL_FORMATS
} from "mediabunny";

const CLI_WASM_URL = "/libav/libav-default-cli.wasm";
const DEFAULT_WASM_URL = "/libav/libav-default.wasm";

async function resolveWasmUrl() {
  try {
    const headCli = await fetch(CLI_WASM_URL, { method: "HEAD" });
    if (headCli.ok) return CLI_WASM_URL;
  } catch {
    // fallback
  }
  try {
    const headDef = await fetch(DEFAULT_WASM_URL, { method: "HEAD" });
    if (headDef.ok) return DEFAULT_WASM_URL;
  } catch {
    // fallback
  }
  return null;
}

let instancePromise = null;

async function getInstance(onLog) {
  if (!instancePromise) {
    instancePromise = (async () => {
      const wasmurl = await resolveWasmUrl();
      const { default: LibAVModule } = await import("libav.js/default-cli");
      onLog?.(`loading libav.js WASM CLI${wasmurl ? ` from ${wasmurl}` : ""}…`);
      const libav = await LibAVModule.LibAV(wasmurl ? { wasmurl } : undefined);
      onLog?.("libav.js WASM core ready in browser");
      return libav;
    })().catch((error) => {
      instancePromise = null;
      throw error;
    });
  }
  return instancePromise;
}

export async function terminateLibav() {
  if (!instancePromise) return;
  try {
    const libav = await instancePromise;
    libav.terminate?.();
  } catch {
    // ignore
  }
  instancePromise = null;
}

// Remuxes the given MKV/WebM file using libav.js into a container containing the video track and the selected
// audio track. Preserves exact Matroska container structure for backward compatibility and tests.
export async function remuxMkv(
  file,
  { audioTrackIndex = 0, transcodeAudio = false, onLog, outputFormat = "matroska" } = {}
) {
  if (outputFormat === "mp4") {
    return remuxMkvToMp4(file, { audioTrackIndex });
  }

  const libav = await getInstance(onLog);
  const inputExt = file.name?.endsWith(".webm") ? "webm" : "mkv";
  const inputName = `input-${Date.now()}.${inputExt}`;
  const outFormat = "matroska";
  const outputExt = "mkv";
  const outputName = `output-${Date.now()}.${outputExt}`;

  onLog?.(`staging ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) into WASM filesystem…`);
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  await libav.writeFile(inputName, fileBytes);

  const args = [
    "-i", inputName,
    "-map", "0:v:0",
    "-map", `0:a:${audioTrackIndex}`,
    ...(transcodeAudio
      ? ["-c:v", "copy", "-c:a", "libopus"]
      : ["-c", "copy"]),
    "-f", outFormat,
    outputName
  ];

  const start = performance.now();
  onLog?.(
    `executing browser-side ${transcodeAudio ? "WASM audio transcoding" : "demux/remux (stream copy)"}: ffmpeg ${args.join(" ")}`
  );

  const code = await libav.ffmpeg(...args);
  if (code !== 0) {
    throw new Error(`libav ffmpeg exited with code ${code}`);
  }

  const data = await libav.readFile(outputName);
  const elapsedMs = performance.now() - start;

  try {
    await libav.unlink(inputName);
    await libav.unlink(outputName);
  } catch {
    // ignore
  }

  const blob = new Blob([data], { type: "video/x-matroska" });
  onLog?.(
    `browser-side media ready in ${Math.round(elapsedMs)}ms → ${(blob.size / 1024 / 1024).toFixed(1)} MB`
  );

  return {
    blob,
    url: URL.createObjectURL(blob),
    sizeBytes: blob.size,
    elapsedMs,
    args,
    audioTrackIndex,
    isTranscode: transcodeAudio
  };
}

// Inspects an MKV source (URL or Blob) using Mediabunny range requests without downloading the entire file.
export async function inspectMkvSource(sourceInput, { signal, headers = {} } = {}) {
  let source;
  if (typeof sourceInput === "string") {
    if (sourceInput.startsWith("blob:") || sourceInput.startsWith("data:")) {
      const res = await fetch(sourceInput, { signal });
      const blob = await res.blob();
      source = new BlobSource(blob);
    } else {
      source = new UrlSource(sourceInput, {
        requestInit: { signal, headers }
      });
    }
  } else if (sourceInput instanceof Blob) {
    source = new BlobSource(sourceInput);
  } else {
    throw new Error("Invalid source for MKV inspection");
  }

  const input = new Input({ source, formats: ALL_FORMATS });

  try {
    const videoTracks = await input.getVideoTracks();
    const audioTracks = await input.getAudioTracks();

    let duration = null;
    try {
      duration = await input.computeDuration();
    } catch {
      try {
        duration = input.getDurationFromMetadata();
      } catch {
        duration = null;
      }
    }

    const primaryVideo = videoTracks[0] ?? null;
    const isVideoHevc = primaryVideo?.codec === "hevc";
    const isVideoMpeg2 = primaryVideo?.codec === "mpeg2";

    const canPlayHevc =
      typeof document !== "undefined" &&
      Boolean(
        document.createElement("video").canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
        document.createElement("video").canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"')
      );

    const unsupportedReasons = [];

    if (!primaryVideo) {
      unsupportedReasons.push("No video track found in Matroska media");
    } else if (isVideoHevc && !canPlayHevc) {
      unsupportedReasons.push("HEVC / H.265 video is not supported by your browser. Server-side HLS transcoding is required.");
    } else if (isVideoMpeg2) {
      unsupportedReasons.push("MPEG-2 video codec is not supported by browsers");
    }

    const mappedAudio = audioTracks.map((track, idx) => {
      const codec = String(track.codec || "").toLowerCase();
      const isPlayable = ["aac", "opus", "vorbis", "flac", "mp3"].includes(codec);
      return {
        id: idx,
        trackNumber: track.number,
        codec,
        language: track.language || "und",
        name: track.title || (track.language ? track.language.toUpperCase() : `Audio Track ${idx + 1}`),
        channels: track.numberOfChannels || 2,
        sampleRate: track.sampleRate || 44100,
        isPlayable
      };
    });

    const hasPlayableAudio = mappedAudio.length === 0 || mappedAudio.some((t) => t.isPlayable);
    if (!hasPlayableAudio) {
      unsupportedReasons.push(
        `Audio uses unsupported codec (${mappedAudio.map((t) => t.codec.toUpperCase()).join(", ")}). Browsers cannot decode E-AC-3 / Dolby Digital without server-side transcoding.`
      );
    }

    return {
      video: primaryVideo
        ? {
            codec: primaryVideo.codec,
            width: primaryVideo.displayWidth || primaryVideo.width,
            height: primaryVideo.displayHeight || primaryVideo.height
          }
        : null,
      audioTracks: mappedAudio,
      duration,
      isSupported: unsupportedReasons.length === 0,
      unsupportedReasons
    };
  } finally {
    await input.dispose();
  }
}

// Incrementally remuxes MKV/WebM to FastStart MP4 using Mediabunny.
// Performs pure stream-copying without re-encoding and isolates the requested audio track.
export async function remuxMkvToMp4(
  sourceInput,
  { audioTrackIndex = 0, signal, onProgress } = {}
) {
  let source;
  if (typeof sourceInput === "string") {
    if (sourceInput.startsWith("blob:") || sourceInput.startsWith("data:")) {
      const res = await fetch(sourceInput, { signal });
      const blob = await res.blob();
      source = new BlobSource(blob);
    } else {
      source = new UrlSource(sourceInput, {
        requestInit: { signal }
      });
    }
  } else if (sourceInput instanceof Blob) {
    source = new BlobSource(sourceInput);
  } else {
    throw new Error("Invalid source input for remuxMkvToMp4");
  }

  const input = new Input({ source, formats: ALL_FORMATS });

  if (signal?.aborted) {
    await input.dispose();
    throw new Error("Remux aborted");
  }

  const targetTrackNumber = audioTrackIndex + 1;
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget()
  });

  const conversion = await Conversion.init({
    input,
    output,
    audio: (track) => {
      if (track.number !== targetTrackNumber) return { discard: true };
      return {};
    }
  });

  if (!conversion.isValid) {
    await input.dispose();
    const explanation = conversion.discardedTracks?.map((d) => d.reason).join("; ") || "incompatible container or codec";
    throw new Error(`Cannot remux to MP4: ${explanation}`);
  }

  let abortHandler = null;
  if (signal) {
    abortHandler = () => {
      try {
        conversion.cancel();
      } catch {
        // ignore
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await conversion.execute();
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    await input.dispose();
  }

  const blob = new Blob([output.target.buffer], { type: "video/mp4" });
  return {
    blob,
    url: URL.createObjectURL(blob),
    sizeBytes: blob.size,
    audioTrackIndex,
    mimeType: "video/mp4"
  };
}
