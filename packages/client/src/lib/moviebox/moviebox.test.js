import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanMovieboxTitle,
  isDeprecationNoticeUrl,
  resolveDashOrHlsManifestFromPolicy,
  extractSubtitles,
  movieboxSubjectToCatalogItem,
  movieboxResolveStreams
} from "./adapt.js";
import {
  generateXClientToken,
  generateXTrSignature,
  buildSignedHeaders,
  md5Hex
} from "./crypto.js";
import { parseJwtClaims, MovieBoxSession } from "./session.js";

test("cleanMovieboxTitle removes brackets, tags, and language suffixes", () => {
  assert.equal(cleanMovieboxTitle("[1080p] Inception [Dual Audio]"), "Inception");
  assert.equal(cleanMovieboxTitle("Interstellar (2014)"), "Interstellar (2014)");
  assert.equal(cleanMovieboxTitle("Avengers (Fan Made)"), "Avengers");
  assert.equal(cleanMovieboxTitle("Money Heist - Hindi"), "Money Heist");
  assert.equal(cleanMovieboxTitle("Breaking Bad S01-S05"), "Breaking Bad");
  assert.equal(cleanMovieboxTitle("Dark Season 2"), "Dark");
  assert.equal(cleanMovieboxTitle("Stranger Things 1080p"), "Stranger Things");
});

test("isDeprecationNoticeUrl detects notice MP4 files", () => {
  assert.equal(
    isDeprecationNoticeUrl("https://macdn.aoneroom.com/other/2026/09/04/b164fbfb4347792950bdfbfb563d39d9.mp4"),
    true
  );
  assert.equal(
    isDeprecationNoticeUrl("https://example.com/videos/notice.mp4"),
    true
  );
  assert.equal(
    isDeprecationNoticeUrl("https://sacdn.example.com/dash/12345/index.mpd"),
    false
  );
});

test("resolveDashOrHlsManifestFromPolicy parses Edge-Cache and CloudFront cookies", () => {
  const edgeCookie =
    "Edge-Cache-Cookie=urlprefix=aHR0cHM6Ly9zYmNkbjMuaGFrdW5heW1hdGF0YS5jb20vZGFzaC8zMjY0NzcyNTg4MzMzMTU3NDI0XzBfMF8xMDgwX2gyNjVfNTYwLw:sign=abc:t=123";
  assert.equal(
    resolveDashOrHlsManifestFromPolicy(edgeCookie),
    "https://sbcdn3.hakunaymatata.com/dash/3264772588333157424_0_0_1080_h265_560/index.mpd"
  );

  const hlsCookie =
    "Edge-Cache-Cookie=urlprefix=aHR0cHM6Ly9zYmNkbjMuaGFrdW5heW1hdGF0YS5jb20vaGxzLzEyMzQ1LzcyMC8:sign=abc:t=123";
  assert.equal(
    resolveDashOrHlsManifestFromPolicy(hlsCookie),
    "https://sbcdn3.hakunaymatata.com/hls/12345/720/index.m3u8"
  );
});

test("parseJwtClaims extracts uid and expiration", () => {
  const expTime = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ userId: "998877", exp: expTime })).toString("base64");
  const token = `header.${payload}.signature`;
  const { uid, exp } = parseJwtClaims(token);
  assert.equal(uid, "998877");
  assert.equal(exp, expTime);

  const session = MovieBoxSession.fromToken(token);
  assert.equal(session.userId, "998877");
  assert.equal(session.isValid(), true);
});

test("buildSignedHeaders creates proper MovieBox headers", () => {
  const ts = 1730000000000;
  const headers = buildSignedHeaders({
    method: "POST",
    url: "https://api6.aoneroom.com/wefeed-mobile-bff/user-api/visitor-login",
    body: "{}",
    authToken: "token_123",
    userAgent: "CustomUA/1.0",
    clientInfo: '{"package_name":"com.community.oneroom"}',
    spoofedIp: "1.2.3.4",
    timestampMs: ts
  });

  assert.equal(headers["User-Agent"], "CustomUA/1.0");
  assert.equal(headers["x-forwarded-for"], "1.2.3.4");
  assert.equal(headers.Authorization, "Bearer token_123");
  assert.match(headers["x-client-token"], /^1730000000000,[a-f0-9]{32}$/);
  assert.match(headers["x-tr-signature"], /^1730000000000\|2\|/);
});

test("movieboxSubjectToCatalogItem converts subject correctly", () => {
  const subject = {
    subjectId: "123456",
    title: "Inception [1080p]",
    subjectType: 1,
    releaseDate: "2010-07-16",
    cover: { url: "https://example.com/cover.jpg" },
    imdbRatingValue: "8.8"
  };

  const item = movieboxSubjectToCatalogItem(subject);
  assert.equal(item.id, "123456");
  assert.equal(item.title, "Inception");
  assert.equal(item.type, "movie");
  assert.equal(item.year, "2010");
  assert.equal(item.poster, "https://example.com/cover.jpg");
  assert.equal(item.rating, "8.8");
  assert.equal(item.provider, "MovieBox");
});

test("movieboxResolveStreams resolves qualities and audio dubs", async () => {
  const mockClient = {
    async get(path) {
      if (path.includes("play-info")) {
        return {
          title: "Test Film",
          displayResolutions: "1080,720,480",
          streams: [
            {
              id: "st_1",
              format: "MP4",
              codecName: "h264",
              resolutions: "1080,720,480",
              url: "https://example.com/stream.m3u8"
            }
          ],
          extCaptions: [
            { lanName: "English", lan: "en", url: "https://example.com/en.srt" }
          ]
        };
      }
      return { list: [] };
    }
  };

  const resolved = await movieboxResolveStreams({
    subjectId: "123456",
    details: {
      dubs: [
        { subjectId: "123456", language: "English", label: "English Original" },
        { subjectId: "654321", language: "Hindi", label: "Hindi Dub" }
      ]
    },
    options: { client: mockClient }
  });

  assert.equal(resolved.sourceUrl, "https://example.com/stream.m3u8");
  assert.equal(resolved.isHls, true);
  assert.equal(resolved.qualities.length, 3);
  assert.equal(resolved.qualities[0].label, "1080p");
  assert.equal(resolved.qualities[1].label, "720p");
  assert.equal(resolved.qualities[2].label, "480p");
  assert.equal(resolved.audioTracks.length, 2);
  assert.equal(resolved.audioTracks[0].label, "English Original");
  assert.equal(resolved.audioTracks[1].label, "Hindi Dub");
  assert.equal(resolved.subtitles.length, 1);
});
