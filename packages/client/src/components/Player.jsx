import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createStream } from "../api.js";
import { audioTrackLabel } from "../lib/languages.js";
import {
  AUTO_QUALITY,
  applyQuality,
  buildQualityOptions,
  currentQualityValue,
  explainQuality
} from "../lib/quality.js";
import { progressStore, clampPosition } from "../lib/progress.js";
import { inspectMatroska, browserSupportFor } from "../poc/mkv-inspect.js";
import { remuxMkv, remuxMkvToMp4, inspectMkvSource, terminateLibav } from "../poc/client-remux.js";
import { probeMediaSource, detectFormatFromUrl } from "../lib/source-detector.js";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_DELAY_MS = 3000;
const SAVE_INTERVAL_MS = 5000;

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

function buildEpisodeQueue(item) {
  const episodes = Array.isArray(item?.episodes) ? item.episodes : [];
  if (item?.type !== "series" || episodes.length === 0) return [];
  return episodes
    .filter((ep) => ep.season != null && ep.episode != null)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

export default function Player({ item, onClose, onProgress }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const hlsRef = useRef(null);
  const dashRef = useRef(null);
  const hideTimerRef = useRef(null);
  const saveTimerRef = useRef(0);
  const currentRef = useRef(item);
  const lastSavedRef = useRef(null);
  const savedResumeRef = useRef(null);
  const resumeAppliedRef = useRef(false);
  const activeBlobRef = useRef(null);
  const activeBlobUrlRef = useRef(null);
  const switchingLockRef = useRef(false);
  const activeMediaUrlRef = useRef(null);
  const activeConversionRef = useRef(null);
  const streamHeadersRef = useRef({});
  const operationIdRef = useRef(0);

  const [current, setCurrent] = useState(item);
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
  const [levels, setLevels] = useState([]);
  const [activeLevel, setActiveLevel] = useState(AUTO_QUALITY);
  const [preferredLang, setPreferredLang] = useState(() => localStorage.getItem("streamix.lang") || "");
  const [fullscreen, setFullscreen] = useState(false);
  const [sourceNote, setSourceNote] = useState(null);
  const [sourceStatus, setSourceStatus] = useState(null);
  const [sourceProvider, setSourceProvider] = useState(null);
  const [playbackMode, setPlaybackMode] = useState("direct");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [resumedFrom, setResumedFrom] = useState(null);
  const [ended, setEnded] = useState(false);
  const [switching, setSwitching] = useState(false);

  const queue = useMemo(() => buildEpisodeQueue(current), [current]);
  const queueIndex = useMemo(() => {
    if (queue.length === 0 || current.season == null || current.episode == null) return -1;
    return queue.findIndex((ep) => ep.season === current.season && ep.episode === current.episode);
  }, [queue, current.season, current.episode]);
  const nextEpisode = queueIndex >= 0 ? queue[queueIndex + 1] ?? null : null;

  const progressEntry = useCallback(
    (position, dur) => ({
      key: undefined,
      provider: current.provider ?? "default",
      type: current.type,
      id: current.id,
      title: current.title,
      poster: current.poster ?? null,
      backdrop: current.backdrop ?? null,
      season: current.season ?? null,
      episode: current.episode ?? null,
      episodeTitle: current.episodeTitle ?? null,
      position,
      duration: dur
    }),
    [current]
  );

  const persist = useCallback(
    (positionOverride, durationOverride) => {
      const video = videoRef.current;
      const dur = Number.isFinite(durationOverride) ? durationOverride : video?.duration;
      const pos = Number.isFinite(positionOverride) ? positionOverride : video?.currentTime;
      if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(pos)) return;
      const entry = progressStore.save(progressEntry(pos, dur));
      lastSavedRef.current = entry;
      onProgress?.();
    },
    [progressEntry, onProgress]
  );

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  const bumpControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      const video = videoRef.current;
      if (video && !video.paused) setControlsVisible(false);
    }, HIDE_DELAY_MS);
  }, []);

  const cleanupActiveMedia = useCallback(() => {
    if (activeConversionRef.current) {
      try {
        activeConversionRef.current.cancel();
      } catch {
        // ignore
      }
      activeConversionRef.current = null;
    }
    if (activeBlobUrlRef.current) {
      URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = null;
    }
    activeBlobRef.current = null;
    activeMediaUrlRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const playItem = current;
    const opId = ++operationIdRef.current;

    async function start() {
      setPhase("resolving");
      setError(null);
      setEnded(false);
      setResumedFrom(null);
      cleanupActiveMedia();

      try {
        const hasExplicitDirectStream =
          Boolean(playItem.streamUrl) ||
          Boolean(playItem.mediaUrl) ||
          Boolean(playItem.url) ||
          (Boolean(playItem.sourceUrl) &&
            !playItem.sourceUrl.endsWith(".json") &&
            !playItem.sourceUrl.includes("/meta/"));

        const stream = await createStream(playItem.type, playItem.id, {
          signal: controller.signal,
          lang: preferredLang || undefined,
          provider: playItem.provider,
          season: playItem.season,
          episode: playItem.episode,
          sourceUrl: hasExplicitDirectStream ? (playItem.streamUrl || playItem.mediaUrl || playItem.url || playItem.sourceUrl) : undefined,
          streamUrl: playItem.streamUrl || playItem.mediaUrl || playItem.url,
          mediaType: playItem.mediaType
        });

        if (cancelled || opId !== operationIdRef.current) return;

        setSourceNote(stream.note ?? null);
        setSourceStatus(stream.resolution?.status ?? null);
        setSourceProvider(stream.provider?.name ?? null);

        const video = videoRef.current;
        if (!video) return;

        streamHeadersRef.current = stream.headers || {};

        // Resume handling
        const saved = playItem.restart ? null : progressStore.get({
          provider: playItem.provider ?? "default",
          type: playItem.type,
          id: playItem.id,
          season: playItem.season ?? null,
          episode: playItem.episode ?? null
        });
        savedResumeRef.current = saved;
        resumeAppliedRef.current = false;

        const rawSourceUrl = stream.sourceUrl;

        if (!rawSourceUrl) {
          throw new Error("No playable media URL returned for this source");
        }

        // Probe media source to inspect response, status, content-type and initial bytes
        let probe = await probeMediaSource(rawSourceUrl, {
          signal: controller.signal,
          headers: stream.headers,
          declaredType: stream.mediaType
        });

        if (cancelled || opId !== operationIdRef.current) return;

        let sourceUrl = rawSourceUrl;

        // If direct fetch is blocked by CORS, use the secure backend media-proxy as transport layer
        if (probe.corsBlocked) {
          const proxiedUrl = stream.proxyUrl || `/api/stream/proxy?url=${encodeURIComponent(rawSourceUrl)}`;
          let proxyProbe;
          try {
            proxyProbe = await probeMediaSource(proxiedUrl, {
              signal: controller.signal,
              declaredType: stream.mediaType || probe.format
            });
          } catch (proxyErr) {
            if (proxyErr.name === "AbortError") throw proxyErr;
            throw new Error(`Media proxy connection failed: ${proxyErr.message}`);
          }

          if (proxyProbe.error && !proxyProbe.isPlayable) {
            // Preserve the proxy HTTP status and response message - do not swallow proxy failures
            throw new Error(proxyProbe.error);
          }

          sourceUrl = proxiedUrl;
          probe = proxyProbe;
        }

        if (probe.error && !probe.isPlayable && !probe.corsBlocked) {
          throw new Error(probe.error);
        }

        const mediaType = probe.format !== "unknown" ? probe.format : (stream.mediaType || detectFormatFromUrl(rawSourceUrl));

        // 1. HLS Streams (.m3u8)
        if (mediaType === "hls" || sourceUrl.includes(".m3u8")) {
          setPlaybackMode("hls");
          const hlsModule = await import("hls.js");
          const Hls = hlsModule.default;
          if (cancelled) return;

          if (!Hls.isSupported()) {
            if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = sourceUrl;
              video.addEventListener("loadedmetadata", () => setPhase("ready"), { once: true });
              return;
            }
            throw new Error("HLS playback is not supported in this browser");
          }

          const hls = new Hls({ enableWorker: true });
          hlsRef.current = hls;
          if (import.meta.env.DEV) window.__streamixHls = hls;
          hls.loadSource(sourceUrl);
          hls.attachMedia(video);

          const syncAudio = (applyPreference = false) => {
            const tracks = hls.audioTracks ?? [];
            setAudioTracks(tracks);
            if (applyPreference && preferredLang) {
              const match = tracks.find((t) => t.lang === preferredLang);
              if (match) hls.audioTrack = match.id;
            }
          };
          const syncLevels = () => {
            const list = hls.levels ?? [];
            setLevels(list);
            setActiveLevel(currentQualityValue(hls));
          };

          hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => syncAudio(true));
          hls.on(Hls.Events.LEVEL_SWITCHED, () => syncLevels());
          hls.on(Hls.Events.LEVEL_LOADED, () => syncLevels());
          hls.on(Hls.Events.LEVEL_UPDATED, () => syncLevels());
          hls.on(Hls.Events.LEVELS_UPDATED, () => syncLevels());
          hls.on(Hls.Events.MANIFEST_LOADED, () => syncLevels());

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            syncAudio(true);
            syncLevels();
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
                // destroyed
              }
            }
          });
          return;
        }

        // 2. DASH Streams (.mpd)
        if (mediaType === "dash" || sourceUrl.includes(".mpd")) {
          setPlaybackMode("dash");
          const { default: dashjs } = await import("dashjs");
          if (cancelled) return;

          const player = dashjs.MediaPlayer().create();
          dashRef.current = player;
          player.initialize(video, sourceUrl, true);

          player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
            if (cancelled) return;
            setPhase("ready");
            video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
          });

          player.on(dashjs.MediaPlayer.events.ERROR, (e) => {
            if (cancelled) return;
            setError(`DASH playback error: ${e.error?.message || e.type || "playback failed"}`);
            setPhase("error");
          });
          return;
        }

        // 3. Direct MP4 / WebM / Native Playback
        if (mediaType === "mp4" || mediaType === "webm") {
          const mimeType = mediaType === "mp4" ? "video/mp4" : "video/webm";
          if (!video.canPlayType(mimeType)) {
            throw new Error(`Browser cannot decode ${mediaType.toUpperCase()} format natively`);
          }

          setPlaybackMode("direct");
          setAudioTracks([]);
          setLevels(stream.variants ? stream.variants.map((v, i) => ({ height: v.height, index: i })) : []);

          video.src = sourceUrl;
          video.load();
          video.addEventListener(
            "loadedmetadata",
            () => {
              if (cancelled) return;
              setPhase("ready");
              video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
            },
            { once: true }
          );
          video.addEventListener(
            "error",
            () => {
              if (cancelled) return;
              setError(
                video.error
                  ? `Media error ${video.error.code}: ${video.error.message || "playback error"}`
                  : "Direct video playback failed"
              );
              setPhase("error");
            },
            { once: true }
          );
          return;
        }

        // 4. MKV / Matroska Sources -> Client-Side Range-Based Remuxing
        if (mediaType === "mkv") {
          setPlaybackMode("client-remux");
          if (probe.corsBlocked) {
            throw new Error(
              "Cannot play MKV in browser: media host blocks browser cross-origin requests (CORS). Client-side demuxing requires CORS access, and the backend proxy is offline. Start the backend server with 'npm run dev' to enable secure range-streaming."
            );
          }

          activeMediaUrlRef.current = sourceUrl;

          // Range-based inspection without downloading the entire file
          const inspection = await inspectMkvSource(sourceUrl, {
            signal: controller.signal,
            headers: stream.headers
          });

          if (cancelled || opId !== operationIdRef.current) return;

          if (!inspection.isSupported) {
            throw new Error(`Unsupported MKV format: ${inspection.unsupportedReasons.join("; ")}`);
          }

          const audioList = inspection.audioTracks || [];
          setAudioTracks(audioList);

          if (inspection.video?.height) {
            setLevels([{ height: inspection.video.height, index: 0 }]);
          }

          let startingTrackIdx = 0;
          if (preferredLang) {
            const prefIdx = audioList.findIndex((t) => t.isPlayable && t.language === preferredLang);
            if (prefIdx >= 0) startingTrackIdx = prefIdx;
          }
          if (audioList[startingTrackIdx] && !audioList[startingTrackIdx].isPlayable) {
            const firstPlayable = audioList.findIndex((t) => t.isPlayable);
            if (firstPlayable >= 0) startingTrackIdx = firstPlayable;
          }
          setActiveTrack(startingTrackIdx);

          // FastStart MP4 remuxing via Mediabunny stream-copy
          const remuxResult = await remuxMkvToMp4(sourceUrl, {
            audioTrackIndex: startingTrackIdx,
            signal: controller.signal,
            headers: stream.headers
          });
          if (cancelled || opId !== operationIdRef.current) return;

          activeBlobUrlRef.current = remuxResult.url;
          video.src = remuxResult.url;
          video.load();
          video.addEventListener(
            "loadedmetadata",
            () => {
              if (cancelled || opId !== operationIdRef.current) return;
              setPhase("ready");
              applySavedResume();
              video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
            },
            { once: true }
          );
          return;
        }

        // 5. Unknown or unsupported format
        throw new Error(
          probe.error || `Unsupported media format "${mediaType || 'unknown'}". Cannot play in browser.`
        );
      } catch (err) {
        if (cancelled || opId !== operationIdRef.current || err.name === "AbortError") return;
        setError(err.message || "Failed to resolve or play the stream");
        setPhase("error");
      }
    }

    start();

    return () => {
      cancelled = true;
      controller.abort();
      const video = videoRef.current;
      if (video) persist(video.currentTime, video.duration);
      try {
        hlsRef.current?.destroy();
      } catch {
        // already destroyed
      }
      hlsRef.current = null;
      try {
        dashRef.current?.reset();
      } catch {
        // already reset
      }
      dashRef.current = null;
      cleanupActiveMedia();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, attempt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      persist(video.currentTime, video.duration);
    };
    const onTime = () => {
      const now = video.currentTime || 0;
      setCurrentTime(now);
      try {
        if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));
      } catch {
        // ignore
      }
      const stamp = Date.now();
      if (now > 0 && stamp - saveTimerRef.current > SAVE_INTERVAL_MS) {
        saveTimerRef.current = stamp;
        persist(now, video.duration);
      }
    };
    const onMeta = () => setDuration(video.duration || 0);
    // EVENT playlists only report a real duration once segments are known, so resume is
    // applied on the first durationchange with a usable value (never beyond the real length).
    const applySavedResume = () => {
      const saved = savedResumeRef.current;
      if (!saved || resumeAppliedRef.current) return;
      const dur = Number(video.duration);
      if (!Number.isFinite(dur) || dur <= 0) return;
      // EVENT playlists grow while segments load, so only resume once the reported
      // duration can actually contain the saved position (never beyond the real length).
      if (dur <= saved.position + 10) return;
      resumeAppliedRef.current = true;
      const pos = clampPosition(saved.position, dur);
      if (pos > 5 && pos < dur - 5) {
        video.currentTime = pos;
        setResumedFrom(pos);
      }
    };
    const onDuration = () => {
      setDuration(video.duration || 0);
      applySavedResume();
    };
    const onSeeked = () => persist(video.currentTime, video.duration);
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onEnded = () => {
      setEnded(true);
      setPlaying(false);
      const dur = video.duration;
      if (dur > 0) {
        progressStore.save(progressEntry(dur, dur));
        onProgress?.();
      }
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("progress", onTime);
    video.addEventListener("durationchange", onDuration);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("loadeddata", applySavedResume);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("volumechange", onVolume);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("progress", onTime);
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("loadeddata", applySavedResume);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("volumechange", onVolume);
      video.removeEventListener("ended", onEnded);
    };
  }, [phase, persist, progressEntry, onProgress]);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().then(() => setPlaying(true)).catch(() => { });
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

  const selectAudio = useCallback(async (id) => {
    const trackNum = Number(id);
    if (hlsRef.current) {
      hlsRef.current.audioTrack = trackNum;
      setActiveTrack(trackNum);
      return;
    }

    if (playbackMode === "client-remux" && activeMediaUrlRef.current) {
      if (switchingLockRef.current) return;
      const targetTrack = audioTracks[trackNum];
      if (targetTrack && targetTrack.isPlayable === false) {
        setError(`Audio track "${targetTrack.name}" uses ${targetTrack.codec?.toUpperCase()}, which cannot be decoded in the browser.`);
        return;
      }
      switchingLockRef.current = true;
      setSwitching(true);
      const video = videoRef.current;
      const preserveTime = video ? video.currentTime : 0;
      try {
        const result = await remuxMkvToMp4(activeMediaUrlRef.current, {
          audioTrackIndex: trackNum,
          headers: streamHeadersRef.current
        });
        if (activeBlobUrlRef.current) {
          URL.revokeObjectURL(activeBlobUrlRef.current);
        }
        activeBlobUrlRef.current = result.url;
        setActiveTrack(trackNum);
        if (video) {
          video.src = result.url;
          video.load();
          video.addEventListener(
            "loadedmetadata",
            () => {
              if (preserveTime > 0 && Number.isFinite(video.duration) && preserveTime < video.duration) {
                video.currentTime = preserveTime;
              }
              video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
              setSwitching(false);
              switchingLockRef.current = false;
            },
            { once: true }
          );
        }
      } catch (err) {
        setError(`Audio switch failed: ${err.message}`);
        setSwitching(false);
        switchingLockRef.current = false;
      }
    }
  }, [playbackMode, audioTracks]);

  const selectQuality = useCallback((value) => {
    const hls = hlsRef.current;
    if (!hls) return;
    setActiveLevel(applyQuality(hls, value));
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    else el.requestFullscreen().catch(() => { });
    bumpControls();
  }, [bumpControls]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  const goToEpisode = useCallback(
    (ep) => {
      if (!ep) return;
      const video = videoRef.current;
      if (video) persist(video.currentTime, video.duration);
      setSwitching(true);
      setCurrent((prev) => ({
        ...prev,
        season: ep.season,
        episode: ep.episode,
        episodeTitle: ep.name ?? null,
        poster: ep.thumbnail ?? prev.poster
      }));
    },
    [persist]
  );

  useEffect(() => {
    if (switching) setSwitching(false);
  }, [current, switching]);

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
  const qualityInfo = buildQualityOptions(levels, activeLevel);
  const qualityNote = explainQuality(qualityInfo.realCount, qualityInfo.displayLabel);
  const qualityLabel =
    qualityInfo.single
      ? qualityInfo.displayLabel
      : activeLevel === AUTO_QUALITY
        ? "Auto"
        : (qualityInfo.real.find((level) => level.value === activeLevel)?.label ?? "Auto");
  const displayTitle =
    current.type === "series" && current.season != null && current.episode != null
      ? `${current.title} — S${current.season}E${current.episode}${current.episodeTitle ? ` · ${current.episodeTitle}` : ""}`
      : current.title;

  return (
    <div
      className={`player ${controlsVisible ? "controls-visible" : "controls-hidden"}`}
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${displayTitle}`}
      onMouseMove={bumpControls}
      onTouchStart={bumpControls}
    >
      <video ref={videoRef} className="player-video" playsInline onClick={togglePlay} onDoubleClick={toggleFullscreen} />

      {(phase === "resolving" || switching) && (
        <div className="player-center">
          <div className="player-spinner" role="status" aria-label="Loading stream" />
          <p className="player-center-text">Resolving stream and preparing playback...</p>
        </div>
      )}

      {phase === "error" && (
        <div className="player-center">
          <div className="player-error-panel" role="alert">
            <h2>Playback error</h2>
            <p>{error}</p>
            {error && (error.includes("Backend server") || error.includes("502") || error.includes("503") || error.includes("504") || error.includes("unreachable")) && (
              <div
                style={{
                  marginTop: "0.85rem",
                  padding: "0.75rem 1rem",
                  background: "rgba(59, 130, 246, 0.12)",
                  border: "1px solid rgba(59, 130, 246, 0.35)",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                  textAlign: "left",
                  lineHeight: "1.4"
                }}
              >
                <strong style={{ color: "#93c5fd" }}>Backend Server Offline (HTTP 502):</strong>
                <p style={{ margin: "0.3rem 0 0", color: "#cbd5e1" }}>
                  This title requires server-side stream resolution (VegaMovies scraping, Cloudflare anti-bot handling) and media proxying for CORS-restricted hosts. Direct browser playback works for CORS-enabled direct media sources (MP4, WebM, HLS, DASH). To stream this title, start the backend server with <code>npm run dev</code>.
                </p>
              </div>
            )}
            {error && error.includes("CORS") && !error.includes("502") && !error.includes("offline") && (
              <div
                style={{
                  marginTop: "0.85rem",
                  padding: "0.75rem 1rem",
                  background: "rgba(245, 158, 11, 0.12)",
                  border: "1px solid rgba(245, 158, 11, 0.35)",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                  textAlign: "left",
                  lineHeight: "1.4"
                }}
              >
                <strong style={{ color: "#fbbf24" }}>CORS Media Restriction:</strong>
                <p style={{ margin: "0.3rem 0 0", color: "#cbd5e1" }}>
                  The media host blocks direct browser cross-origin requests. Client-side MKV demuxing requires byte-range access. Start the backend server to enable secure local range-proxying.
                </p>
              </div>
            )}
            {error && (error.includes("Unsupported MKV format") || error.includes("E-AC-3") || error.includes("HEVC") || error.includes("codec")) && (
              <div
                style={{
                  marginTop: "0.85rem",
                  padding: "0.75rem 1rem",
                  background: "rgba(239, 68, 68, 0.12)",
                  border: "1px solid rgba(239, 68, 68, 0.35)",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                  textAlign: "left",
                  lineHeight: "1.4"
                }}
              >
                <strong style={{ color: "#fca5a5" }}>Unsupported Codec:</strong>
                <p style={{ margin: "0.3rem 0 0", color: "#cbd5e1" }}>
                  The media stream contains codecs (e.g. E-AC-3 Dolby Digital or HEVC/H.265) that your browser cannot decode natively. A proxy cannot alter media codecs without heavy server transcoding.
                </p>
              </div>
            )}
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
            <span className="player-title" title={displayTitle}>
              {displayTitle}
            </span>
            {sourceStatus === "fixture_fallback" && <span className="player-test-badge">TEST MODE</span>}
            {sourceStatus === "direct_stream" && <span className="player-live-badge" style={{ background: "#059669" }}>Client Direct</span>}
            {sourceStatus === "provider_stream" && (
              <span className="player-live-badge">{sourceProvider ? `Backend · ${sourceProvider}` : "Backend Resolved"}</span>
            )}
            {sourceNote && (
              <span className="player-source" title={sourceNote}>
                {sourceNote}
              </span>
            )}
          </div>

          {phase === "ready" && !playing && !ended && (
            <button type="button" className="player-big-play" onClick={togglePlay} aria-label="Play">
              <span className="player-big-play-icon" aria-hidden="true">
                ▶
              </span>
            </button>
          )}

          {phase === "ready" && (ended || resumedFrom) && (
            <div className="player-toast" role="status">
              {ended ? "Finished" : `Resumed from ${formatTime(resumedFrom)}`}
            </div>
          )}

          {ended && nextEpisode && (
            <div className="player-next-panel">
              <p>Up next: S{nextEpisode.season}E{nextEpisode.episode} {nextEpisode.name ? `· ${nextEpisode.name}` : ""}</p>
              <div className="player-error-actions">
                <button type="button" className="player-btn player-btn-primary" onClick={() => goToEpisode(nextEpisode)}>
                  Play Next
                </button>
                <button type="button" className="player-btn" onClick={() => setEnded(false)}>
                  Replay
                </button>
              </div>
            </div>
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

              {audioTracks.length > 0 && (
                <label className="player-select">
                  <span>Audio</span>
                  <select
                    value={activeTrack ?? audioTracks[0]?.id ?? ""}
                    onChange={(e) => selectAudio(e.target.value)}
                    aria-label="Audio track"
                  >
                    {audioTracks.map((track) => (
                      <option key={track.id} value={track.id}>
                        {audioTrackLabel(track)}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {qualityInfo.single ? (
                <span className="player-quality-static" title={qualityNote ?? "Single quality source"}>
                  <span className="player-quality-label">Quality</span>
                  <span className="player-quality-value">{qualityLabel}</span>
                </span>
              ) : (
                <label className="player-select" title={qualityNote ?? "Choose video quality"}>
                  <span>Quality</span>
                  <select
                    value={activeLevel}
                    onChange={(e) => selectQuality(e.target.value)}
                    aria-label="Video quality"
                  >
                    {qualityInfo.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value === AUTO_QUALITY ? "Auto" : option.label}
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

              {current.type === "series" && nextEpisode && (
                <button
                  type="button"
                  className="player-btn"
                  onClick={() => goToEpisode(nextEpisode)}
                  aria-label={`Play next episode S${nextEpisode.season}E${nextEpisode.episode}`}
                >
                  Next ⏭
                </button>
              )}

              <button
                type="button"
                className="player-btn"
                onClick={toggleFullscreen}
                aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              >
                {fullscreen ? "⤢ Exit" : "⤢ Full"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
