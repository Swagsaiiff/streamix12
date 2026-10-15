import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createStream } from "../api.js";
import { discoverClientStream } from "../lib/client-provider.js";
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
import { movieboxResolveStreams, movieboxGetDetails } from "../lib/moviebox/index.js";
import { buildWebEmbedUrl } from "../lib/source-providers/moviebox-source-provider.js";

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
  const [streamQualities, setStreamQualities] = useState([]);
  const [activeQualityLabel, setActiveQualityLabel] = useState(null);
  const [subtitles, setSubtitles] = useState([]);
  const [activeSubtitle, setActiveSubtitle] = useState("off");
  const [preferredLang, setPreferredLang] = useState(() => item?.selectedLanguage || item?.lang || localStorage.getItem("streamix.lang") || "");
  const [fullscreen, setFullscreen] = useState(false);
  const [sourceNote, setSourceNote] = useState(null);
  const [sourceStatus, setSourceStatus] = useState(null);
  const [sourceProvider, setSourceProvider] = useState(null);
  const [playbackMode, setPlaybackMode] = useState(() => (item?.forceEmbed || item?.isEmbed || item?.mediaType === "embed" ? "embed" : "direct"));
  const [sourceMode, setSourceMode] = useState(() => (item?.forceEmbed || item?.isEmbed || item?.mediaType === "embed" ? "embed" : "direct"));
  const [embedStreamUrl, setEmbedStreamUrl] = useState(() => {
    if (item?.forceEmbed || item?.isEmbed || item?.mediaType === "embed") {
      const rawUrl = item.streamUrl || item.mediaUrl || item.url || item.sourceUrl;
      if (rawUrl && typeof rawUrl === "string" && rawUrl.startsWith("http")) {
        return rawUrl;
      }
      const tmdbId = item.tmdbId || (typeof item.id === "number" || /^\d{1,9}$/.test(String(item.id)) ? Number(item.id) : null);
      return buildWebEmbedUrl({
        tmdbId,
        type: item.type,
        season: item.season,
        episode: item.episode,
        selectedLanguage: item.selectedLanguage || item.lang || localStorage.getItem("streamix.lang") || ""
      });
    }
    return null;
  });
  const [controlsVisible, setControlsVisible] = useState(true);
  const [resumedFrom, setResumedFrom] = useState(null);
  const [ended, setEnded] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [sourceDiagnostics, setSourceDiagnostics] = useState([]);
  const [sourceLimitation, setSourceLimitation] = useState(null);

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

  const handleSelectEmbed = useCallback(() => {
    setSourceMode("embed");
    const tmdbId =
      current.tmdbId ||
      (typeof current.id === "number" || /^\d{1,9}$/.test(String(current.id))
        ? Number(current.id)
        : null);

    const isSeries =
      current.type === "series" ||
      (current.season != null && current.episode != null);
    const season = current.season ?? 1;
    const episode = current.episode ?? 1;

    const lang = (current.selectedLanguage || current.lang || preferredLang || "").toLowerCase().trim();
    let embedUrl = null;
    if (tmdbId) {
      embedUrl = buildWebEmbedUrl({
        tmdbId,
        type: current.type,
        season,
        episode,
        selectedLanguage: lang
      });
    } else if (current.imdbId) {
      const langParam = lang && lang !== "en" && lang !== "original" ? `?lang=${encodeURIComponent(lang)}` : "";
      embedUrl = isSeries
        ? `https://vidsrc.to/embed/tv/${current.imdbId}/${season}/${episode}${langParam}`
        : `https://vidsrc.to/embed/movie/${current.imdbId}${langParam}`;
    } else {
      embedUrl = buildWebEmbedUrl({
        tmdbId,
        type: current.type,
        season,
        episode,
        selectedLanguage: lang
      });
    }

    if (!embedUrl) {
      const langParam = lang && lang !== "en" && lang !== "original" ? `?lang=${encodeURIComponent(lang)}` : "";
      embedUrl = `https://vidsrc.to/embed/${isSeries ? "tv" : "movie"}/${current.id}${isSeries ? `/${season}/${episode}` : ""}${langParam}`;
    }

    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.src = "";
      } catch {
        // ignore
      }
    }
    if (activeBlobUrlRef.current) {
      URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = null;
    }

    setPlaybackMode("embed");
    setEmbedStreamUrl(embedUrl);
    setSourceStatus("embed_stream");
    setSourceProvider("Web Embed");
    setSourceNote("Web Embed Stream (vidsrc.to)");
    setPhase("ready");
    setError(null);
  }, [current]);

  const handleSelectDirect = useCallback(() => {
    setSourceMode("direct");
    setPlaybackMode("direct");
    setEmbedStreamUrl(null);
    setPhase("resolving");
    setError(null);
    setAttempt((prev) => prev + 1);
  }, []);

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
      if (sourceMode === "embed" || playItem.forceEmbed) {
        setPhase("ready");
        setError(null);
        setEnded(false);
        setResumedFrom(null);
        setSourceDiagnostics([]);
        setSourceLimitation(null);
        cleanupActiveMedia();

        const tmdbId =
          playItem.tmdbId ||
          (typeof playItem.id === "number" || /^\d{1,9}$/.test(String(playItem.id))
            ? Number(playItem.id)
            : null);
        const isSeries =
          playItem.type === "series" ||
          (playItem.season != null && playItem.episode != null);
        const season = playItem.season ?? 1;
        const episode = playItem.episode ?? 1;

        const lang = (playItem.selectedLanguage || playItem.lang || preferredLang || "").toLowerCase().trim();
        let embedUrl = null;
        if (
          playItem.streamUrl &&
          typeof playItem.streamUrl === "string" &&
          (playItem.streamUrl.includes("vidsrc") ||
            playItem.streamUrl.includes("embed") ||
            playItem.streamUrl.includes("multiembed") ||
            playItem.streamUrl.includes("autoembed"))
        ) {
          embedUrl = playItem.streamUrl;
        } else if (tmdbId) {
          embedUrl = buildWebEmbedUrl({
            tmdbId,
            type: playItem.type,
            season,
            episode,
            selectedLanguage: lang
          });
        } else if (playItem.imdbId) {
          const langParam = lang && lang !== "en" && lang !== "original" ? `?lang=${encodeURIComponent(lang)}` : "";
          embedUrl = isSeries
            ? `https://vidsrc.to/embed/tv/${playItem.imdbId}/${season}/${episode}${langParam}`
            : `https://vidsrc.to/embed/movie/${playItem.imdbId}${langParam}`;
        } else {
          embedUrl = buildWebEmbedUrl({
            tmdbId,
            type: playItem.type,
            season,
            episode,
            selectedLanguage: lang
          });
        }

        if (!embedUrl) {
          const langParam = lang && lang !== "en" && lang !== "original" ? `?lang=${encodeURIComponent(lang)}` : "";
          embedUrl = `https://vidsrc.to/embed/${isSeries ? "tv" : "movie"}/${playItem.id}${isSeries ? `/${season}/${episode}` : ""}${langParam}`;
        }

        setPlaybackMode("embed");
        setEmbedStreamUrl(embedUrl);
        setSourceStatus("embed_stream");
        setSourceProvider("Web Embed");
        setSourceNote("Web Embed Stream (vidsrc.to)");

        if (Array.isArray(playItem.availableLanguages) && playItem.availableLanguages.length > 0) {
          const tracks = playItem.availableLanguages.map((l, idx) => ({
            id: l.code || String(idx),
            label: l.name,
            name: l.name,
            language: l.code,
            code: l.code
          }));
          setAudioTracks(tracks);
          const matchSelected = tracks.find((t) => t.code === lang || t.language === lang);
          setActiveTrack(matchSelected ? matchSelected.id : tracks[0].id);
        }
        return;
      }

      setPhase("resolving");
      setError(null);
      setEnded(false);
      setResumedFrom(null);
      setSourceDiagnostics([]);
      setSourceLimitation(null);
      cleanupActiveMedia();

      try {
        const hasExplicitDirectStream =
          Boolean(playItem.streamUrl) ||
          Boolean(playItem.mediaUrl) ||
          Boolean(playItem.url) ||
          (Boolean(playItem.sourceUrl) &&
            !playItem.sourceUrl.endsWith(".json") &&
            !playItem.sourceUrl.includes("/meta/"));

        const stream = await discoverClientStream(
          {
            type: playItem.type || "movie",
            id: playItem.id,
            tmdbId: playItem.tmdbId || (typeof playItem.id === "number" || /^\d{1,9}$/.test(String(playItem.id)) ? Number(playItem.id) : null),
            title: playItem.title,
            year: playItem.year || playItem.release_year,
            release_year: playItem.release_year || playItem.year,
            imdbId: playItem.imdb_id || playItem.imdbId || (String(playItem.id).startsWith("tt") ? playItem.id : null),
            season: playItem.season,
            episode: playItem.episode,
            episodeTitle: playItem.episodeTitle,
            streamUrl: playItem.streamUrl || playItem.mediaUrl || playItem.url,
            sourceUrl: hasExplicitDirectStream ? (playItem.streamUrl || playItem.mediaUrl || playItem.url || playItem.sourceUrl) : undefined,
            mediaType: playItem.mediaType,
            provider: playItem.provider,
            selectedLanguage: playItem.selectedLanguage || playItem.lang || preferredLang,
            lang: playItem.selectedLanguage || playItem.lang || preferredLang
          },
          {
            signal: controller.signal,
            lang: playItem.selectedLanguage || playItem.lang || preferredLang || undefined,
            mediaType: playItem.mediaType
          }
        );

        if (cancelled || opId !== operationIdRef.current) return;

        setSourceNote(stream.note ?? null);
        setSourceStatus(stream.resolution?.status ?? null);
        setSourceProvider(stream.provider?.name ?? null);

        if (Array.isArray(stream.qualities) && stream.qualities.length > 0) {
          setStreamQualities(stream.qualities);
          setActiveQualityLabel(stream.qualities[0].label);
        } else {
          setStreamQualities([]);
          setActiveQualityLabel(null);
        }

        let resolvedTracks = Array.isArray(stream.audioTracks) && stream.audioTracks.length > 0 ? stream.audioTracks : [];
        if (resolvedTracks.length === 0 && Array.isArray(playItem.availableLanguages) && playItem.availableLanguages.length > 0) {
          resolvedTracks = playItem.availableLanguages.map((l, idx) => ({
            id: l.code || String(idx),
            label: l.name,
            name: l.name,
            language: l.code,
            code: l.code,
            subjectId: l.subjectId,
            streamUrl: l.streamUrl || l.url
          }));
        }
        setAudioTracks(resolvedTracks);
        if (resolvedTracks.length > 0) {
          const reqLang = (playItem.selectedLanguage || playItem.lang || preferredLang || "").toLowerCase();
          const matchSelected = resolvedTracks.find((t) => (t.code && t.code.toLowerCase() === reqLang) || (t.language && t.language.toLowerCase() === reqLang) || t.id === reqLang);
          setActiveTrack(matchSelected ? matchSelected.id : resolvedTracks[0].id);
        }
        if (Array.isArray(stream.subtitles) && stream.subtitles.length > 0) {
          setSubtitles(stream.subtitles);
        } else {
          setSubtitles([]);
        }

        const rawSourceUrl = stream.sourceUrl;

        if (!rawSourceUrl) {
          throw new Error("No playable media URL returned for this source");
        }

        // 1. EMBED VS DIRECT SOURCE DETECTION
        const isDirectMedia =
          typeof rawSourceUrl === "string" &&
          (rawSourceUrl.includes(".m3u8") || rawSourceUrl.includes(".mp4")) &&
          !rawSourceUrl.includes("vidsrc") &&
          !rawSourceUrl.includes("/embed");

        const isEmbedStream =
          sourceMode === "embed" ||
          Boolean(stream.isEmbed) ||
          stream.mediaType === "embed" ||
          playItem.forceEmbed ||
          (!isDirectMedia &&
            typeof rawSourceUrl === "string" &&
            rawSourceUrl.startsWith("http") &&
            (rawSourceUrl.includes("vidsrc") ||
              rawSourceUrl.includes("embed") ||
              rawSourceUrl.includes("multiembed") ||
              rawSourceUrl.includes("autoembed")));

        if (isEmbedStream) {
          setPlaybackMode("embed");
          setEmbedStreamUrl(rawSourceUrl);
          setSourceStatus("embed_stream");
          setSourceProvider(stream.provider?.name || "Web Embed");
          setSourceNote(stream.note || "Web Embed Stream (vidsrc.to)");
          setPhase("ready");
          return;
        }

        setPlaybackMode("direct");
        setEmbedStreamUrl(null);

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

        // Probe media source to inspect response, status, content-type and initial bytes
        let probe = await probeMediaSource(rawSourceUrl, {
          signal: controller.signal,
          headers: stream.headers,
          declaredType: stream.mediaType
        });

        if (cancelled || opId !== operationIdRef.current) return;

        let sourceUrl = rawSourceUrl;

        // If direct fetch is blocked by CORS in browser-only mode:
        if (probe.corsBlocked) {
          const declaredOrDetected = probe.format !== "unknown" ? probe.format : (stream.mediaType || detectFormatFromUrl(rawSourceUrl));
          const isNativeDirectMedia = declaredOrDetected === "mp4" || declaredOrDetected === "webm" || rawSourceUrl.includes(".mp4") || rawSourceUrl.includes(".webm");

          if (stream.streamMode === "client") {
            // MKV demuxing strictly requires CORS byte-level access in browser JS
            if (declaredOrDetected === "mkv" || rawSourceUrl.includes(".mkv")) {
              throw new Error(
                "Cannot play MKV in browser: media host blocks browser cross-origin requests (CORS). Client-side demuxing requires the media host to provide 'Access-Control-Allow-Origin: *'."
              );
            }
            // For native browser formats (MP4, WebM), HTML5 <video src> does not require CORS headers.
            // Allow playback to proceed directly to native <video> element.
            if (!isNativeDirectMedia) {
              throw new Error(
                "Media host blocks browser cross-origin requests (CORS). Direct client-side playback requires the media host to provide 'Access-Control-Allow-Origin: *'."
              );
            }
          }
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
              "Cannot play MKV in browser: media host blocks browser cross-origin requests (CORS). Client-side demuxing requires the media host to provide 'Access-Control-Allow-Origin: *'."
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
        if (err.diagnostics && Array.isArray(err.diagnostics)) {
          setSourceDiagnostics(err.diagnostics);
        }
        if (err.limitation) {
          setSourceLimitation(err.limitation);
        }
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
    const hls = hlsRef.current;

    // 1. Web Embed mode audio switching
    if (playbackMode === "embed") {
      setPreferredLang(id);
      setActiveTrack(id);
      try {
        localStorage.setItem("streamix.lang", id);
      } catch {}
      const playItem = current;
      const tmdbId =
        playItem.tmdbId ||
        (typeof playItem.id === "number" || /^\d{1,9}$/.test(String(playItem.id))
          ? Number(playItem.id)
          : null);
      const isSeries = playItem.type === "series" || (playItem.season != null && playItem.episode != null);
      const season = playItem.season ?? 1;
      const episode = playItem.episode ?? 1;
      const newEmbedUrl = buildWebEmbedUrl({
        tmdbId,
        type: playItem.type,
        season,
        episode,
        selectedLanguage: id
      });
      if (newEmbedUrl) {
        setEmbedStreamUrl(newEmbedUrl);
      }
      return;
    }

    // 2. HLS internal audio track switching
    if (hls && hls.audioTracks && hls.audioTracks.length > 0 && !Number.isNaN(trackNum) && hls.audioTracks[trackNum]) {
      hls.audioTrack = trackNum;
      setActiveTrack(trackNum);
      return;
    }

    // 3. MovieBox multi-language dub / stream switching
    const targetDub = audioTracks.find((t) => String(t.id) === String(id) || String(t.code) === String(id) || String(t.language) === String(id));
    if (targetDub?.subjectId) {
      const video = videoRef.current;
      const preserveTime = video ? video.currentTime : 0;
      const wasPlaying = video ? !video.paused : false;
      setActiveTrack(id);
      setPreferredLang(targetDub.code || targetDub.language || id);
      try {
        localStorage.setItem("streamix.lang", targetDub.code || targetDub.language || id);
      } catch {}
      setSwitching(true);

      try {
        const details = await movieboxGetDetails(targetDub.subjectId).catch(() => null);
        const resolved = await movieboxResolveStreams({
          subjectId: targetDub.subjectId,
          season: current.season || 0,
          episode: current.episode || 0,
          details
        });

        if (resolved.sourceUrl) {
          activeMediaUrlRef.current = resolved.sourceUrl;
          if (hls) {
            hls.loadSource(resolved.sourceUrl);
            hls.once(hls.constructor.Events?.MANIFEST_PARSED || "hlsManifestParsed", () => {
              if (preserveTime > 0 && video) video.currentTime = preserveTime;
              if (wasPlaying && video) video.play().catch(() => {});
              setSwitching(false);
            });
          } else if (video) {
            video.src = resolved.sourceUrl;
            video.load();
            video.addEventListener("loadedmetadata", () => {
              if (preserveTime > 0) video.currentTime = preserveTime;
              if (wasPlaying) video.play().catch(() => {});
              setSwitching(false);
            }, { once: true });
          }
        }
      } catch (err) {
        setError(`Audio dub switch failed: ${err.message}`);
        setSwitching(false);
      }
      return;
    } else if (targetDub?.streamUrl || targetDub?.url) {
      const streamUrl = targetDub.streamUrl || targetDub.url;
      const video = videoRef.current;
      const preserveTime = video ? video.currentTime : 0;
      const wasPlaying = video ? !video.paused : false;
      setActiveTrack(id);
      setPreferredLang(targetDub.code || targetDub.language || id);
      try {
        localStorage.setItem("streamix.lang", targetDub.code || targetDub.language || id);
      } catch {}
      setSwitching(true);
      activeMediaUrlRef.current = streamUrl;
      if (hls && (streamUrl.includes(".m3u8") || streamUrl.includes("/hls/"))) {
        hls.loadSource(streamUrl);
        hls.once(hls.constructor.Events?.MANIFEST_PARSED || "hlsManifestParsed", () => {
          if (preserveTime > 0 && video) video.currentTime = preserveTime;
          if (wasPlaying && video) video.play().catch(() => {});
          setSwitching(false);
        });
      } else if (video) {
        video.src = streamUrl;
        video.load();
        video.addEventListener("loadedmetadata", () => {
          if (preserveTime > 0) video.currentTime = preserveTime;
          if (wasPlaying) video.play().catch(() => {});
          setSwitching(false);
        }, { once: true });
      }
      return;
    }

    // 3. Client remux fallback
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
  }, [playbackMode, audioTracks, current.season, current.episode]);

  const selectQuality = useCallback((value) => {
    const hls = hlsRef.current;

    // 1. MovieBox discrete qualities
    if (streamQualities.length > 0) {
      if (value === "Auto") {
        setActiveQualityLabel("Auto");
        if (hls) hls.currentLevel = -1;
        return;
      }
      const match = streamQualities.find((q) => q.label === value || String(q.height) === String(value));
      if (match) {
        setActiveQualityLabel(match.label);
        // If HLS levels match
        if (hls && levels.length > 0) {
          const matchLvl = levels.findIndex((l) => l.height === match.height);
          if (matchLvl !== -1) {
            hls.currentLevel = matchLvl;
            return;
          }
        }
        // If switching stream URL dynamically
        if (match.url && match.url !== activeMediaUrlRef.current) {
          const video = videoRef.current;
          const pos = video ? video.currentTime : 0;
          const wasPlaying = video ? !video.paused : false;
          activeMediaUrlRef.current = match.url;
          if (hls) {
            hls.loadSource(match.url);
            hls.once(hls.constructor.Events?.MANIFEST_PARSED || "hlsManifestParsed", () => {
              if (pos > 0 && video) video.currentTime = pos;
              if (wasPlaying && video) video.play().catch(() => {});
            });
          } else if (video) {
            video.src = match.url;
            video.load();
            video.addEventListener("loadedmetadata", () => {
              if (pos > 0) video.currentTime = pos;
              if (wasPlaying) video.play().catch(() => {});
            }, { once: true });
          }
        }
      }
      return;
    }

    // 2. Standard HLS levels
    if (hls) {
      setActiveLevel(applyQuality(hls, value));
    }
  }, [levels, streamQualities]);

  const selectSubtitle = useCallback((idx) => {
    setActiveSubtitle(idx);
    const video = videoRef.current;
    if (!video) return;

    const oldTracks = video.querySelectorAll("track.player-dyn-sub");
    oldTracks.forEach((t) => t.remove());

    if (idx === "off" || !subtitles[Number(idx)]) {
      return;
    }

    const sub = subtitles[Number(idx)];
    if (sub?.url) {
      const track = document.createElement("track");
      track.className = "player-dyn-sub";
      track.kind = "subtitles";
      track.label = sub.label || sub.language || "Subtitle";
      track.srclang = sub.language || "en";
      track.src = sub.url;
      track.default = true;
      video.appendChild(track);
      if (track.track) {
        track.track.mode = "showing";
      }
    }
  }, [subtitles]);

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
      ? `${current.title} — S${String(current.season).padStart(2, "0")}E${String(current.episode).padStart(2, "0")}${current.episodeTitle ? ` · ${current.episodeTitle}` : ""}`
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
      {playbackMode === "embed" && embedStreamUrl ? (
        <iframe
          src={embedStreamUrl}
          className="w-full h-full border-0 player-embed-iframe"
          title={`Playing ${displayTitle}`}
          allowFullScreen
          allow="autoplay; encrypted-media; picture-in-picture"
          style={{ width: "100%", height: "100%", border: 0, position: "absolute", inset: 0, background: "#000" }}
        />
      ) : (
        <video ref={videoRef} className="player-video" playsInline onClick={togglePlay} onDoubleClick={toggleFullscreen} />
      )}

      {(phase === "resolving" || switching) && (
        <div className="player-center">
          <div className="player-spinner" role="status" aria-label="Loading stream" />
          <p className="player-center-text">Resolving stream and preparing playback...</p>
        </div>
      )}

      {phase === "error" && (
        <div className="player-center">
          <div className="player-error-panel" role="alert">
            <h2>{error && (error.includes("Stream Not Available") || error.includes("No browser-accessible")) ? "Stream Not Available" : "Playback Error"}</h2>
            <p>{error && (error.includes("Stream Not Available") || error.includes("No browser-accessible")) ? "The requested title is currently not available for streaming on MovieBox." : error}</p>
            {sourceDiagnostics && sourceDiagnostics.length > 0 && (
              <div
                style={{
                  marginTop: "0.85rem",
                  padding: "0.75rem 1rem",
                  background: "rgba(15, 23, 42, 0.65)",
                  border: "1px solid rgba(148, 163, 184, 0.25)",
                  borderRadius: "6px",
                  fontSize: "0.8rem",
                  textAlign: "left",
                  lineHeight: "1.4"
                }}
              >
                <strong style={{ color: "#94a3b8" }}>Provider Diagnostics:</strong>
                <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.2rem", color: "#cbd5e1" }}>
                  {sourceDiagnostics.map((diag, idx) => (
                    <li key={idx} style={{ marginTop: "0.15rem" }}>
                      {diag}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && error.includes("CORS") && (
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
                  The remote media host does not permit browser cross-origin requests (CORS). Client-side playback requires the media host to provide "Access-Control-Allow-Origin: *" headers.
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
              <button type="button" className="player-btn player-btn-primary" onClick={handleSelectEmbed}>
                Play via Web Embed Stream
              </button>
              <button type="button" className="player-btn" onClick={retry}>
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
            <div className="player-source-pills" role="tablist" aria-label="Stream Source Selection">
              <button
                type="button"
                role="tab"
                aria-selected={playbackMode !== "embed"}
                className={`player-pill-btn ${playbackMode !== "embed" ? "active" : ""}`}
                onClick={handleSelectDirect}
              >
                Client Direct
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={playbackMode === "embed"}
                className={`player-pill-btn ${playbackMode === "embed" ? "active embed" : ""}`}
                onClick={handleSelectEmbed}
              >
                Web Embed Stream
              </button>
            </div>
            {audioTracks.length > 1 && (
              <label className="player-select player-top-audio" title="Switch audio language">
                <span>Audio</span>
                <select
                  value={activeTrack ?? audioTracks[0]?.id ?? ""}
                  onChange={(e) => selectAudio(e.target.value)}
                  aria-label="Switch audio language"
                >
                  {audioTracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.label || track.name || audioTrackLabel(track)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {sourceStatus === "fixture_fallback" && <span className="player-test-badge">TEST MODE</span>}
            {sourceNote && (
              <span className="player-source" title={sourceNote}>
                {sourceNote}
              </span>
            )}
          </div>

          {playbackMode !== "embed" && phase === "ready" && !playing && !ended && (
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

          {playbackMode !== "embed" && (
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

                {streamQualities.length > 1 ? (
                  <label className="player-select" title="Choose video quality">
                    <span>Quality</span>
                    <select
                      value={activeQualityLabel || streamQualities[0]?.label || "Auto"}
                      onChange={(e) => selectQuality(e.target.value)}
                      aria-label="Video quality"
                    >
                      <option value="Auto">Auto</option>
                      {streamQualities.map((q) => (
                        <option key={q.label} value={q.label}>
                          {q.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : qualityInfo.single ? (
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

                {subtitles.length > 0 && (
                  <label className="player-select">
                    <span>Subtitles</span>
                    <select
                      value={activeSubtitle ?? "off"}
                      onChange={(e) => selectSubtitle(e.target.value)}
                      aria-label="Subtitles"
                    >
                      <option value="off">Off</option>
                      {subtitles.map((sub, idx) => (
                        <option key={sub.url || idx} value={String(idx)}>
                          {sub.label || sub.language || `Track ${idx + 1}`}
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
          )}
        </>
      )}
    </div>
  );
}
