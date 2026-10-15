import { detectFormatFromUrl } from "./source-detector.js";

// STREAMIX Provider Capabilities & Execution Boundary
// Clearly defines which providers/tasks run client-side in the browser vs genuinely require the backend server.

export const PROVIDERS = {
  MovieBox: {
    id: "moviebox",
    name: "MovieBox",
    execution: "client",
    description: "Frontend-only stream discovery, multi-quality HLS, and multi-audio dubs ported from MovieBox-Tui with client-side CORS proxy support.",
    supportedFormats: ["hls", "dash", "mp4"],
    requiresBackend: false
  },
  Direct: {
    id: "direct",
    name: "Direct Media",
    execution: "client",
    description: "Plays CORS-enabled MP4, WebM, HLS (.m3u8), DASH (.mpd), and browser-supported MKV files directly in the browser player without server involvement.",
    supportedFormats: ["mp4", "webm", "hls", "dash", "mkv"],
    requiresBackend: false
  },
  CineStream: {
    id: "cinestream",
    name: "CineStream (Cinemeta / Kitsu)",
    execution: "client-first",
    description: "Catalog browsing, rows, search, and episode metadata run 100% client-side via public CORS-enabled APIs. Direct streams and open titles play directly in the browser player without server involvement.",
    supportedFormats: ["mp4", "webm", "hls", "dash", "mkv", "metadata"],
    requiresBackend: false,
    requiresBackendForStreams: false
  },
  VegaMovies: {
    id: "vegamovies",
    name: "VegaMovies",
    execution: "backend-required",
    description: "Legacy HTML scraper replaced by frontend-only MovieBox. Required the Node.js backend because target domains lack CORS headers and block browser User-Agents.",
    supportedFormats: ["mkv", "mp4"],
    requiresBackend: true,
    backendReasons: [
      "No Access-Control-Allow-Origin headers on vegamovies.gallery or download hosts",
      "Cloudflare bot protection and dynamic vcloud token decryption",
      "Forbidden browser headers (custom Referer cannot be set by browser fetch)"
    ]
  }
};

// Verified genuine public browser-accessible stream registry
export const BROWSER_STREAM_REGISTRY = {
  "tt1254207": {
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm",
    format: "webm",
    title: "Big Buck Bunny"
  },
  "tt1727587": {
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.360p.vp9.webm",
    format: "webm",
    title: "Sintel"
  },
  "sample-clip": {
    url: "/fixtures/multi-audio-test.mkv",
    format: "mkv",
    title: "Dual-Audio Sample Clip"
  },
  "multi-audio-test": {
    url: "/fixtures/multi-audio-test.mkv",
    format: "mkv",
    title: "Dual-Audio Sample Clip"
  }
};

export function getProviderInfo(providerName = "CineStream") {
  return PROVIDERS[providerName] || PROVIDERS.CineStream;
}

export function isBackendRequiredForStream(providerName) {
  const info = getProviderInfo(providerName);
  return Boolean(info.requiresBackend || info.requiresBackendForStreams);
}

export function getStreamResolutionPlan(item) {
  if (!item) {
    return {
      canResolveClientSide: false,
      provider: "Direct",
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
      !item.sourceUrl.includes("/meta/")
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

  // Check known verified browser-accessible stream sources by ID
  if (item.id && BROWSER_STREAM_REGISTRY[item.id]) {
    const entry = BROWSER_STREAM_REGISTRY[item.id];
    return {
      canResolveClientSide: true,
      sourceUrl: entry.url,
      provider: item.provider || "Direct",
      format: entry.format,
      requiresBackend: false,
      reasons: []
    };
  }

  const providerName = item.provider || "CineStream";
  const info = getProviderInfo(providerName);
  const requiresBackend = providerName === "VegaMovies";

  return {
    canResolveClientSide: false,
    sourceUrl: null,
    provider: providerName,
    format: null,
    requiresBackend,
    reasons: [
      `No browser-accessible stream source found for "${item.title || item.id || 'this title'}". Under the browser-only architecture, media must be CORS-enabled (MP4, WebM, HLS, DASH, or browser-supported MKV). Titles requiring server-side web scraping (VegaMovies / Cloudflare bypass) cannot be resolved in browser-only mode.`
    ]
  };
}

export function resolveClientStream(item = {}, options = {}) {
  const plan = getStreamResolutionPlan(item);
  if (!plan.canResolveClientSide || !plan.sourceUrl) {
    return null;
  }

  const mediaType = item.mediaType || options.mediaType || (plan.format !== "auto" ? plan.format : null);
  return {
    sessionId: null,
    provider: { name: plan.provider, resolution: "direct_stream" },
    resolution: { status: "direct_stream", sourceType: "direct" },
    status: "ready",
    streamMode: "client",
    streamModeReason: "direct_client_stream",
    sourceUrl: plan.sourceUrl,
    mediaType,
    audioTracks: item.audioTracks || options.audioTracks || [],
    variants: item.variants || options.variants || null,
    headers: item.headers || options.headers || {},
    title: item.title ?? null,
    year: item.year ?? null,
    episode: item.episode ?? null,
    note: "Direct stream resolved client-side"
  };
}

import { defaultDiscoveryEngine } from "./source-providers/index.js";

export async function discoverClientStream(item = {}, options = {}) {
  // 1. Fast synchronous check for explicit URLs or registered test fixtures
  const direct = resolveClientStream(item, options);
  if (direct) {
    return direct;
  }

  // 2. Comprehensive asynchronous discovery across configured source providers
  return await defaultDiscoveryEngine.discoverStream(item, options);
}
