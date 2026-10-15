import { DirectSourceProvider } from "./direct-source-provider.js";
import { MovieBoxSourceProvider } from "./moviebox-source-provider.js";

export class SourceDiscoveryEngine {
  constructor(options = {}) {
    this.providers = [
      new DirectSourceProvider(options.direct),
      new MovieBoxSourceProvider(options.moviebox)
    ];
  }

  addProvider(provider) {
    this.providers.push(provider);
  }

  /**
   * Discovers the best browser-accessible stream for the requested title or episode.
   * MovieBox is the primary streaming provider.
   * @param {object} item { type, id, title, year, season, episode, streamUrl, sourceUrl, mediaType }
   * @param {object} options Resolution options (signal, lang, etc.)
   * @returns {Promise<object>} Playable stream descriptor
   */
  async discoverStream(item = {}, options = {}) {
    const allDiagnostics = [];
    let detectedLimitation = null;

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
            qualities: playable.qualities || null,
            audioTracks: playable.audioTracks || [],
            subtitles: playable.subtitles || [],
            headers: playable.headers || {},
            title: playable.title || item.title || null,
            year: item.year ?? null,
            season: item.season ?? null,
            episode: item.episode ?? null,
            note: playable.note || `Discovered via ${playable.provider}`,
            corsEnabled: playable.corsEnabled ?? true
          };
        }
      } catch (err) {
        if (err.name === "AbortError") throw err;
        allDiagnostics.push(`[${provider.name}] Error: ${err.message}`);
      }
    }

    const err = new Error("Stream Not Available");
    err.code = "STREAM_NOT_AVAILABLE";
    err.diagnostics = allDiagnostics;
    err.limitation = detectedLimitation;
    err.title = item.title;
    throw err;
  }
}

// Default singleton instance
export const defaultDiscoveryEngine = new SourceDiscoveryEngine();
