import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTmdbItem,
  getTmdbImageUrl,
  parseYear,
  getTmdbHomeRowDefinitions,
  tmdbGetTrendingMovies,
  tmdbSearch,
  tmdbGetDetails
} from "./tmdb-catalog.js";

test("getTmdbImageUrl creates full TMDB CDN URLs accurately", () => {
  assert.equal(getTmdbImageUrl("/sample.jpg", "w500"), "https://image.tmdb.org/t/p/w500/sample.jpg");
  assert.equal(getTmdbImageUrl("/backdrop.jpg", "w1280"), "https://image.tmdb.org/t/p/w1280/backdrop.jpg");
  assert.equal(getTmdbImageUrl("https://custom.com/img.jpg"), "https://custom.com/img.jpg");
  assert.equal(getTmdbImageUrl(null), null);
});

test("parseYear extracts 4-digit release year correctly", () => {
  assert.equal(parseYear("2024-03-01"), 2024);
  assert.equal(parseYear("1999-10-15"), 1999);
  assert.equal(parseYear("invalid"), null);
  assert.equal(parseYear(null), null);
});

test("normalizeTmdbItem normalizes a TMDB movie item", () => {
  const raw = {
    id: 550,
    title: "Fight Club",
    poster_path: "/bptfVGEQuv6vDTIMVCHjJ9Dz8PX.jpg",
    backdrop_path: "/hZkgoQYus5vegHoetLkCJzb17zJ.jpg",
    overview: "A ticking-time-bomb insomniac...",
    release_date: "1999-10-15",
    vote_average: 8.433,
    vote_count: 28000,
    popularity: 95.5
  };

  const item = normalizeTmdbItem(raw, "movie");
  assert.equal(item.id, "550");
  assert.equal(item.tmdbId, 550);
  assert.equal(item.title, "Fight Club");
  assert.equal(item.type, "movie");
  assert.equal(item.year, 1999);
  assert.equal(item.rating, 8.4);
  assert.equal(item.provider, "TMDB");
  assert.equal(item.source, "TMDB");
  assert.equal(item.poster, "https://image.tmdb.org/t/p/w500/bptfVGEQuv6vDTIMVCHjJ9Dz8PX.jpg");
});

test("normalizeTmdbItem normalizes a TMDB TV show item", () => {
  const raw = {
    id: 1399,
    name: "Game of Thrones",
    poster_path: "/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg",
    backdrop_path: "/suopoADq0k8YZr4dQXcU6p0jYx2.jpg",
    overview: "Seven noble families fight for control...",
    first_air_date: "2011-04-17",
    vote_average: 8.4
  };

  const item = normalizeTmdbItem(raw, "series");
  assert.equal(item.id, "1399");
  assert.equal(item.tmdbId, 1399);
  assert.equal(item.title, "Game of Thrones");
  assert.equal(item.type, "series");
  assert.equal(item.year, 2011);
  assert.equal(item.rating, 8.4);
  assert.equal(item.provider, "TMDB");
});

test("getTmdbHomeRowDefinitions provides Netflix-style row definitions", () => {
  const rows = getTmdbHomeRowDefinitions();
  assert.ok(rows.length >= 10);
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes("trending"));
  assert.ok(keys.includes("popular-movies"));
  assert.ok(keys.includes("top-rated"));
  assert.ok(keys.includes("trending-series"));
});

test("tmdbGetTrendingMovies returns real trending movies from TMDB API", async () => {
  const items = await tmdbGetTrendingMovies();
  assert.ok(Array.isArray(items));
  assert.ok(items.length > 0);
  assert.ok(items[0].tmdbId);
  assert.ok(items[0].title);
  assert.equal(items[0].provider, "TMDB");
});

test("tmdbGetDetails returns real movie metadata with external IDs", async () => {
  const item = await tmdbGetDetails("movie", 550);
  assert.equal(item.title, "Fight Club");
  assert.equal(item.tmdbId, 550);
  assert.equal(item.imdbId, "tt0137523");
  assert.ok(Array.isArray(item.genres));
});
