import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "./base.js";
import {
  cleanVegaTitle,
  parseVegaSearch,
  decodeDoubleAtob,
  extractDoubleAtobValue,
  extractImdbId,
  extractHostLinks,
  extractDownloadPageLinks,
  extractDirectMediaUrls,
  extractPixelDrainUrl,
  isPlaceholderMedia,
  candidateRank,
  selectMediaCandidates,
  normalizeForMatch,
  scoreTitleMatch,
  pickBestMatch,
  rankTitleCandidates,
  VegaMoviesProvider
} from "./vegamovies.js";

test("rankTitleCandidates ranks by score, prefers the requested type, and dedupes", () => {
  const items = [
    { id: "/a/", title: "War Dogs", year: 2016, type: "series" },
    { id: "/b/", title: "War Dogs", year: 2016, type: "movie" },
    { id: "/c/", title: "Dogs of War", year: 2023, type: "movie" },
    { id: "/a/", title: "War Dogs", year: 2016, type: "series" }
  ];
  const ranked = rankTitleCandidates(items, { title: "War Dogs", year: 2016, type: "movie" });
  assert.equal(ranked[0].item.id, "/b/");
  assert.equal(ranked[0].item.type, "movie");
  assert.equal(ranked.filter((entry) => entry.item.id === "/a/").length, 1);
});

test("resolveByTitle tries the next candidate when the first fails extraction", { timeout: 30000 }, async () => {
  const first = { id: "/war-dogs-2000/", title: "War Dogs", year: 2016, type: "movie" };
  const second = { id: "/war-dogs-2016/", title: "War Dogs", year: 2016, type: "movie" };

  const provider = new VegaMoviesProvider({ cache: null });
  provider.search = async () => [first, second];
  const attempts = [];
  provider.getDetails = async (type, id) => ({ id, type, title: "War Dogs", year: 2016, sourceUrl: `https://vegamovies.gallery${id}` });
  provider.resolveStream = async (detail) => {
    attempts.push(detail.id);
    if (detail.id === first.id) {
      throw new ProviderError("no candidates passed ffprobe validation", "unsupported");
    }
    return {
      url: "https://cdn.example.net/war-dogs.mkv?sig=1",
      headers: { Referer: "https://vegamovies.gallery/" },
      mediaType: "mkv",
      sourceType: "provider"
    };
  };

  const source = await provider.resolveByTitle({ title: "War Dogs", year: 2016, type: "movie" });
  assert.equal(source.url, "https://cdn.example.net/war-dogs.mkv?sig=1");
  assert.deepEqual(attempts, [first.id, second.id]);
  assert.equal(source.attempts.filter((attempt) => !attempt.ok).length, 1);
  assert.match(source.note, /candidate 2 of 2/);
});

test("resolveByTitle reports every failed candidate when none yield media", { timeout: 30000 }, async () => {
  const items = [
    { id: "/one/", title: "Some Movie", year: 2020, type: "movie" },
    { id: "/two/", title: "Some Movie", year: 2020, type: "movie" }
  ];
  const provider = new VegaMoviesProvider({ cache: null });
  provider.search = async () => items;
  provider.getDetails = async (type, id) => ({ id, type, title: "Some Movie", year: 2020, sourceUrl: `https://vegamovies.gallery${id}` });
  provider.resolveStream = async () => {
    throw new ProviderError("no candidates passed ffprobe validation", "unsupported");
  };

  await assert.rejects(
    () => provider.resolveByTitle({ title: "Some Movie", year: 2020, type: "movie" }),
    (err) => err instanceof ProviderError && /matched 2 candidate\(s\)/.test(err.message) && /ffprobe/.test(err.message)
  );
});

test("resolveByTitle rejects unknown titles honestly (no fabricated source)", { timeout: 30000 }, async () => {
  const provider = new VegaMoviesProvider({ cache: null });
  provider.search = async () => [{ id: "/unrelated/", title: "Completely Different Movie", year: 1999, type: "movie" }];
  await assert.rejects(
    () => provider.resolveByTitle({ title: "War Dogs", year: 2016, type: "movie" }),
    (err) => err instanceof ProviderError && err.code === "not_found"
  );
});

test("scoreTitleMatch prefers exact, then prefix, then partial matches", () => {
  const exact = scoreTitleMatch("War Dogs", "War Dogs", 2016, 2016);
  const prefix = scoreTitleMatch("War Dogs", "War Dogs: The Story", null, 2016);
  const partial = scoreTitleMatch("War Dogs", "Dogs of War", null, 2016);
  const none = scoreTitleMatch("War Dogs", "The Matrix", null, 1999);
  assert.ok(exact > prefix);
  assert.ok(prefix > partial);
  assert.equal(none, 0);
});

test("scoreTitleMatch rewards the matching year and penalises far-off years", () => {
  const sameYear = scoreTitleMatch("Dune", "Dune", 2021, 2021);
  const offYear = scoreTitleMatch("Dune", "Dune", 1984, 2021);
  assert.ok(sameYear > offYear);
});

test("pickBestMatch chooses the closest real provider page", () => {
  const items = [
    { id: "/dogs-of-war/", title: "Dogs of War", year: 2023, type: "movie" },
    { id: "/war-dogs-2016/", title: "War Dogs", year: 2016, type: "movie" },
    { id: "/war-dogs-2/", title: "War Dogs", year: 2024, type: "movie" }
  ];
  const best = pickBestMatch(items, { title: "War Dogs", year: 2016 });
  assert.equal(best.item.id, "/war-dogs-2016/");

  assert.equal(pickBestMatch(items, { title: "Completely Unrelated", year: 1999 }), null);
});

test("normalizeForMatch strips punctuation and case", () => {
  assert.equal(normalizeForMatch("Spider-Man: Across the Spider-Verse!"), "spider man across the spider verse");
});

test("placeholder media (unpkg/site.webm) is excluded from candidates", () => {
  assert.equal(isPlaceholderMedia("https://unpkg.com/site.webm"), true);
  assert.equal(isPlaceholderMedia("https://cdn.example.com/sample.mp4"), true);
  assert.equal(isPlaceholderMedia("https://x.r2.cloudflarestorage.com/hub/movie.mkv?sig=1"), false);
});

test("candidateRank orders mkv/mp4 before hls and webm", () => {
  assert.ok(candidateRank("https://h/movie.mkv?sig=1") < candidateRank("https://h/index.m3u8"));
  assert.ok(candidateRank("https://h/index.m3u8") < candidateRank("https://h/clip.webm"));
});

test("selectMediaCandidates drops placeholders and prefers real files", () => {
  const picked = selectMediaCandidates([
    "https://unpkg.com/site.webm",
    "https://h/clip.webm",
    "https://h/index.m3u8",
    "https://h/movie.mkv?sig=abc"
  ]);
  assert.deepEqual(picked, ["https://h/movie.mkv?sig=abc", "https://h/index.m3u8", "https://h/clip.webm"]);
});

test("resolveStream skips a placeholder and returns the real media URL", async () => {
  const realMedia = "https://x.r2.cloudflarestorage.com/hub2/Movie.720p.x264.tw.mkv?X-Amz-Signature=abc";
  const tokenInner = "https://vcloud.beer/tok1?token=xyz";
  const encodedToken = Buffer.from(Buffer.from(tokenInner, "utf8").toString("base64"), "utf8").toString("base64");
  const pages = {
    "https://vegamovies.gallery/download-movie/":
      '<a href="https://nexdrive.beer/genxfm1/"><button class="dwd-button">Download Now</button></a>',
    "https://nexdrive.beer/genxfm1/": '<a href="https://vcloud.beer/abc123">V-Cloud</a>',
    "https://vcloud.beer/abc123": `<script>var url = atob(atob('${encodedToken}'))</script>`,
    [tokenInner]: `<video src="https://unpkg.com/site.webm"></video><p>${realMedia}</p>`
  };
  const provider = new VegaMoviesProvider({ cache: null });
  provider.getBaseUrl = async () => "https://vegamovies.gallery";
  provider.fetchText = async (url) => {
    if (pages[url]) return pages[url];
    throw new Error(`unexpected fetch: ${url}`);
  };
  provider.isPlayableMedia = async (url) => url === realMedia;

  const source = await provider.resolveStream({
    id: "/download-movie/",
    sourceUrl: "https://vegamovies.gallery/download-movie/"
  });
  assert.equal(source.url, realMedia);
});


test("resolveStream follows detail -> download page -> host -> vcloud token -> media", async () => {
  const mediaUrl =
    "https://abc.r2.cloudflarestorage.com/hub2/Movie.720p.x264.tw.mkv?X-Amz-Signature=abc&X-Amz-Expires=10800";
  const tokenInner = "https://vcloud.beer/tok123?token=xyz";
  const encodedToken = Buffer.from(Buffer.from(tokenInner, "utf8").toString("base64"), "utf8").toString("base64");

  const pages = {
    "https://vegamovies.gallery/download-movie/":
      '<a href="https://nexdrive.beer/genxfm1/"><button class="dwd-button">Download Now</button></a>',
    "https://nexdrive.beer/genxfm1/":
      '<a href="https://vcloud.beer/abc123">V-Cloud</a><a href="https://other.example/x">other</a>',
    "https://vcloud.beer/abc123": `<script>var url = atob(atob('${encodedToken}'))</script>`,
    [tokenInner]: `<p>${mediaUrl}</p>`
  };

  const provider = new VegaMoviesProvider({ cache: null });
  provider.getBaseUrl = async () => "https://vegamovies.gallery";
  provider.fetchText = async (url) => {
    if (pages[url]) return pages[url];
    throw new Error(`unexpected fetch: ${url}`);
  };
  provider.isPlayableMedia = async (url) => url === mediaUrl;

  const source = await provider.resolveStream({
    id: "/download-movie/",
    sourceUrl: "https://vegamovies.gallery/download-movie/"
  });
  assert.equal(source.url, mediaUrl);
  assert.equal(source.sourceType, "provider");
  assert.equal(source.mediaType, "mkv");
});

test("resolveStream throws a clear error when the chain yields no playable media", async () => {
  const provider = new VegaMoviesProvider({ cache: null });
  provider.getBaseUrl = async () => "https://vegamovies.gallery";
  provider.fetchText = async () => "<html>nothing here</html>";
  provider.isPlayableMedia = async () => false;
  await assert.rejects(
    () =>
      provider.resolveStream({
        id: "/download-movie/",
        sourceUrl: "https://vegamovies.gallery/download-movie/"
      }),
    /passed ffprobe validation/
  );
});

test("cleanVegaTitle strips provider noise and extracts the year", () => {
  assert.deepEqual(
    cleanVegaTitle("Download Beast of War (2025) BluRay Dual Audio {Hindi-English} 480p [380MB] | 720p [810MB]"),
    { title: "Beast of War", year: 2025 }
  );
  assert.deepEqual(cleanVegaTitle("Download The Brink of War (2026) WEB-DL {English With Subtitles} Full Movie 720p"), {
    title: "The Brink of War",
    year: 2026
  });
});

test("cleanVegaTitle falls back without a year marker", () => {
  const result = cleanVegaTitle("Download Some Movie 1080p WEB-DL Hindi");
  assert.equal(result.year, null);
  assert.equal(result.title, "Some Movie");
});

test("parseVegaSearch normalizes provider search JSON", () => {
  const json = {
    hits: [
      {
        document: {
          id: "261345",
          post_title: "Download The Brink of War (2026) WEB-DL {English} Full Movie 720p & 1080p x264",
          permalink: "/download-the-brink-of-war-2026-english-full-movie-480p-720p-1080p-web-dl/",
          post_thumbnail: "https://image.tmdb.org/t/p/w500/vCIQeQ2ynVqEjIvtbOXGnKtcgAX.jpg"
        }
      }
    ]
  };
  const items = parseVegaSearch(json);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "The Brink of War");
  assert.equal(items[0].year, 2026);
  assert.equal(items[0].provider, "VegaMovies");
  assert.equal(items[0].type, "movie");
  assert.equal(items[0].id, "/download-the-brink-of-war-2026-english-full-movie-480p-720p-1080p-web-dl/");
  assert.ok(items[0].poster.startsWith("https://"));
});

test("parseVegaSearch marks web-series posts as series", () => {
  const items = parseVegaSearch({
    hits: [{ document: { post_title: "Download Some Show Season 1 (2024) Web Series", permalink: "/some-show/", post_thumbnail: null } }]
  });
  assert.equal(items[0].type, "series");
});

test("parseVegaSearch tolerates an empty or malformed payload", () => {
  assert.deepEqual(parseVegaSearch({}), []);
  assert.deepEqual(parseVegaSearch(null), []);
});

test("decodeDoubleAtob decodes two base64 layers", () => {
  const inner = "https://vcloud.beer/abc?token=xyz";
  const once = Buffer.from(inner, "utf8").toString("base64");
  const twice = Buffer.from(once, "utf8").toString("base64");
  assert.equal(decodeDoubleAtob(twice), inner);
  assert.equal(extractDoubleAtobValue(`<script>var url = atob(atob('${twice}'))</script>`), inner);
});

test("extractImdbId finds the imdb title id", () => {
  assert.equal(
    extractImdbId('<a href="https://www.imdb.com/title/tt33070884/">IMDb</a>'),
    "tt33070884"
  );
  assert.equal(extractImdbId("<html></html>"), null);
});

test("extractHostLinks keeps only known file-host links", () => {
  const html = `
    <a href="https://velvet.nexdrive.beer/genxfm/1/">no</a>
    <a href="https://vcloud.beer/tkvksi3i">vc</a>
    <a href="https://fastdl.beer/embed.php?download=ABC">fd</a>
    <a href="https://example.com/other">other</a>
  `;
  const links = extractHostLinks(html);
  assert.equal(links.length, 2);
  assert.ok(links.some((l) => l.includes("vcloud.beer")));
  assert.ok(links.some((l) => l.includes("fastdl.beer")));
});

test("extractDownloadPageLinks finds anchors wrapping the download button", () => {
  const html = '<a class="btn" href="https://nexdrive.beer/genxfm784776505997/"><button class="dwd-button">Download Now</button></a>';
  const links = extractDownloadPageLinks(html, "https://vegamovies.gallery/");
  assert.deepEqual(links, ["https://nexdrive.beer/genxfm784776505997/"]);
});

test("extractDirectMediaUrls finds signed media URLs", () => {
  const html = `<p>https://abc.r2.cloudflarestorage.com/hub2/Movie.2026.720p.x264.tw.mkv?X-Amz-Signature=deadbeef&amp;X-Amz-Expires=10800</p>`;
  const urls = extractDirectMediaUrls(html);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes(".mkv"));
});

test("extractPixelDrainUrl reads the pxl variable", () => {
  const html = `<script>var pxl = "https://pixeldrain.dev/u/ERUgNqDs"</script>`;
  assert.equal(extractPixelDrainUrl(html), "https://pixeldrain.dev/u/ERUgNqDs");
  assert.equal(extractPixelDrainUrl("<script></script>"), null);
});
