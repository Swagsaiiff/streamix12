import { BaseSourceProvider } from "./provider-interface.js";
import {
  movieboxSearch,
  movieboxGetDetails,
  movieboxResolveStreams,
  cleanMovieboxTitle
} from "../moviebox/index.js";

export function buildWebEmbedUrl({ tmdbId, type = "movie", season = 1, episode = 1, selectedLanguage, lang }) {
  if (!tmdbId) return null;
  const isSeries = type === "series" || type === "tv";
  const s = season || 1;
  const ep = episode || 1;
  const language = (selectedLanguage || lang || "").toLowerCase().trim();
  const langParam = language && language !== "en" && language !== "original" ? `?lang=${encodeURIComponent(language)}` : "";

  if (isSeries) {
    return `https://vidsrc.to/embed/tv/${tmdbId}/${s}/${ep}${langParam}`;
  }
  return `https://vidsrc.to/embed/movie/${tmdbId}${langParam}`;
}

export class MovieBoxSourceProvider extends BaseSourceProvider {
  constructor(options = {}) {
    super("moviebox", "MovieBox", options);
  }

  isAvailable() {
    return true;
  }

  async resolveStreams(query = {}, options = {}) {
    const diagnostics = [];
    const title = query.title || "";
    const tmdbId = query.tmdbId || (typeof query.id === "number" || /^\d{1,9}$/.test(String(query.id)) ? Number(query.id) : null);
    const imdbId = query.imdbId || query.imdb_id || (String(query.id).startsWith("tt") ? String(query.id) : null);
    const releaseYear = query.release_year || query.year;
    const seasonNum = query.season != null ? Number(query.season) : 0;
    const episodeNum = query.episode != null ? Number(query.episode) : 0;
    const itemType = query.type === "series" || query.type === "tv" ? "series" : "movie";
    const targetLang = (query.selectedLanguage || query.lang || options.lang || "").toLowerCase().trim();

    let subjectId = null;

    // 1. Check if query.id is already a MovieBox numeric subjectId (length >= 10)
    if (query.id && /^\d{10,25}$/.test(String(query.id))) {
      subjectId = String(query.id);
      diagnostics.push(`Using provided MovieBox subjectId: ${subjectId}`);
    } else {
      // 2. Query MovieBox using IMDb ID if available, or cleaned title string
      const searchTerms = [];
      if (imdbId) searchTerms.push(imdbId);
      if (title) searchTerms.push(cleanMovieboxTitle(title));

      for (const term of searchTerms) {
        if (!term) continue;
        diagnostics.push(`Searching MovieBox for "${term}"...`);
        try {
          const results = await movieboxSearch(term, 1, options);
          diagnostics.push(`MovieBox returned ${results.length} search results for "${term}"`);

          if (results.length > 0) {
            let best = results[0];
            if (releaseYear) {
              const matchYear = results.find((r) => r.year === String(releaseYear));
              if (matchYear) best = matchYear;
            }
            subjectId = best.id;
            diagnostics.push(`Selected MovieBox title: "${best.title}" (ID: ${subjectId})`);
            break;
          }
        } catch (err) {
          diagnostics.push(`MovieBox search error for "${term}": ${err.message}`);
        }
      }
    }

    // Try resolving streams from MovieBox if subjectId is found
    if (subjectId) {
      try {
        let details = null;
        try {
          details = await movieboxGetDetails(subjectId, options);
        } catch {
          // details optional
        }

        let targetSubjectId = subjectId;
        if (targetLang && details?.dubs && details.dubs.length > 0) {
          const matchDub = details.dubs.find(
            (d) =>
              d.language?.toLowerCase().startsWith(targetLang) ||
              d.label?.toLowerCase().includes(targetLang)
          );
          if (matchDub?.subjectId) {
            targetSubjectId = matchDub.subjectId;
            diagnostics.push(`Switching to MovieBox dubbed subjectId ${targetSubjectId} for audio language "${targetLang}"`);
          }
        }

        const resolved = await movieboxResolveStreams({
          subjectId: targetSubjectId,
          season: seasonNum,
          episode: episodeNum,
          details,
          options
        });

        if (resolved?.sourceUrl && resolved?.qualities?.length > 0) {
          diagnostics.push(`Resolved ${resolved.qualities.length} qualities on MovieBox: ${resolved.qualities.map((q) => q.label).join(", ")}`);
          return {
            sources: [
              {
                url: resolved.sourceUrl,
                format: resolved.mediaType,
                quality: resolved.qualities[0]?.label || "1080p",
                qualities: resolved.qualities,
                audioTracks: resolved.audioTracks,
                subtitles: resolved.subtitles,
                isPlayableInBrowser: true,
                provider: "MovieBox",
                headers: resolved.headers,
                note: `MovieBox ${resolved.qualities[0]?.label || ""}`,
                corsEnabled: true,
                isEmbed: false
              }
            ],
            diagnostics
          };
        }
      } catch (err) {
        diagnostics.push(`MovieBox direct stream resolution failed (${err.message}). Triggering Web Embed fallback.`);
      }
    }

    // 3. Fallback: Automatic Web Embed Stream URL if MovieBox fails, 403s, or finds no stream
    if (tmdbId) {
      const embedUrl = buildWebEmbedUrl({
        tmdbId,
        type: itemType,
        season: seasonNum || 1,
        episode: episodeNum || 1,
        selectedLanguage: targetLang
      });

      if (embedUrl) {
        diagnostics.push(`Resolved fallback Web Embed stream: ${embedUrl}`);
        return {
          sources: [
            {
              url: embedUrl,
              format: "embed",
              quality: "Auto (Web Embed)",
              qualities: [{ label: "Web Embed", value: 0, url: embedUrl }],
              audioTracks: [],
              subtitles: [],
              isPlayableInBrowser: true,
              isEmbed: true,
              provider: "MovieBox (Embed)",
              note: "Web Embed Stream (TMDB)",
              corsEnabled: true
            }
          ],
          diagnostics
        };
      }
    }

    return {
      sources: [],
      diagnostics,
      limitation: `No stream available on MovieBox or Web Embed for "${title || query.id}".`
    };
  }
}
