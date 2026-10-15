import {
  getTmdbHomeRowDefinitions,
  tmdbSearch,
  tmdbGetDetails,
  tmdbGetSeasonEpisodes
} from "./lib/tmdb-catalog.js";
import {
  movieboxSearch,
  movieboxGetDetails
} from "./lib/moviebox/index.js";
import { discoverClientStream } from "./lib/client-provider.js";

export { tmdbGetSeasonEpisodes };

export async function fetchHomeSections(options = {}) {
  const rowDefs = getTmdbHomeRowDefinitions();
  const results = await Promise.allSettled(
    rowDefs.map(async (def) => {
      const items = await def.fetch(options);
      return {
        data: {
          key: def.key,
          title: def.title,
          ranking: def.ranking,
          items
        }
      };
    })
  );

  return results
    .filter((r) => r.status === "fulfilled" && Array.isArray(r.value?.data?.items) && r.value.data.items.length > 0)
    .map((r) => r.value);
}

export async function fetchSearch(q, options = {}) {
  const trimmed = (q || "").trim();
  if (!trimmed) {
    return { query: q, count: 0, items: [] };
  }

  // Search official TMDB first (movies & tv shows)
  try {
    const tmdbItems = await tmdbSearch(trimmed, options);
    if (tmdbItems && tmdbItems.length > 0) {
      return {
        query: trimmed,
        count: tmdbItems.length,
        items: tmdbItems
      };
    }
  } catch {
    // fallback to MovieBox search
  }

  // MovieBox frontend search fallback
  try {
    const movieboxItems = await movieboxSearch(trimmed, 1, options);
    if (movieboxItems && movieboxItems.length > 0) {
      return {
        query: trimmed,
        count: movieboxItems.length,
        items: movieboxItems
      };
    }
  } catch {
    // empty
  }

  return {
    query: trimmed,
    count: 0,
    items: []
  };
}

export async function fetchDetail(type, id, { provider, ...options } = {}) {
  // If numeric or TMDB item, fetch from TMDB API
  if (provider === "TMDB" || /^\d{1,9}$/.test(String(id))) {
    try {
      const item = await tmdbGetDetails(type, id, options);
      return { item };
    } catch {
      // fallback
    }
  }

  // If MovieBox subjectId (numeric string >= 10 chars)
  if (provider === "MovieBox" || (typeof id === "string" && /^\d{10,25}$/.test(id))) {
    try {
      const item = await movieboxGetDetails(id, options);
      return { item };
    } catch {
      // fallback
    }
  }

  // Default to TMDB details
  const item = await tmdbGetDetails(type, id, options);
  return { item };
}

export async function createStream(type = "movie", id = "direct", { lang, provider, season, episode, sourceUrl, mediaType, title, year, release_year, imdbId, tmdbId, signal, ...options } = {}) {
  const numericTmdbId = tmdbId || (typeof id === "number" || /^\d{1,9}$/.test(String(id)) ? Number(id) : null);
  const resolvedImdbId = imdbId || (typeof id === "string" && id.startsWith("tt") ? id : null);

  return await discoverClientStream(
    {
      type,
      id,
      tmdbId: numericTmdbId,
      imdbId: resolvedImdbId,
      title,
      year: year || release_year,
      release_year: release_year || year,
      provider,
      season,
      episode,
      sourceUrl: sourceUrl || options.sourceUrl,
      streamUrl: options.streamUrl,
      mediaType,
      ...options
    },
    { signal, mediaType, lang, ...options }
  );
}

export function cleanupStream() {
  return Promise.resolve();
}
