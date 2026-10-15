// TMDB (The Movie Database) API Client and Catalog Feeds
// Official TMDB v3 API catalog provider.

export const TMDB_API_KEY =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_TMDB_API_KEY) ||
  "5b08cca85a2805a7e7d12fd29bfc6606";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p";

export const GENRE_MAP = {
  Action: 28,
  Adventure: 12,
  Animation: 16,
  Comedy: 35,
  Crime: 80,
  Documentary: 99,
  Drama: 18,
  Family: 10751,
  Fantasy: 14,
  History: 36,
  Horror: 27,
  Music: 10402,
  Mystery: 9648,
  Romance: 10749,
  SciFi: 878,
  Thriller: 53,
  War: 10752,
  Western: 37,
  // TV Genres
  ActionAdventureTV: 10759,
  AnimationTV: 16,
  ComedyTV: 35,
  CrimeTV: 80,
  DocumentaryTV: 99,
  DramaTV: 18,
  MysteryTV: 9648,
  SciFiFantasyTV: 10765
};

export function getTmdbImageUrl(path, size = "w500") {
  if (!path) return null;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${TMDB_IMG}/${size}${path}`;
}

export function parseYear(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

export function normalizeTmdbItem(item, explicitType = null) {
  if (!item || typeof item !== "object") return null;

  const isTv = explicitType ? explicitType === "series" || explicitType === "tv" : Boolean(item.name || item.first_air_date);
  const type = isTv ? "series" : "movie";
  const title = item.title || item.name || item.original_title || item.original_name || "";
  const date = item.release_date || item.first_air_date || null;
  const year = parseYear(date);
  const tmdbId = item.id != null ? Number(item.id) : null;
  const imdbId = item.imdb_id || item.external_ids?.imdb_id || null;

  return {
    id: tmdbId ? String(tmdbId) : null,
    tmdbId,
    imdbId,
    title,
    type,
    poster: getTmdbImageUrl(item.poster_path, "w500"),
    backdrop: getTmdbImageUrl(item.backdrop_path, "w1280"),
    overview: item.overview || null,
    year,
    releaseDate: date,
    rating: item.vote_average ? Number(item.vote_average.toFixed(1)) : null,
    voteCount: item.vote_count ?? null,
    popularity: item.popularity ?? null,
    genres: Array.isArray(item.genres)
      ? item.genres.map((g) => g.name || g)
      : Array.isArray(item.genre_ids)
        ? item.genre_ids
        : null,
    original_language: item.original_language || null,
    language: item.original_language || null,
    provider: "TMDB",
    source: "TMDB"
  };
}

async function tmdbFetch(endpoint, params = {}, options = {}) {
  const url = new URL(`${TMDB_BASE}${endpoint}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "en-US");

  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), { signal: options.signal });
  if (!res.ok) {
    throw new Error(`TMDB HTTP ${res.status}: ${res.statusText}`);
  }
  return await res.json();
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// -------------------------------------------------------------
// TMDB Catalog Endpoints for Homescreen Feeds
// -------------------------------------------------------------

export async function tmdbGetTrendingMovies(options = {}) {
  const data = await tmdbFetch("/trending/movie/week", {}, options);
  return dedupeItems((data.results || []).map((i) => normalizeTmdbItem(i, "movie")));
}

export async function tmdbGetPopularMovies(page = 1, options = {}) {
  const data = await tmdbFetch("/movie/popular", { page }, options);
  return dedupeItems((data.results || []).map((i) => normalizeTmdbItem(i, "movie")));
}

export async function tmdbGetTopRatedMovies(page = 1, options = {}) {
  const data = await tmdbFetch("/movie/top_rated", { page }, options);
  return dedupeItems((data.results || []).map((i) => normalizeTmdbItem(i, "movie")));
}

export async function tmdbGetNowPlayingMovies(page = 1, options = {}) {
  const data = await tmdbFetch("/movie/now_playing", { page }, options);
  return dedupeItems((data.results || []).map((i) => normalizeTmdbItem(i, "movie")));
}

export async function tmdbGetMoviesByGenre(genreId, page = 1, options = {}) {
  const data = await tmdbFetch("/discover/movie", { with_genres: genreId, sort_by: "popularity.desc", page }, options);
  return dedupeItems((data.results || []).map((i) => normalizeTmdbItem(i, "movie")));
}

export async function tmdbGetTrendingSeries(options = {}) {
  const data = await tmdbFetch("/trending/tv/week", {}, options);
  return dedupeItems((data.results || []).map((i) => normalizeTmdbItem(i, "series")));
}

export async function tmdbGetPopularSeries(page = 1, options = {}) {
  const data = await tmdbFetch("/tv/popular", { page }, options);
  return dedupeItems((data.results || []).map((i) => normalizeTmdbItem(i, "series")));
}

export async function tmdbGetTopRatedSeries(page = 1, options = {}) {
  const data = await tmdbFetch("/tv/top_rated", { page }, options);
  return dedupeItems((data.results || []).map((i) => normalizeTmdbItem(i, "series")));
}

export async function tmdbGetSeriesByGenre(genreId, page = 1, options = {}) {
  const data = await tmdbFetch("/discover/tv", { with_genres: genreId, sort_by: "popularity.desc", page }, options);
  return dedupeItems((data.results || []).map((i) => normalizeTmdbItem(i, "series")));
}

// -------------------------------------------------------------
// TMDB Multi Search
// -------------------------------------------------------------

export async function tmdbSearch(query, options = {}) {
  if (!query || !query.trim()) return [];
  const data = await tmdbFetch("/search/multi", { query: query.trim(), include_adult: false }, options);
  const items = (data.results || [])
    .filter((i) => i.media_type === "movie" || i.media_type === "tv")
    .map((i) => normalizeTmdbItem(i, i.media_type === "tv" ? "series" : "movie"));
  return dedupeItems(items);
}

// -------------------------------------------------------------
// TMDB Details & Seasons/Episodes
// -------------------------------------------------------------

export async function tmdbGetDetails(type, id, options = {}) {
  const isSeries = type === "series" || type === "tv";
  const endpoint = isSeries ? `/tv/${id}` : `/movie/${id}`;

  const data = await tmdbFetch(endpoint, { append_to_response: "external_ids,credits,release_dates" }, options);
  const base = normalizeTmdbItem(data, isSeries ? "series" : "movie");

  base.tmdbId = Number(id) || data.id;
  base.imdbId = data.external_ids?.imdb_id || data.imdb_id || null;

  const runtime = data.runtime ? `${data.runtime} min` : data.episode_run_time?.[0] ? `${data.episode_run_time[0]} min` : null;
  const cast = Array.isArray(data.credits?.cast) ? data.credits.cast.slice(0, 10).map((c) => c.name) : null;
  const director = Array.isArray(data.credits?.crew) ? data.credits.crew.filter((c) => c.job === "Director").slice(0, 3).map((c) => c.name) : null;
  const writer = Array.isArray(data.credits?.crew) ? data.credits.crew.filter((c) => c.department === "Writing").slice(0, 3).map((c) => c.name) : null;

  const extended = {
    ...base,
    runtime,
    cast,
    director,
    writer,
    genres: Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [],
    status: data.status || null,
    tagline: data.tagline || null,
    numberOfSeasons: data.number_of_seasons || null,
    numberOfEpisodes: data.number_of_episodes || null,
    original_language: data.original_language || base.original_language || null,
    spoken_languages: Array.isArray(data.spoken_languages) ? data.spoken_languages : []
  };

  if (!isSeries) {
    return { ...extended, episodes: null };
  }

  // For series: fetch Season 1 episodes by default (or all seasons metadata)
  const seasonsData = (data.seasons || []).filter((s) => s.season_number != null && s.season_number > 0);
  let allEpisodes = [];

  // Fetch season 1 immediately to populate initial episode cards
  const firstSeasonNum = seasonsData[0]?.season_number || 1;
  try {
    const s1 = await tmdbFetch(`/tv/${id}/season/${firstSeasonNum}`, {}, options);
    allEpisodes = (s1.episodes || []).map((ep) => ({
      id: ep.id ? String(ep.id) : `${id}:${ep.season_number}:${ep.episode_number}`,
      tmdbId: base.tmdbId,
      imdbId: base.imdbId,
      season: ep.season_number,
      episode: ep.episode_number,
      name: ep.name || `Episode ${ep.episode_number}`,
      overview: ep.overview || null,
      thumbnail: getTmdbImageUrl(ep.still_path, "w500"),
      firstAired: ep.air_date || null,
      rating: ep.vote_average ? Number(ep.vote_average.toFixed(1)) : null,
      runtime: ep.runtime ? `${ep.runtime} min` : null
    }));
  } catch {
    // season 1 fallback
  }

  return {
    ...extended,
    seasons: seasonsData.map((s) => ({
      season: s.season_number,
      name: s.name,
      episodeCount: s.episode_count,
      poster: getTmdbImageUrl(s.poster_path, "w500")
    })),
    episodes: allEpisodes
  };
}

export async function tmdbGetSeasonEpisodes(tvId, seasonNumber, options = {}) {
  const s = await tmdbFetch(`/tv/${tvId}/season/${seasonNumber}`, {}, options);
  return (s.episodes || []).map((ep) => ({
    id: ep.id ? String(ep.id) : `${tvId}:${ep.season_number}:${ep.episode_number}`,
    tmdbId: Number(tvId),
    season: ep.season_number,
    episode: ep.episode_number,
    name: ep.name || `Episode ${ep.episode_number}`,
    overview: ep.overview || null,
    thumbnail: getTmdbImageUrl(ep.still_path, "w500"),
    firstAired: ep.air_date || null,
    rating: ep.vote_average ? Number(ep.vote_average.toFixed(1)) : null,
    runtime: ep.runtime ? `${ep.runtime} min` : null
  }));
}

// -------------------------------------------------------------
// TMDB Home Screen Row Definitions (Netflix-style UI)
// -------------------------------------------------------------

export function getTmdbHomeRowDefinitions() {
  return [
    {
      key: "trending",
      title: "Trending Movies",
      ranking: "TMDB Trending This Week",
      fetch: (options) => tmdbGetTrendingMovies(options)
    },
    {
      key: "popular-movies",
      title: "Popular Movies",
      ranking: "TMDB Popular Movies",
      fetch: (options) => tmdbGetPopularMovies(1, options)
    },
    {
      key: "now-playing",
      title: "Now Playing In Theaters",
      ranking: "TMDB Now Playing",
      fetch: (options) => tmdbGetNowPlayingMovies(1, options)
    },
    {
      key: "top-rated",
      title: "Top Rated Movies",
      ranking: "TMDB Top Rated",
      fetch: (options) => tmdbGetTopRatedMovies(1, options)
    },
    {
      key: "action-movies",
      title: "Action Thrillers",
      ranking: "TMDB Action Genre",
      fetch: (options) => tmdbGetMoviesByGenre(GENRE_MAP.Action, 1, options)
    },
    {
      key: "comedy-movies",
      title: "Comedy Movies",
      ranking: "TMDB Comedy Genre",
      fetch: (options) => tmdbGetMoviesByGenre(GENRE_MAP.Comedy, 1, options)
    },
    {
      key: "scifi-movies",
      title: "Sci-Fi & Fantasy",
      ranking: "TMDB Sci-Fi Genre",
      fetch: (options) => tmdbGetMoviesByGenre(GENRE_MAP.SciFi, 1, options)
    },
    {
      key: "horror-movies",
      title: "Horror Movies",
      ranking: "TMDB Horror Genre",
      fetch: (options) => tmdbGetMoviesByGenre(GENRE_MAP.Horror, 1, options)
    },
    {
      key: "trending-series",
      title: "Trending TV Shows",
      ranking: "TMDB Trending Series",
      fetch: (options) => tmdbGetTrendingSeries(options)
    },
    {
      key: "popular-series",
      title: "Popular TV Shows",
      ranking: "TMDB Popular Series",
      fetch: (options) => tmdbGetPopularSeries(1, options)
    },
    {
      key: "top-rated-series",
      title: "Top Rated Series",
      ranking: "TMDB Top Rated Series",
      fetch: (options) => tmdbGetTopRatedSeries(1, options)
    },
    {
      key: "animation-series",
      title: "Anime & Animated Series",
      ranking: "TMDB Animation Genre",
      fetch: (options) => tmdbGetSeriesByGenre(GENRE_MAP.AnimationTV, 1, options)
    }
  ];
}
