import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inspectMatroska, browserSupportFor } from "./mkv-inspect.js";
import { remuxMkv, terminateLibav } from "./client-remux.js";
import "./poc.css";

const MODE = {
  IDLE: "IDLE",
  INSPECTING: "INSPECTING",
  DIRECT: "CLIENT-SIDE DIRECT PLAYBACK",
  REMUX: "CLIENT-SIDE DEMUX/REMUX",
  WASM: "CLIENT-SIDE WASM PROCESSING",
  FAILED: "PLAYBACK FAILED"
};

const BACKEND_PLAYBACK_PATTERN = /\/api\/(stream|home|detail|providers|search)/i;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export default function ClientPlaybackPoc() {
  const videoRef = useRef(null);
  const objectUrlsRef = useRef([]);

  const [mode, setMode] = useState(MODE.IDLE);
  const [log, setLog] = useState([]);
  const [inspection, setInspection] = useState(null);
  const [support, setSupport] = useState(null);
  const [source, setSource] = useState(null);
  const [audioIndex, setAudioIndex] = useState(0);
  const [remuxInfo, setRemuxInfo] = useState(null);
  const [error, setError] = useState(null);
  const [requests, setRequests] = useState([]);
  const [status, setStatus] = useState({ playing: false, currentTime: 0, duration: 0, readyState: 0, error: null });
  const [seekTest, setSeekTest] = useState(null);
  const [switchTest, setSwitchTest] = useState(null);

  const appendLog = useCallback((message) => {
    const stamp = new Date().toLocaleTimeString();
    setLog((prev) => [...prev.slice(-199), `${stamp}  ${message}`]);
  }, []);

  // Record every network request this route makes so the report can prove whether the old
  // backend playback pipeline was touched.
  useEffect(() => {
    const originalFetch = window.fetch;
    const record = (url, via) => {
      const text = String(url);
      if (!/^https?:|^\//.test(text)) return;
      setRequests((prev) => {
        if (prev.some((entry) => entry.url === text && entry.via === via)) return prev;
        return [...prev, { url: text, via, backend: BACKEND_PLAYBACK_PATTERN.test(text) }].slice(-50);
      });
    };
    window.fetch = function patchedFetch(input, init) {
      record(typeof input === "string" ? input : input?.url, "fetch");
      return originalFetch.call(this, input, init);
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      record(url, "xhr");
      return originalOpen.call(this, method, url, ...rest);
    };
    return () => {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const onTime = () => setStatus((prev) => ({ ...prev, currentTime: video.currentTime, duration: video.duration || prev.duration }));
    const onPlay = () => setStatus((prev) => ({ ...prev, playing: true }));
    const onPause = () => setStatus((prev) => ({ ...prev, playing: false }));
    const onMeta = () => setStatus((prev) => ({ ...prev, duration: video.duration || 0, readyState: video.readyState }));
    const onError = () =>
      setStatus((prev) => ({ ...prev, error: video.error ? `code ${video.error.code}: ${video.error.message || "media error"}` : "unknown media error" }));
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onError);
    };
  }, []);

  useEffect(() => () => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    terminateLibav();
  }, []);

  const trackObjectUrl = (url) => {
    objectUrlsRef.current.push(url);
    return url;
  };

  const tryNativePlayback = useCallback((blob, label) =>
    new Promise((resolve) => {
      const video = videoRef.current;
      const url = trackObjectUrl(URL.createObjectURL(blob));
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onOk);
        video.removeEventListener("error", onErr);
        clearTimeout(timer);
      };
      const onOk = () => {
        cleanup();
        resolve({ ok: true, url });
      };
      const onErr = () => {
        cleanup();
        resolve({ ok: false, url, error: video.error ? `code ${video.error.code}` : "media error" });
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, url, error: "timed out waiting for metadata" });
      }, 8000);
      video.addEventListener("loadedmetadata", onOk);
      video.addEventListener("error", onErr);
      appendLog(`probing browser native playback: ${label}`);
      video.src = url;
      video.load();
    }), [appendLog]);

  const runClientRemux = useCallback(
    async (file, index, { preserveTime = 0, transcodeAudio = false, label = file.name } = {}) => {
      setMode(transcodeAudio ? MODE.WASM : MODE.REMUX);
      setError(null);
      try {
        const result = await remuxMkv(file, {
          audioTrackIndex: index,
          transcodeAudio,
          onLog: appendLog
        });
        trackObjectUrl(result.url);
        setRemuxInfo({
          sizeBytes: result.sizeBytes,
          elapsedMs: Math.round(result.elapsedMs),
          audioTrackIndex: index,
          args: result.args?.join(" ") ?? null,
          isTranscode: transcodeAudio
        });
        const video = videoRef.current;
        const restore = preserveTime > 0 ? preserveTime : 0;
        const applyTime = () => {
          if (restore > 0 && Number.isFinite(video.duration) && restore < video.duration) {
            video.currentTime = restore;
            appendLog(`restored playback position ${formatTime(restore)} after track switch`);
          }
        };
        video.addEventListener("loadedmetadata", applyTime, { once: true });
        video.src = result.url;
        video.load();
        await video.play().catch((playError) => appendLog(`autoplay note: ${playError.message}`));
        setMode(transcodeAudio ? MODE.WASM : MODE.REMUX);
        appendLog(`client-side ${transcodeAudio ? "WASM audio transcode" : "demux/remux"} playback active (${label}, audio track ${index})`);
        return true;
      } catch (remuxError) {
        setError(`Client-side remux failed: ${remuxError.message}`);
        setMode(MODE.FAILED);
        appendLog(`remux error: ${remuxError.message}`);
        return false;
      }
    },
    [appendLog]
  );

  const handleFile = useCallback(
    async (file, { via = "local file", forceRemux = false } = {}) => {
      if (!file) return;
      setError(null);
      setRemuxInfo(null);
      setInspection(null);
      setSupport(null);
      setSeekTest(null);
      setSwitchTest(null);
      setAudioIndex(0);
      setMode(MODE.INSPECTING);
      setSource({ file, name: file.name, size: file.size, type: file.type || "unknown", via });
      appendLog(`source selected (${via}): ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

      try {
        const result = await inspectMatroska(file);
        setInspection(result);
        const verdict = browserSupportFor(result);
        setSupport(verdict);
        appendLog(
          `client-side inspection: container=${result.container}, video=${result.video?.codec ?? "?"} ${result.video?.width ?? "?"}x${result.video?.height ?? "?"}, audio tracks=${result.audioTracks.length}, duration=${result.durationSeconds ? formatTime(result.durationSeconds) : "unknown"}`
        );
        for (const track of result.audioTracks) {
          appendLog(`  audio #${track.number}: ${track.codecId} / ${track.codec ?? "?"} (${track.language ?? "und"}) ${track.channels ?? "?"}ch`);
        }
      } catch (inspectError) {
        appendLog(`inspection failed: ${inspectError.message}`);
      }

      if (!forceRemux) {
        const native = await tryNativePlayback(file, file.name);
        if (native.ok) {
          setMode(MODE.DIRECT);
          appendLog("native <video> playback succeeded — running CLIENT-SIDE DIRECT PLAYBACK");
          return;
        }
        appendLog(`native direct playback not possible (${native.error}), falling back to client-side demux/remux`);
      }

      await runClientRemux(file, 0, { label: file.name, transcodeAudio: false });
    },
    [appendLog, runClientRemux, tryNativePlayback]
  );

  const handleUrl = useCallback(async () => {
    const input = document.getElementById("poc-url");
    const url = input?.value?.trim();
    if (!url) return;
    appendLog(`fetching user-provided direct URL in the browser: ${url.slice(0, 120)}`);
    setMode(MODE.INSPECTING);
    try {
      const response = await fetch(url, { mode: "cors" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = new Blob([await response.arrayBuffer()], { type: response.headers.get("content-type") ?? "video/x-matroska" });
      const name = url.split("/").pop()?.split("?")[0] || "remote.mkv";
      const file = new File([blob], name, { type: blob.type });
      await handleFile(file, { via: `direct URL (${new URL(url).host})` });
    } catch (fetchError) {
      setError(`Could not fetch the URL in the browser: ${fetchError.message}. A CORS restriction or expired token is the typical cause; the backend was NOT contacted.`);
      setMode(MODE.FAILED);
      appendLog(`direct URL error: ${fetchError.message}`);
    }
  }, [appendLog, handleFile]);

  const loadFixture = useCallback(
    async (path, name) => {
      appendLog(`loading sample fixture in browser: ${name} from ${path}`);
      setMode(MODE.INSPECTING);
      try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const file = new File([blob], name, { type: "video/x-matroska" });
        await handleFile(file, { via: `sample fixture (${name})` });
      } catch (err) {
        setError(`Failed to load sample fixture: ${err.message}`);
        setMode(MODE.FAILED);
        appendLog(`sample error: ${err.message}`);
      }
    },
    [appendLog, handleFile]
  );

  const switchAudioTrack = useCallback(
    async (index) => {
      if (!source || index === audioIndex) return;
      const video = videoRef.current;
      const current = video?.currentTime ?? 0;
      const before = current;
      appendLog(`switching audio track ${audioIndex} → ${index} at ${formatTime(current)}`);
      setAudioIndex(index);
      const file = source.file;
      if (!file) {
        appendLog("audio switching requires an acquired file source");
        return;
      }
      const ok = await runClientRemux(file, index, { preserveTime: current, label: source.name, transcodeAudio: false });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const after = videoRef.current?.currentTime ?? 0;
      setSwitchTest({
        from: audioIndex,
        to: index,
        timeBefore: Number(before.toFixed(2)),
        timeAfter: Number(after.toFixed(2)),
        preserved: Math.abs(after - before) < 3,
        ok
      });
    },
    [appendLog, audioIndex, source, runClientRemux]
  );

  const forceWasmTranscode = useCallback(async () => {
    if (!source?.file) return;
    const current = videoRef.current?.currentTime ?? 0;
    appendLog(`triggering WASM audio transcoding at ${formatTime(current)}`);
    await runClientRemux(source.file, audioIndex, { preserveTime: current, transcodeAudio: true, label: source.name });
  }, [appendLog, audioIndex, runClientRemux, source]);

  const forceDirectPlayback = useCallback(async () => {
    if (!source?.file) return;
    appendLog("forcing CLIENT-SIDE DIRECT PLAYBACK mode");
    const native = await tryNativePlayback(source.file, source.name);
    if (native.ok) {
      setMode(MODE.DIRECT);
      setRemuxInfo(null);
      videoRef.current.play().catch(() => {});
    } else {
      setError(`Native direct playback failed: ${native.error}`);
      setMode(MODE.FAILED);
    }
  }, [appendLog, source, tryNativePlayback]);

  const handleSeek = useCallback(() => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const target = Math.min(video.duration * 0.5, Math.max(2, video.duration / 2));
    video.currentTime = target;
    setSeekTest({ target: Number(target.toFixed(2)), applied: null });
    setTimeout(() => {
      const actual = videoRef.current?.currentTime ?? 0;
      setSeekTest({ target: Number(target.toFixed(2)), applied: Number(actual.toFixed(2)), ok: Math.abs(actual - target) < 2 });
    }, 1200);
  }, []);

  const backendRequests = useMemo(() => requests.filter((entry) => entry.backend), [requests]);
  const modeClass =
    mode === MODE.FAILED
      ? "poc-mode poc-mode-failed"
      : mode === MODE.DIRECT
      ? "poc-mode poc-mode-direct"
      : mode === MODE.WASM
      ? "poc-mode poc-mode-wasm"
      : "poc-mode poc-mode-client";

  return (
    <div className="poc">
      <header className="poc-header">
        <h1>Client-Side MKV Playback PoC</h1>
        <p className="poc-sub">
          Isolated experimental route. Video playback, Matroska demuxing, and dual-audio processing run{" "}
          <strong>entirely in the user's browser</strong> — the server FFmpeg/HLS pipeline is never invoked from this page.
        </p>
        <div className={modeClass}>{mode}</div>
      </header>

      <section className="poc-panel">
        <h2>1. Source Acquisition</h2>
        <div className="poc-row">
          <label className="poc-file">
            <input
              type="file"
              accept=".mkv,.webm,video/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) handleFile(file, { via: "local file" });
              }}
            />
            <span>Choose local MKV/WebM</span>
          </label>
          <button type="button" onClick={() => loadFixture("/fixtures/multi-audio.mkv", "multi-audio.mkv")}>
            Sample Dual-Audio (5s, 94 KB)
          </button>
          <button type="button" onClick={() => loadFixture("/fixtures/multi-audio-test.mkv", "multi-audio-test.mkv")}>
            Sample Dual-Audio (45s, 3.1 MB)
          </button>
        </div>
        <div className="poc-row" style={{ marginTop: "0.75rem" }}>
          <div className="poc-urlrow">
            <input id="poc-url" type="url" placeholder="https://… direct media URL (must permit browser CORS)" />
            <button type="button" onClick={handleUrl}>
              Fetch &amp; Inspect in Browser
            </button>
          </div>
        </div>
        <p className="poc-note">
          <strong>Source acquisition separation:</strong> Real provider scraping runs client-side via MovieBox with CORS proxying. This player tests the
          playback and dual-audio pipeline in isolation using client-side file/URL acquisition.
        </p>
      </section>

      {source && (
        <section className="poc-panel">
          <h2>2. Detected Source (Inspected in Browser EBML Parser)</h2>
          <dl className="poc-grid">
            <dt>Source</dt>
            <dd>
              {source.name} · {(source.size / 1024 / 1024).toFixed(2)} MB · {source.type} · {source.via}
            </dd>
            <dt>Container</dt>
            <dd>
              {inspection?.container ?? "—"}{" "}
              {inspection?.durationSeconds ? `· duration ${formatTime(inspection.durationSeconds)}` : ""}
            </dd>
            <dt>Video Track</dt>
            <dd>
              {inspection?.video
                ? `${inspection.video.codecId} (${inspection.video.codec}) · ${inspection.video.width ?? "?"}x${
                    inspection.video.height ?? "?"
                  } · suitability: ${inspection.video.browser}`
                : "—"}
            </dd>
            <dt>Audio Tracks ({inspection?.audioTracks?.length ?? 0})</dt>
            <dd>
              {inspection?.audioTracks?.length
                ? inspection.audioTracks
                    .map(
                      (t, i) =>
                        `#${i} [${t.language ?? "und"}] ${t.codec} (${t.channels ? `${t.channels}ch` : ""}${
                          t.name ? ` "${t.name}"` : ""
                        })`
                    )
                    .join("  |  ")
                : "—"}
            </dd>
            <dt>Browser Compatibility</dt>
            <dd>{support ? `${support.verdict} — ${support.reasons.join("; ")}` : "—"}</dd>
          </dl>
        </section>
      )}

      <section className="poc-panel">
        <h2>3. Experimental Client-Side Player</h2>
        <video ref={videoRef} className="poc-video" controls playsInline />
        <div className="poc-controls">
          <button type="button" onClick={() => videoRef.current?.play()}>
            Play
          </button>
          <button type="button" onClick={() => videoRef.current?.pause()}>
            Pause
          </button>
          <button type="button" onClick={handleSeek} disabled={!status.duration}>
            Seek 50%
          </button>
          <span className="poc-time">
            {formatTime(status.currentTime)} / {formatTime(status.duration)}
          </span>
          <label className="poc-select">
            <span>Audio Track:</span>
            <select
              value={audioIndex}
              onChange={(event) => switchAudioTrack(Number(event.target.value))}
              disabled={!inspection?.audioTracks?.length}
            >
              {(inspection?.audioTracks ?? []).map((track, index) => (
                <option key={track.number ?? index} value={index}>
                  Track {index}: {track.language ? `[${track.language}]` : ""} {track.name ?? track.codec}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={forceDirectPlayback} disabled={!source}>
            Direct Native Mode
          </button>
          <button
            type="button"
            onClick={() => source?.file && runClientRemux(source.file, audioIndex, { preserveTime: videoRef.current?.currentTime ?? 0, transcodeAudio: false })}
            disabled={!source}
          >
            Remux Stream Copy
          </button>
          <button type="button" onClick={forceWasmTranscode} disabled={!source}>
            WASM Audio Transcode
          </button>
        </div>
        <ul className="poc-facts">
          <li>Playback Pipeline Mode: <strong>{mode}</strong></li>
          <li>Video State: readyState={status.readyState}, playing={String(status.playing)}, error={status.error ?? "none"}</li>
          {remuxInfo && (
            <li>
              Client Processing: {remuxInfo.isTranscode ? "WASM Audio Transcode" : "Stream Copy Demux/Remux"} ·{" "}
              {(remuxInfo.sizeBytes / 1024 / 1024).toFixed(2)} MB output in {remuxInfo.elapsedMs}ms (WASM FFmpeg core)
            </li>
          )}
          {seekTest && (
            <li>
              Seek verification: target={seekTest.target}s → actual={seekTest.applied ?? "…"}{" "}
              {seekTest.ok === true ? "✅ (seeking works client-side)" : seekTest.ok === false ? "❌ (seek failed)" : ""}
            </li>
          )}
          {switchTest && (
            <li>
              Audio switch verification: Track #{switchTest.from} → #{switchTest.to} at {switchTest.timeBefore}s →{" "}
              {switchTest.timeAfter}s · {switchTest.preserved ? "✅ Timestamp preserved" : "⚠️ Timestamp jumped"}
            </li>
          )}
        </ul>
        {error && <p className="poc-error">{error}</p>}
      </section>

      <section className="poc-panel">
        <h2>4. Backend Isolation Proof</h2>
        <p className={backendRequests.length === 0 ? "poc-ok" : "poc-error"}>
          {backendRequests.length === 0
            ? "✅ Disconnected: 0 backend playback/transcoding endpoints were contacted by this page (no /api/stream, /api/home, /api/detail, /api/providers, /api/search)."
            : `❌ VIOLATION: this page contacted ${backendRequests.length} backend playback endpoint(s): ${backendRequests.map((entry) => entry.url).join(", ")}`}
        </p>
        <details>
          <summary>Network requests monitored on this page ({requests.length})</summary>
          <ul className="poc-requests">
            {requests.map((entry, index) => (
              <li key={`${entry.url}-${index}`}>
                [{entry.via}] {entry.url} {entry.backend ? "⚠️ BACKEND PLAYBACK ENDPOINT" : "✓"}
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section className="poc-panel">
        <h2>5. Real-Time Client Diagnostics Log</h2>
        <pre className="poc-log">{log.join("\n")}</pre>
      </section>
    </div>
  );
}

