import { useEffect, useRef, useState, useCallback } from "react";
import { createStream, cleanupStream } from "../api.js";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_DELAY_MS = 3000;

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target.isContentEditable;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function Player({ item, onClose }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const hlsRef = useRef(null);
  const sessionRef = useRef(null);
  const hideTimerRef = useRef(null);

  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState("resolving");
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [audioTracks, setAudioTracks] = useState([]);
  const [activeTrack, setActiveTrack] = useState(null);
  const [availableLangs, setAvailableLangs] = useState([]);
  const [preferredLang, setPreferredLang] = useState(() => localStorage.getItem("streamix.lang") || "");
  const [fullscreen, setFullscreen] = useState(false);
  const [sourceNote, setSourceNote] = useState(null);
  const [sourceStatus, setSourceStatus] = useState(null);
  const [sourceProvider, setSourceProvider] = useState(null);
  const [controlsVisible, setControlsVisible] = useState(true);

  const bumpControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      const video = videoRef.current;
      if (video && !video.paused) setControlsVisible(false);
    }, HIDE_DELAY_MS);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function start() {
      setPhase("resolving");
      setError(null);
      try {
        const [stream, hlsModule] = await Promise.all([
          createStream(item.type, item.id, {
            signal: controller.signal,
            lang: preferredLang || undefined,
            provider: item.provider
          }),
          import("hls.js")
        ]);
        const Hls = hlsModule.default;
        if (cancelled) {
          cleanupStream(stream.sessionId);
          return;
        }
        sessionRef.current = stream.sessionId;
        setSourceNote(stream.note ?? null);
        setSourceStatus(stream.resolution?.status ?? null);
        setSourceProvider(stream.provider?.name ?? null);

        const video = videoRef.current;
        if (!video) return;

        if (!Hls.isSupported()) {
          if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = stream.playlistUrl;
            video.addEventListener("loadedmetadata", () => setPhase("ready"), { once: true });
            return;
          }
          throw new Error("HLS playback is not supported in this browser");
        }

        const hls = new Hls({ enableWorker: true });
        hlsRef.current = hls;
        if (import.meta.env.DEV) window.__streamixHls = hls;
        hls.loadSource(stream.playlistUrl);
        hls.attachMedia(video);

        const syncAudioTracks = (applyPreference = false) => {
          const tracks = hls.audioTracks ?? [];
          setAudioTracks(tracks);
          setAvailableLangs(Array.from(new Set(tracks.map((t) => t.lang).filter(Boolean))));
          if (applyPreference && preferredLang) {
            const match = tracks.find((t) => t.lang === preferredLang);
            if (match) hls.audioTrack = match.id;
          }
        };

        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => syncAudioTracks(true));

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) return;
          syncAudioTracks(true);
          setPhase("ready");
          video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
        });

        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => setActiveTrack(data.id));

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled) return;
          if (data.fatal) {
            setError(`Playback failed: ${data.details ?? data.type}`);
            setPhase("error");
            try {
              hls.destroy();
            } catch {
              // already destroyed
            }
          }
        });
      } catch (err) {
        if (cancelled || err.name === "AbortError") return;
        setError(err.message || "Failed to resolve the stream");
        setPhase("error");
      }
    }

    start();

    return () => {
      cancelled = true;
      controller.abort();
      try {
        hlsRef.current?.destroy();
      } catch {
        // already destroyed
      }
      hlsRef.current = null;
      if (sessionRef.current) cleanupStream(sessionRef.current);
      sessionRef.current = null;
    };
  }, [item, attempt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => {
      setCurrentTime(video.currentTime || 0);
      try {
        if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));
      } catch {
        // ignore
      }
    };
    const onMeta = () => setDuration(video.duration || 0);
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("progress", onTime);
    video.addEventListener("durationchange", onMeta);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("volumechange", onVolume);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("progress", onTime);
      video.removeEventListener("durationchange", onMeta);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("volumechange", onVolume);
    };
  }, [phase]);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().then(() => setPlaying(true)).catch(() => {});
    else {
      video.pause();
      setPlaying(false);
    }
    bumpControls();
  }, [bumpControls]);

  const skip = useCallback(
    (seconds) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
      bumpControls();
    },
    [bumpControls]
  );

  const seekTo = useCallback(
    (value) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Number(value);
      setCurrentTime(Number(value));
      bumpControls();
    },
    [bumpControls]
  );

  const changeVolume = useCallback((value) => {
    const video = videoRef.current;
    if (!video) return;
    const v = Number(value);
    video.volume = v;
    video.muted = v === 0;
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    bumpControls();
  }, [bumpControls]);

  const changeRate = useCallback((value) => {
    const video = videoRef.current;
    const r = Number(value);
    if (video) video.playbackRate = r;
    setRate(r);
  }, []);

  const selectAudio = useCallback((id) => {
    if (!hlsRef.current) return;
    hlsRef.current.audioTrack = Number(id);
    setActiveTrack(Number(id));
  }, []);

  const setLanguagePreference = useCallback((lang) => {
    setPreferredLang(lang);
    if (lang) localStorage.setItem("streamix.lang", lang);
    else localStorage.removeItem("streamix.lang");
    const hls = hlsRef.current;
    const match = hls?.audioTracks?.find((t) => t.lang === lang);
    if (match) hls.audioTrack = match.id;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
    bumpControls();
  }, [bumpControls]);

  const retry = useCallback(() => {
    if (sessionRef.current) cleanupStream(sessionRef.current);
    sessionRef.current = null;
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (isEditableTarget(e.target)) return;
      const tag = e.target instanceof HTMLElement ? e.target.tagName : "";
      if ((e.code === "Space" || e.key.toLowerCase() === "k") && tag !== "BUTTON") {
        e.preventDefault();
        togglePlay();
      }
      if (e.key === "ArrowLeft") skip(-10);
      if (e.key === "ArrowRight") skip(10);
      if (e.key.toLowerCase() === "m") toggleMute();
      if (e.key.toLowerCase() === "f") toggleFullscreen();
      bumpControls();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, togglePlay, skip, toggleMute, toggleFullscreen, bumpControls]);

  useEffect(() => {
    bumpControls();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [bumpControls]);

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;

  return (
    <div
      className={`player ${controlsVisible ? "controls-visible" : "controls-hidden"}`}
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${item.title}`}
      onMouseMove={bumpControls}
      onTouchStart={bumpControls}
    >
      <video
        ref={videoRef}
        className="player-video"
        playsInline
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      />

      {phase === "resolving" && (
        <div className="player-center">
          <div className="player-spinner" role="status" aria-label="Loading stream" />
          <p className="player-center-text">Resolving stream and preparing HLS...</p>
        </div>
      )}

      {phase === "error" && (
        <div className="player-center">
          <div className="player-error-panel" role="alert">
            <h2>Playback error</h2>
            <p>{error}</p>
            <div className="player-error-actions">
              <button type="button" className="player-btn player-btn-primary" onClick={retry}>
                Retry
              </button>
              <button type="button" className="player-btn" onClick={onClose}>
                Back
              </button>
            </div>
          </div>
        </div>
      )}

      {(phase === "ready" || controlsVisible) && (
        <>
          <div className="player-top" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="player-btn player-back" onClick={onClose} aria-label="Back to details">
              ‹ Back
            </button>
            <span className="player-title" title={item.title}>{item.title}</span>
            {sourceStatus === "fixture_fallback" && <span className="player-test-badge">TEST MODE</span>}
            {sourceStatus === "provider_stream" && (
              <span className="player-live-badge">{sourceProvider ? `Real source · ${sourceProvider}` : "Real source"}</span>
            )}
            {sourceNote && (
              <span className="player-source" title={sourceNote}>
                {sourceNote}
              </span>
            )}
          </div>

          {phase === "ready" && !playing && (
            <button type="button" className="player-big-play" onClick={togglePlay} aria-label="Play">
              <span className="player-big-play-icon" aria-hidden="true">▶</span>
            </button>
          )}

          <div className="player-bottom" onClick={(e) => e.stopPropagation()}>
            <div className="player-timeline">
              <input
                type="range"
                className="player-seek"
                min="0"
                max={duration || 0}
                step="0.1"
                value={Math.min(currentTime, duration || 0)}
                onChange={(e) => seekTo(e.target.value)}
                aria-label="Seek"
                style={{ "--played": `${progress}%`, "--buffered": `${bufferedPct}%` }}
              />
              <div className="player-time">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            <div className="player-controls">
              <button type="button" className="player-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                {playing ? "❚❚" : "▶"}
              </button>
              <button type="button" className="player-btn" onClick={() => skip(-10)} aria-label="Seek back 10 seconds">
                ⟲ 10
              </button>
              <button type="button" className="player-btn" onClick={() => skip(10)} aria-label="Seek forward 10 seconds">
                10 ⟳
              </button>

              <div className="player-volume">
                <button type="button" className="player-btn" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>
                  {muted || volume === 0 ? "🔇" : "🔊"}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={muted ? 0 : volume}
                  onChange={(e) => changeVolume(e.target.value)}
                  aria-label="Volume"
                  style={{ "--played": `${(muted ? 0 : volume) * 100}%` }}
                />
              </div>

              <div className="player-spacer" />

              {audioTracks.length > 0 ? (
                <label className="player-select">
                  <span>Audio</span>
                  <select
                    value={activeTrack ?? audioTracks[0]?.id ?? ""}
                    onChange={(e) => selectAudio(e.target.value)}
                    aria-label="Audio track"
                  >
                    {audioTracks.map((track) => (
                      <option key={track.id} value={track.id}>
                        {track.name}
                        {track.lang && !new RegExp(`\\b${track.lang}\\b`, "i").test(track.name) ? ` (${track.lang})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                phase === "ready" && <span className="player-note-muted">No audio tracks</span>
              )}

              {availableLangs.length > 1 && (
                <label className="player-select">
                  <span>Lang</span>
                  <select value={preferredLang} onChange={(e) => setLanguagePreference(e.target.value)} aria-label="Preferred audio language">
                    <option value="">Default</option>
                    {availableLangs.map((lang) => (
                      <option key={lang} value={lang}>
                        {lang}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="player-select">
                <span>Speed</span>
                <select value={rate} onChange={(e) => changeRate(e.target.value)} aria-label="Playback speed">
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
              </label>

              <button type="button" className="player-btn" onClick={toggleFullscreen} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
                {fullscreen ? "⤢ Exit" : "⤢ Full"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
