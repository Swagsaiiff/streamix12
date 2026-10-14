import { DirectSourceProvider } from "./direct-source-provider.js";
import { WikimediaSourceProvider } from "./wikimedia-source-provider.js";
import { ArchiveOrgSourceProvider } from "./archive-source-provider.js";
import { StremioAddonSourceProvider } from "./stremio-addon-source-provider.js";

export class SourceDiscoveryEngine {
  constructor(options = {}) {
    this.providers = [
      new DirectSourceProvider(options.direct),
      new WikimediaSourceProvider(options.wikimedia),
      new ArchiveOrgSourceProvider(options.archive),
      new StremioAddonSourceProvider(options.stremio)
    ];
  }

  addProvider(provider) {
    this.providers.push(provider);
  }

  /**
   * Discovers the best browser-accessible stream for the requested title or episode.
   * @param {object} item { type, id, title, year, season, episode, streamUrl, sourceUrl, mediaType }
   * @param {object} options Resolution options (signal, lang, etc.)
   * @returns {Promise<object>} Playable stream descriptor
   */
  async discoverStream(item = {}, options = {}) {
    const allDiagnostics = [];
    let detectedLimitation = null;

    // Run providers in priority order
    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;

      try {
        const result = await provider.resolveStreams(item, options);
        if (result.diagnostics) {
          allDiagnostics.push(...result.diagnostics);
        }
        if (result.limitation && !detectedLimitation) {
          detectedLimitation = result.limitation;
        }

        const playable = (result.sources || []).find((s) => s.isPlayableInBrowser && s.url);
        if (playable) {
          return {
            sessionId: null,
            provider: { name: playable.provider, resolution: "client_discovery" },
            resolution: { status: "direct_stream", sourceType: "discovered" },
            status: "ready",
            streamMode: "client",
            streamModeReason: "discovered_browser_stream",
            sourceUrl: playable.url,
            mediaType: playable.format !== "auto" ? playable.format : (item.mediaType || null),
            audioTracks: playable.audioTracks || [],
            headers: playable.headers || {},
            title: playable.title || item.title || null,
            year: item.year ?? null,
            season: item.season ?? null,
            episode: item.episode ?? null,
            note: playable.note || `Discovered via ${playable.provider}`,
            corsEnabled: playable.corsEnabled ?? false
          };
        }
      } catch (err) {
        if (err.name === "AbortError") throw err;
        allDiagnostics.push(`[${provider.name}] Error: ${err.message}`);
      }
    }

    // Honest reporting when no browser-accessible stream is found
    const targetName = item.title || item.id || "this title";
    let explanation = `No browser-accessible stream source found for "${targetName}".`;

    if (detectedLimitation) {
      explanation += ` ${detectedLimitation}`;
    } else if (item.provider === "VegaMovies") {
      explanation += " This title requires server-side web scraping (VegaMovies / Cloudflare bypass) which is not available in browser-only mode.";
    } else {
      explanation += " Under the browser-only architecture, media must be CORS-enabled or native browser video (MP4, WebM, HLS, DASH, or client-remuxed MKV).";
    }

    const err = new Error(explanation);
    err.code = "NO_BROWSER_STREAM";
    err.diagnostics = allDiagnostics;
    err.limitation = detectedLimitation;
    err.title = item.title;
    throw err;
  }
}

// Default singleton instance
export const defaultDiscoveryEngine = new SourceDiscoveryEngine();
