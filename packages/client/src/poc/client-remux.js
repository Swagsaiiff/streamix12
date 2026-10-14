// Client-side MKV remux and audio processing using libav.js (FFmpeg compiled to WebAssembly).
// Everything runs strictly in the browser: no server FFmpeg, no HLS session, no backend endpoints.
// The video and audio streams are copied (no re-encoding) when possible, or audio is transcoded
// via client-side WASM if requested or needed.

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

// Remuxes the given MKV/WebM file into a container containing the video track and the selected
// audio track. If `transcodeAudio` is true, audio is transcoded via WASM (libopus) while video
// is copied without re-encoding.
export async function remuxMkv(
  file,
  { audioTrackIndex = 0, transcodeAudio = false, onLog } = {}
) {
  const libav = await getInstance(onLog);
  const inputExt = file.name?.endsWith(".webm") ? "webm" : "mkv";
  const inputName = `input-${Date.now()}.${inputExt}`;
  const outputFormat = "matroska";
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
    "-f", outputFormat,
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

// Backward-compatible alias
export const remuxMkvToMp4 = remuxMkv;

