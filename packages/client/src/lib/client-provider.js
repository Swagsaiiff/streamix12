import { detectFormatFromUrl } from "./source-detector.js";

// STREAMIX Provider Capabilities & Execution Boundary
// Clearly defines which providers/tasks run client-side in the browser vs genuinely require the backend server.

export const PROVIDERS = {
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
    execution: "client-catalog",
    description: "Catalog browsing, rows, search, and episode metadata run 100% client-side via public CORS-enabled APIs. Stream resolution bridges to VegaMovies.",
    supportedFormats: ["metadata"],
    requiresBackend: false,
    requiresBackendForStreams: true,
    backendReasons: [
      "Cinemeta is a metadata-only catalog provider and does not host or index stream URLs",
      "Stream resolution bridges to VegaMovies HTML scraper, which requires server-side fetching",
      "Scraper target domains (vegamovies.gallery, vcloud.beer, fastdl) lack CORS headers (blocked by browser SOP)",
      "Scraper requires custom Referer and cookie headers forbidden by the browser Fetch specification",
      "Cloudflare bot protection and Turnstile verification cannot be solved in cross-origin browser sandbox"
    ]
  },
  VegaMovies: {
    id: "vegamovies",
    name: "VegaMovies",
    execution: "backend-required",
    description: "Protected HTML scraper. Genuinely requires the Node.js backend because target domains lack CORS headers, block browser User-Agents, and require custom Referer/Cookie headers.",
    supportedFormats: ["mkv", "mp4"],
    requiresBackend: true,
    backendReasons: [
      "No Access-Control-Allow-Origin headers on vegamovies.gallery or download hosts",
      "Cloudflare bot protection and dynamic vcloud token decryption",
      "Forbidden browser headers (custom Referer cannot be set by browser fetch)"
    ]
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
    const format = detected !== "unknown" ? detected : (item.mediaType || null);
    if (format && format !== "json" && format !== "html" && format !== "unknown") {
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

  const providerName = item.provider || "CineStream";
  const info = getProviderInfo(providerName);
  return {
    canResolveClientSide: false,
    sourceUrl: null,
    provider: providerName,
    format: null,
    requiresBackend: isBackendRequiredForStream(providerName),
    reasons: info.backendReasons || ["Provider requires server-side resolution for stream extraction."]
  };
}

export function resolveClientStream(item = {}, options = {}) {
  const plan = getStreamResolutionPlan(item);
  if (!plan.canResolveClientSide || !plan.sourceUrl) {
    return null;
  }

  const mediaType = item.mediaType || options.mediaType || plan.format;
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
