import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMeta,
  normalizeDetail,
  getDirectHomeRowDefinitions,
  fetchCatalog,
  directGetDetails
} from "./direct-catalog.js";

test("normalizeMeta converts Cinemeta movie item accurately", () => {
  const raw = {
    id: "tt0111161",
    name: "The Shawshank Redemption",
    type: "movie",
    poster: "https://images.metahub.space/poster/medium/tt0111161/img.jpg",
    background: "https://images.metahub.space/background/medium/tt0111161/img.jpg",
    description: "Two imprisoned men bond over a number of years...",
    year: "1994",
    genres: ["Drama", "Crime"],
    imdbRating: "9.3"
  };

  const meta = normalizeMeta(raw);
  assert.equal(meta.id, "tt0111161");
  assert.equal(meta.title, "The Shawshank Redemption");
  assert.equal(meta.type, "movie");
  assert.equal(meta.year, 1994);
  assert.equal(meta.rating, 9.3);
  assert.equal(meta.provider, "CineStream");
  assert.equal(meta.source, "CineStream");
  assert.ok(meta.sourceUrl.includes("tt0111161.json"));
});

test("normalizeDetail extracts episodes for series correctly", () => {
  const raw = {
    id: "tt0944947",
    name: "Game of Thrones",
    type: "series",
    year: "2011",
    runtime: "57 min",
    videos: [
      {
        id: "tt0944947:1:1",
        season: 1,
        number: 1,
        title: "Winter Is Coming",
        rating: "9.0"
      },
      {
        id: "tt0944947:1:2",
        season: 1,
        number: 2,
        title: "The Kingsroad",
        rating: "8.7"
      }
    ]
  };

  const detail = normalizeDetail(raw);
  assert.equal(detail.type, "series");
  assert.equal(detail.episodes.length, 2);
  assert.equal(detail.episodes[0].season, 1);
  assert.equal(detail.episodes[0].episode, 1);
  assert.equal(detail.episodes[0].name, "Winter Is Coming");
  assert.equal(detail.episodes[1].episode, 2);
});

test("getDirectHomeRowDefinitions provides all 11 homepage rows", () => {
  const rows = getDirectHomeRowDefinitions();
  assert.equal(rows.length, 11);
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, [
    "trending",
    "popular-movies",
    "new-releases",
    "top-rated",
    "action",
    "comedy",
    "horror",
    "popular-series",
    "action-series",
    "anime-airing",
    "anime-trending"
  ]);
});

test("fetchCatalog returns real metadata from Cinemeta API", async () => {
  const items = await fetchCatalog("movie", 0);
  assert.ok(Array.isArray(items));
  assert.ok(items.length > 0);
  assert.ok(items[0].id);
  assert.ok(items[0].title);
  assert.equal(items[0].type, "movie");
});

test("directGetDetails returns real movie metadata from Cinemeta API", async () => {
  const detail = await directGetDetails("movie", "tt0111161");
  assert.equal(detail.id, "tt0111161");
  assert.equal(detail.title, "The Shawshank Redemption");
  assert.equal(detail.year, 1994);
  assert.equal(detail.type, "movie");
});
