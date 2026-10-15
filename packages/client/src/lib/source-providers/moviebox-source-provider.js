import { BaseSourceProvider } from "./provider-interface.js";
import {
  movieboxSearch,
  movieboxGetDetails,
  movieboxResolveStreams,
  cleanMovieboxTitle
} from "../moviebox/index.js";

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
    let subjectId = null;

    // Check if query.id is already a MovieBox subjectId (numeric string)
    if (query.id && /^\d{10,25}$/.test(String(query.id))) {
      subjectId = String(query.id);
      diagnostics.push(`Using provided MovieBox subjectId: ${subjectId}`);
    } else if (title) {
      const cleanTitle = cleanMovieboxTitle(title);
      diagnostics.push(`Searching MovieBox for "${cleanTitle}"...`);

      try {
        const results = await movieboxSearch(cleanTitle, 1, options);
        diagnostics.push(`MovieBox returned ${results.length} search results`);

        if (results.length > 0) {
          // Find best matching result
          let best = results[0];
          if (query.year) {
            const matchYear = results.find((r) => r.year === String(query.year));
            if (matchYear) best = matchYear;
          }
          subjectId = best.id;
          diagnostics.push(`Selected MovieBox title: "${best.title}" (ID: ${subjectId})`);
        }
      } catch (err) {
        diagnostics.push(`MovieBox search error: ${err.message}`);
      }
    }

    if (!subjectId) {
      return {
        sources: [],
        diagnostics,
        limitation: `Title "${title || query.id}" not found on MovieBox.`
      };
    }

    try {
      let details = null;
      try {
        details = await movieboxGetDetails(subjectId, options);
      } catch {
        // details optional
      }

      const seasonNum = query.season != null ? Number(query.season) : 0;
      const episodeNum = query.episode != null ? Number(query.episode) : 0;

      const resolved = await movieboxResolveStreams({
        subjectId,
        season: seasonNum,
        episode: episodeNum,
        details,
        options
      });

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
            corsEnabled: true
          }
        ],
        diagnostics
      };
    } catch (err) {
      diagnostics.push(`MovieBox stream resolution failed: ${err.message}`);
      return {
        sources: [],
        diagnostics,
        limitation: `MovieBox stream resolution error: ${err.message}`
      };
    }
  }
}
