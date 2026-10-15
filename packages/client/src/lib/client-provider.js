import { detectFormatFromUrl } from "./source-detector.js";

// STREAMIX Provider Capabilities & Execution Boundary
export const PROVIDERS = {
  TMDB: {
    id: "tmdb",
    name: "The Movie Database (TMDB)",
    execution: "client",
    description: "Official TMDB API for catalog browsing, trending feeds, row categories, search, and comprehensive movie/TV metadata.",
    supportedFormats: ["metadata"],
    requiresBackend: false
  },
  MovieBox: {
    id: "moviebox",
    name: "MovieBox",
    execution: "client",
    description: "Frontend-only stream discovery, multi-quality HLS, and multi-audio dubs ported from MovieBox-Tui with client-side CORS proxy support and Web Embed fallback.",
    supportedFormats: ["hls", "dash", "mp4", "embed"],
    requiresBackend: false
  },
  Direct: {
    id: "direct",
    name: "Direct Media",
    execution: "client",
    description: "Plays CORS-enabled MP4, WebM, HLS (.m3u8), and DASH (.mpd) directly in the browser player without server involvement.",
    supportedFormats: ["mp4", "webm", "hls", "dash"],
    requiresBackend: false
  }
};

export const BROWSER_STREAM_REGISTRY = {};

export function getProviderInfo(providerName = "MovieBox") {
  return PROVIDERS[providerName] || PROVIDERS.MovieBox;
}

export function isBackendRequiredForStream() {
  return false;
}

export function getStreamResolutionPlan(item) {
  if (!item) {
    return {
      canResolveClientSide: false,
      provider: "MovieBox",
      format: null,
      requiresBackend: false,
      reasons: []
    };
  }

  const directCandidate =
    item.streamUrl ||
    item.mediaUrl ||
    item.url ||
    (item.sourceUrl &&
      !item.sourceUrl.endsWith(".json") &&
      !item.sourceUrl.includes("/meta/") &&
      !item.sourceUrl.includes("api.themoviedb.org")
        ? item.sourceUrl
        : null);

  if (directCandidate) {
    const detected = detectFormatFromUrl(directCandidate);
    const format = detected !== "unknown" ? detected : (item.mediaType || "auto");
    if (format !== "json" && format !== "html") {
      return {
        canResolveClientSide: true,
        sourceUrl: directCandidate,
        provider: item.provider || "Direct",
        format,
        requiresBackend: false,
        reasons: []
      };
    }
  }

  return {
    canResolveClientSide: true,
    sourceUrl: null,
    provider: "MovieBox",
    format: "hls",
    requiresBackend: false,
    reasons: []
  };
}

export function resolveClientStream(item = {}, options = {}) {
  const plan = getStreamResolutionPlan(item);
  if (!plan.canResolveClientSide || !plan.sourceUrl) {
    return null;
  }

  return {
    sessionId: null,
    provider: { name: plan.provider, resolution: "client_direct" },
    resolution: { status: "direct_stream", sourceType: "registry" },
    status: "ready",
    streamMode: "client",
    streamModeReason: "direct_browser_media",
    sourceUrl: plan.sourceUrl,
    mediaType: plan.format,
    audioTracks: [],
    subtitles: [],
    headers: {},
    title: item.title || null,
    year: item.year ?? null,
    season: item.season ?? null,
    episode: item.episode ?? null,
    note: "Browser-compatible direct stream"
  };
}

export async function discoverClientStream(item = {}, options = {}) {
  const { defaultDiscoveryEngine } = await import("./source-providers/index.js");
  return defaultDiscoveryEngine.discoverStream(item, options);
}
