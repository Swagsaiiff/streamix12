import { BaseSourceProvider } from "./provider-interface.js";
import { detectFormatFromUrl } from "../source-detector.js";

const DEFAULT_STREMIO_ADDON = "https://torrentio.strem.fun";

export class StremioAddonSourceProvider extends BaseSourceProvider {
  /**
   * @param {object} options
   * @param {string} options.addonBaseUrl Base URL of the Stremio addon (e.g. 'https://torrentio.strem.fun' or user debrid addon)
   */
  constructor(options = {}) {
    super("stremio-addon", "Stremio Stream Addon", options);
    this.addonBaseUrl = options.addonBaseUrl || DEFAULT_STREMIO_ADDON;
  }

  buildStreamPath(type, id, season, episode) {
    if (!id) return null;
    if (type === "series" || (season != null && episode != null)) {
      // Series format: /stream/series/{id}:{season}:{episode}.json
      return `/stream/series/${encodeURIComponent(id)}:${season}:${episode}.json`;
    }
    // Movie format: /stream/movie/{id}.json
    return `/stream/movie/${encodeURIComponent(id)}.json`;
  }

  async resolveStreams(query = {}, options = {}) {
    const { type = "movie", id, season, episode, title } = query;

    // ID must be an IMDb ID (e.g. tt1234567) or Stremio ID
    if (!id || !id.startsWith("tt")) {
      return {
        sources: [],
        diagnostics: ["Stremio addon skipped: item has no IMDb ID ('tt...')"]
      };
    }

    const streamPath = this.buildStreamPath(type, id, season, episode);
    if (!streamPath) {
      return {
        sources: [],
        diagnostics: ["Could not construct Stremio stream path"]
      };
    }

    const targetUrl = `${this.addonBaseUrl.replace(/\/+$/, "")}${streamPath}`;

    try {
      const res = await fetch(targetUrl, {
        signal: options.signal,
        headers: { Accept: "application/json" }
      });

      if (!res.ok) {
        return {
          sources: [],
          diagnostics: [`Stremio addon endpoint returned HTTP ${res.status} from ${targetUrl}`]
        };
      }

      const data = await res.json();
      const rawStreams = Array.isArray(data.streams) ? data.streams : [];

      if (rawStreams.length === 0) {
        return {
          sources: [],
          diagnostics: [`No streams returned by Stremio addon for ${id} (${type})`]
        };
      }

      const sources = [];
      let torrentCount = 0;
      let directHttpCount = 0;

      for (const s of rawStreams) {
        // Case A: Direct HTTP/HTTPS stream URL (e.g. from Debrid or HTTP server)
        if (s.url && (s.url.startsWith("http://") || s.url.startsWith("https://"))) {
          directHttpCount++;
          const detected = detectFormatFromUrl(s.url);
          const format = detected !== "unknown" ? detected : "auto";
          sources.push({
            url: s.url,
            format,
            title: s.title || s.name || title,
            isPlayableInBrowser: true,
            provider: this.name,
            headers: s.behaviorHints?.proxyHeaders?.request || {},
            behaviorHints: s.behaviorHints || null,
            note: "Stremio direct stream URL"
          });
        }
        // Case B: BitTorrent infoHash (requires torrent engine or debrid)
        else if (s.infoHash) {
          torrentCount++;
          sources.push({
            url: null,
            infoHash: s.infoHash,
            fileIdx: s.fileIdx ?? 0,
            format: "torrent",
            title: s.title || s.name || title,
            filename: s.behaviorHints?.filename || null,
            isPlayableInBrowser: false,
            provider: this.name,
            requiresDebridOrTorrentEngine: true,
            limitation:
              "BitTorrent stream requires a Debrid service (RealDebrid, AllDebrid, Premiumize) or WebTorrent bridge; raw infoHash cannot be decoded natively by browser <video>."
          });
        }
        // Case C: External URL
        else if (s.externalUrl) {
          sources.push({
            url: s.externalUrl,
            format: "external",
            title: s.title || s.name || title,
            isPlayableInBrowser: false,
            provider: this.name,
            limitation: "External link to third-party website."
          });
        }
      }

      const diagnostics = [
        `Queried Stremio addon: found ${rawStreams.length} total stream(s) (${directHttpCount} direct HTTP, ${torrentCount} torrent infoHash)`
      ];

      return {
        sources,
        diagnostics,
        limitation:
          directHttpCount === 0 && torrentCount > 0
            ? `Found ${torrentCount} BitTorrent stream(s), but browser playback requires a Debrid account or WebTorrent bridge.`
            : null
      };
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return {
        sources: [],
        diagnostics: [`Stremio addon request failed: ${err.message}`]
      };
    }
  }
}
