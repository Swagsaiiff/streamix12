import { BaseSourceProvider } from "./provider-interface.js";
import { probeMediaSource, detectFormatFromUrl } from "../source-detector.js";

function streamMatchesEpisode(text = "", season, episode) {
  if (season == null || episode == null) return true;
  const match = text.match(/[sS](\d+)[eE](\d+)/) || text.match(/(\d+)[xX](\d+)/);
  if (!match) return true;
  const s = Number(match[1]);
  const e = Number(match[2]);
  return s === Number(season) && e === Number(episode);
}

function hasForbiddenBrowserHeaders(headers = {}) {
  const forbidden = ["referer", "origin", "cookie", "user-agent", "host"];
  return Object.keys(headers).some((k) => forbidden.includes(k.toLowerCase()));
}

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
          const streamText = `${s.title || ""} ${s.name || ""} ${s.behaviorHints?.filename || ""}`;

          // Check episode matching for series
          if (!streamMatchesEpisode(streamText, season, episode)) {
            continue; // Skip stream for mismatched episode
          }

          // Check if addon explicitly marked stream as not web-ready
          if (s.behaviorHints?.notWebReady) {
            sources.push({
              url: s.url,
              format: detectFormatFromUrl(s.url),
              title: s.title || s.name || title,
              isPlayableInBrowser: false,
              provider: this.name,
              limitation: "Stream marked as not web-ready by addon (requires external media player)"
            });
            continue;
          }

          // Check if stream requires custom upstream headers forbidden in browser sandboxes
          const reqHeaders = s.behaviorHints?.proxyHeaders?.request || {};
          if (hasForbiddenBrowserHeaders(reqHeaders)) {
            sources.push({
              url: s.url,
              format: detectFormatFromUrl(s.url),
              title: s.title || s.name || title,
              isPlayableInBrowser: false,
              provider: this.name,
              limitation: "Stream requires custom upstream headers (Referer/Cookie) that cannot be sent by browser"
            });
            continue;
          }

          const detected = detectFormatFromUrl(s.url);
          const format = detected !== "unknown" ? detected : "auto";
          sources.push({
            url: s.url,
            format,
            title: s.title || s.name || title,
            isPlayableInBrowser: true,
            provider: this.name,
            headers: reqHeaders,
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
