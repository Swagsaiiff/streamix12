// MovieBox parser, title cleaner, stream extractor, and catalog adapter

import { defaultMovieBoxClient } from "./client.js";

export const STREAM_REFERER = "https://sportslive.wine";

export function cleanMovieboxTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== "string") return "";
  let title = rawTitle.trim();
  if (!title) return "";

  // Strip leading brackets like [1080p], [Dual Audio], etc.
  while (title.startsWith("[")) {
    const closePos = title.indexOf("]");
    if (closePos !== -1) {
      const rem = title.slice(closePos + 1).trim();
      if (rem) {
        title = rem;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // Strip trailing bracketed content
  const openBracket = title.indexOf("[");
  if (openBracket > 0) {
    title = title.slice(0, openBracket).trim();
  }

  // Strip parenthetical content unless it's a 4-digit release year (1900-2099)
  const openParen = title.indexOf("(");
  if (openParen > 0) {
    const inside = title.slice(openParen + 1).split(")")[0].trim();
    const isYear = /^(19|20)\d{2}$/.test(inside);
    if (!isYear) {
      title = title.slice(0, openParen).trim();
    }
  }

  // Strip audio / language tags like " - Hindi", " - Dual Audio"
  const dashPos = title.lastIndexOf(" - ");
  if (dashPos !== -1) {
    const suffix = title.slice(dashPos + 3).toLowerCase();
    const tagKeywords = [
      "hindi", "tamil", "telugu", "kannada", "malayalam", "bengali", "marathi", "punjabi",
      "gujarati", "urdu", "english", "spanish", "french", "german", "italian", "japanese",
      "korean", "chinese", "russian", "portuguese", "turkish", "arabic", "dub", "audio",
      "multi", "season"
    ];
    if (tagKeywords.some((kw) => suffix.includes(kw)) || /^s\d+/i.test(suffix)) {
      title = title.slice(0, dashPos).trim();
    }
  }

  // Strip trailing " S1", " S02", " Season 1"
  title = title.replace(/\s+S\d+(-S\d+)?$/i, "").trim();
  title = title.replace(/\s+Season\s+\d+$/i, "").trim();

  // Strip resolution tags at the end like 1080p, 720p, 4k
  title = title.replace(/[._\s-](1080p|720p|480p|2160p|4k|hd|web-dl|bluray)$/i, "").trim();

  return title;
}

export function isDeprecationNoticeUrl(url) {
  if (!url || typeof url !== "string") return false;
  const lower = url.toLowerCase();
  return (
    lower.includes("1c7de0bd3393702d9191801f15f88f8d") ||
    lower.includes("9a0461bc39da389663bf3dbb17091d3f") ||
    lower.includes("b164fbfb4347792950bdfbfb563d39d9") ||
    lower.includes("/notice.mp4") ||
    (lower.includes("macdn.aoneroom.com") && lower.includes("/other/"))
  );
}

function decodeB64Padded(s) {
  let normalized = s.replace(/-/g, "+").replace(/_/g, "/").replace(/~/g, "/");
  const pad = (4 - (normalized.length % 4)) % 4;
  if (pad > 0) {
    normalized += "=".repeat(pad);
  }
  try {
    if (typeof atob === "function") {
      return atob(normalized);
    }
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function resolveDashOrHlsManifestFromPolicy(signCookie) {
  if (!signCookie || typeof signCookie !== "string") return null;

  for (const part of signCookie.split(";")) {
    const trimmed = part.trim();

    // Check urlprefix in Edge-Cache-Cookie
    if (trimmed.includes("urlprefix=")) {
      const idx = trimmed.indexOf("urlprefix=");
      const prefixPart = trimmed.slice(idx + "urlprefix=".length);
      const b64Token = prefixPart.split(":")[0].trim();
      const decoded = decodeB64Padded(b64Token);
      if (decoded) {
        const base = decoded.replace(/[*]+$/, "").replace(/\/+$/, "");
        if (base.startsWith("http://") || base.startsWith("https://")) {
          if (base.includes("/hls/")) {
            return `${base}/index.m3u8`;
          }
          if (base.includes("/dash/")) {
            return `${base}/index.mpd`;
          }
          return base;
        }
      }
    }

    // Check CloudFront-Policy
    if (trimmed.startsWith("CloudFront-Policy=")) {
      const policyRaw = trimmed.replace("CloudFront-Policy=", "").trim();
      const decoded = decodeB64Padded(policyRaw);
      if (decoded) {
        try {
          const json = JSON.parse(decoded);
          const resource = json?.Statement?.[0]?.Resource;
          if (resource && typeof resource === "string") {
            const base = resource.replace(/[*]+$/, "").replace(/\/+$/, "");
            if (base.startsWith("http://") || base.startsWith("https://")) {
              if (base.includes("/hls/")) {
                return `${base}/index.m3u8`;
              }
              if (base.includes("/dash/")) {
                return `${base}/index.mpd`;
              }
              return base;
            }
          }
        } catch {
          // invalid JSON
        }
      }
    }
  }

  return null;
}

export function extractSubtitles(playInfoPayload) {
  const captions =
    playInfoPayload?.extCaptions ||
    playInfoPayload?.data?.extCaptions ||
    [];

  if (!Array.isArray(captions)) return [];

  const seen = new Set();
  const options = [];

  for (const cap of captions) {
    const url = cap.url;
    if (!url || typeof url !== "string" || !url.startsWith("http")) continue;
    if (url.includes("aa348f2541d13ffe")) continue; // common corrupted dummy caption
    if (seen.has(url)) continue;
    seen.add(url);

    const name = cap.lanName?.trim() || cap.lan || "Unknown";
    options.push({
      label: name,
      language: cap.lan || name.toLowerCase().slice(0, 2),
      url
    });
  }

  return options;
}

export function movieboxSubjectToCatalogItem(s) {
  if (!s || typeof s !== "object") return null;

  const id = s.subjectId != null ? String(s.subjectId) : s.id != null ? String(s.id) : null;
  if (!id) return null;

  const rawTitle = s.title || s.name || "Unknown";
  const title = cleanMovieboxTitle(rawTitle);

  const stype = s.subjectType != null ? Number(s.subjectType) : Number(s.stype) || 1;
  const isSeries = stype === 2;

  let year = null;
  const releaseInfo = s.releaseDate || s.year || s.releaseInfo || "";
  const yearMatch = String(releaseInfo).match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch) {
    year = yearMatch[1];
  }

  const poster = s.cover?.url || s.coverUrl || s.poster || s.pic || null;
  const backdrop = s.backdrop?.url || s.backdropUrl || poster;

  const rating = s.imdbRatingValue
    ? String(s.imdbRatingValue)
    : s.rating
      ? Number(s.rating).toFixed(1)
      : null;

  return {
    id,
    title,
    rawTitle,
    type: isSeries ? "series" : "movie",
    year,
    poster,
    backdrop,
    rating,
    seasonCount: s.season != null ? Number(s.season) : undefined,
    provider: "MovieBox"
  };
}

export async function movieboxSearch(query, page = 1, options = {}) {
  const payload = {
    keyword: query,
    page,
    perPage: 15,
    subjectType: 0
  };

  const client = options.client || defaultMovieBoxClient;
  const data = await client.post("/wefeed-mobile-bff/subject-api/search/v2", payload, options);

  const subjects =
    data?.results?.[0]?.subjects ||
    data?.subjects ||
    data?.list ||
    [];

  const items = [];
  const seen = new Set();
  for (const s of subjects) {
    const item = movieboxSubjectToCatalogItem(s);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }

  return items;
}

export async function movieboxGetDetails(subjectId, options = {}) {
  const client = options.client || defaultMovieBoxClient;
  const data = await client.get(`/wefeed-mobile-bff/subject-api/get?subjectId=${encodeURIComponent(subjectId)}`, options);

  const subject = data?.subject || data;
  if (!subject) {
    throw new Error(`MovieBox details not found for subjectId ${subjectId}`);
  }

  const baseItem = movieboxSubjectToCatalogItem(subject);
  const stype = subject.subjectType != null ? Number(subject.subjectType) : 1;

  let seasons = [];
  if (stype === 2) {
    try {
      const seasonInfo = await client.get(`/wefeed-mobile-bff/subject-api/season-info?subjectId=${encodeURIComponent(subjectId)}`, options);
      const seasonsArr = seasonInfo?.seasons || seasonInfo?.data?.seasons || [];
      for (const s of seasonsArr) {
        const seNum = Number(s.se || 1);
        const episodes = [];
        if (Array.isArray(s.episodeNumbers)) {
          for (const epNum of s.episodeNumbers) {
            episodes.push({
              season: seNum,
              episode: Number(epNum),
              name: `Episode ${epNum}`,
              title: `Episode ${epNum}`
            });
          }
        } else if (s.maxEp) {
          for (let ep = 1; ep <= Number(s.maxEp); ep++) {
            episodes.push({
              season: seNum,
              episode: ep,
              name: `Episode ${ep}`,
              title: `Episode ${ep}`
            });
          }
        }
        seasons.push({ season: seNum, episodes });
      }
    } catch {
      // ignore season fetch failure
    }
  }

  // Multi-audio dubs
  const dubs = [];
  if (Array.isArray(subject.dubs)) {
    for (const d of subject.dubs) {
      const dubId = d.subjectId != null ? String(d.subjectId) : d.id != null ? String(d.id) : null;
      if (dubId) {
        dubs.push({
          subjectId: dubId,
          language: d.lanName || d.language || "Unknown",
          label: d.title || d.name || d.lanName || "Audio Dub"
        });
      }
    }
  }

  return {
    ...baseItem,
    overview: subject.description || subject.intro || "",
    director: subject.director || null,
    stars: subject.stars || null,
    genres: Array.isArray(subject.genre || subject.genres)
      ? (subject.genre || subject.genres).map(String)
      : [],
    duration: subject.duration ? `${Math.floor(Number(subject.duration) / 60)}m` : null,
    episodes: seasons.flatMap((s) => s.episodes),
    seasons,
    dubs,
    provider: "MovieBox"
  };
}

export async function movieboxGetPlayInfo(subjectId, season = 0, episode = 0, options = {}) {
  const client = options.client || defaultMovieBoxClient;
  const path = (season === 0 && episode === 0)
    ? `/wefeed-mobile-bff/subject-api/play-info/v2?subjectId=${encodeURIComponent(subjectId)}`
    : `/wefeed-mobile-bff/subject-api/play-info/v2?subjectId=${encodeURIComponent(subjectId)}&se=${season}&ep=${episode}`;

  return client.get(path, options);
}

export async function movieboxGetResources(subjectId, season = 0, episode = 0, page = 1, options = {}) {
  const client = options.client || defaultMovieBoxClient;
  const path = (season === 0 && episode === 0)
    ? `/wefeed-mobile-bff/subject-api/resource?subjectId=${encodeURIComponent(subjectId)}&page=${page}&perPage=20`
    : `/wefeed-mobile-bff/subject-api/resource?subjectId=${encodeURIComponent(subjectId)}&se=${season}&ep=${episode}&page=${page}&perPage=20`;

  return client.get(path, options).catch(() => ({ list: [] }));
}

export async function movieboxResolveStreams({
  subjectId,
  season = 0,
  episode = 0,
  details = null,
  options = {}
}) {
  const [playInfoRes, resourcesRes] = await Promise.allSettled([
    movieboxGetPlayInfo(subjectId, season, episode, options),
    movieboxGetResources(subjectId, season, episode, 1, options)
  ]);

  const playInfo = playInfoRes.status === "fulfilled" ? playInfoRes.value : null;
  const resources = resourcesRes.status === "fulfilled" ? resourcesRes.value : null;

  const subtitles = extractSubtitles(playInfo);

  const streams = playInfo?.streams || playInfo?.data?.streams || [];
  const resourceList = resources?.list || resources?.data?.list || [];

  const qualities = [];
  const audioTracks = [];
  const seenQualities = new Set();
  const seenUrls = new Set();

  // Populate audio options from details.dubs
  if (details?.dubs && details.dubs.length > 0) {
    for (let i = 0; i < details.dubs.length; i++) {
      const dub = details.dubs[i];
      audioTracks.push({
        id: String(i),
        label: dub.label || dub.language,
        language: dub.language?.toLowerCase()?.slice(0, 2) || "en",
        subjectId: dub.subjectId,
        isPlayable: true
      });
    }
  }

  // 1. Process playInfo streams (HLS / DASH / MP4)
  for (const st of streams) {
    const rawUrl = st.url || "";
    const signCookie = st.signCookie || "";

    const manifestUrl = resolveDashOrHlsManifestFromPolicy(signCookie) || (
      !isDeprecationNoticeUrl(rawUrl) && rawUrl.startsWith("http") ? rawUrl : null
    );

    if (!manifestUrl) continue;

    const cookieHeader = signCookie
      ? signCookie.trim().replace(/;+$/, "").split(";").map((s) => s.trim()).filter(Boolean).join("; ")
      : "";

    const streamHeaders = {
      Referer: STREAM_REFERER,
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    };

    const isHls = manifestUrl.includes(".m3u8") || manifestUrl.includes("/hls/");
    const isDash = manifestUrl.includes(".mpd") || manifestUrl.includes("/dash/");

    // Resolutions list
    const resString = st.resolutions || playInfo?.displayResolutions || "1080,720,480";
    const resNumbers = resString
      .split(",")
      .map((r) => parseInt(r.trim(), 10))
      .filter((n) => !Number.isNaN(n) && n > 0)
      .sort((a, b) => b - a);

    const resolutions = resNumbers.length > 0 ? resNumbers : [720];

    for (const res of resolutions) {
      const label = `${res}p`;
      if (!seenQualities.has(label)) {
        seenQualities.add(label);
        qualities.push({
          label,
          height: res,
          url: manifestUrl,
          mediaType: isHls ? "hls" : isDash ? "dash" : "mp4",
          codec: st.codecName || st.codec || "h264",
          headers: streamHeaders,
          isHls,
          isDash
        });
      }
    }
  }

  // 2. Process resource items as additional fallback qualities
  for (const item of resourceList) {
    const link = item.resourceLink || item.url;
    if (!link || typeof link !== "string" || !link.startsWith("http")) continue;
    if (isDeprecationNoticeUrl(link) || seenUrls.has(link)) continue;
    seenUrls.add(link);

    const resNum = parseInt(item.resolution, 10) || 720;
    const label = `${resNum}p`;
    const isHls = link.includes(".m3u8");
    const isDash = link.includes(".mpd");

    if (!seenQualities.has(label)) {
      seenQualities.add(label);
      qualities.push({
        label,
        height: resNum,
        url: link,
        mediaType: isHls ? "hls" : isDash ? "dash" : "mp4",
        codec: item.codecName || "h264",
        headers: { Referer: STREAM_REFERER },
        isHls,
        isDash
      });
    }
  }

  if (qualities.length === 0) {
    throw new Error("No playable video streams found on MovieBox for this title.");
  }

  // Sort qualities highest to lowest
  qualities.sort((a, b) => (b.height || 0) - (a.height || 0));

  // Primary stream is the best quality
  const primary = qualities[0];

  return {
    sourceUrl: primary.url,
    mediaType: primary.mediaType,
    qualities,
    audioTracks,
    subtitles,
    headers: primary.headers,
    provider: { name: "MovieBox" },
    resolution: { status: "direct_stream" },
    isHls: primary.isHls,
    isDash: primary.isDash
  };
}
