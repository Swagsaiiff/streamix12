import { BaseProvider, ProviderError } from "./base.js";
import { logger } from "../logger.js";

const URLS_JSON = "https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json";
const FALLBACK_BASE = "https://vegamovies.gallery";
const CINEMETA = "https://v3-cinemeta.strem.io";
const HOST_PATTERN = /(nexdrive\.|vcloud\.|hubcloud\.|fastdl\.|filebee\.|vegadrive\.|pixeldrain\.|gofile\.|gdflix\.|hubdrive\.|driveseed\.|driveleech\.|drivebot\.)/i;
const NOISE_LINK_PATTERN = /(xmlrpc\.php|wp-json|wp-content|wp-includes|wp-admin|\/feed\/?|comments\/feed|\/comments\/?|\/tag\/|\/category\/|\/page\/\d|\/author\/|\.(css|js|png|jpe?g|svg|ico|webp|gif)(\?|$)|\/wp-login)/i;
const MEDIA_URL_PATTERN = /https?:\/\/[^\s"'<>\\]+?\.(?:mkv|mp4|m3u8|webm)(?:\?[^\s"'<>\\]*)?/gi;
const SERIES_HINT = /web-?series|season\s*\d|series/i;
const PLACEHOLDER_PATTERN = /(unpkg\.com|site\.webm|placeholder|sample\.(?:mp4|webm|mkv))/i;

export function isPlaceholderMedia(url) {
  return PLACEHOLDER_PATTERN.test(url);
}

export function candidateRank(url) {
  if (/\.(mkv|mp4)(\?|$)/i.test(url)) return 0;
  if (/\.m3u8(\?|$)/i.test(url)) return 1;
  if (/\.webm(\?|$)/i.test(url)) return 2;
  return 3;
}

export function selectMediaCandidates(urls) {
  return Array.from(new Set(urls))
    .filter((url) => !isPlaceholderMedia(url))
    .sort((a, b) => candidateRank(a) - candidateRank(b));
}

export function cleanVegaTitle(raw) {
  if (!raw) return { title: "", year: null };
  let value = String(raw).replace(/^download\s+/i, "").trim();
  const yearMatch = value.match(/\((\d{4})\)/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  if (yearMatch) {
    value = value.slice(0, yearMatch.index).trim();
  } else {
    value = value.replace(/\b(?:web-?dl|bluray|blu-ray|hdrip|dvdrip|webrip|dual audio|hindi|english|org|x264|x265|hevc|10bit|480p|720p|1080p|2160p|4k|esubs?|subtitles?)\b.*/i, "").trim();
  }
  value = value.replace(/[\[{].*$/s, "").replace(/[\s|,-]+$/, "").trim();
  return { title: value || String(raw).trim(), year };
}

export function decodeDoubleAtob(value) {
  try {
    const once = Buffer.from(value, "base64").toString("utf8");
    return Buffer.from(once, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function extractDoubleAtobValue(html) {
  const match = html.match(/atob\s*\(\s*atob\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/i);
  return match ? decodeDoubleAtob(match[1]) : null;
}

export function extractImdbId(html) {
  const match = html.match(/imdb\.com\/title\/(tt\d+)/i);
  return match ? match[1] : null;
}

export function extractHostLinks(html) {
  const links = new Set();
  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    const href = match[1];
    if (!HOST_PATTERN.test(href)) continue;
    if (NOISE_LINK_PATTERN.test(href)) continue;
    links.add(href);
  }
  return Array.from(links);
}

export function extractLinkPages(html, baseUrl) {
  const ordered = new Map();
  for (const match of html.matchAll(/<a\s+([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (match[1].match(/href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    const label = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const absolute = href.startsWith("http") ? href : new URL(href, baseUrl).href;
    if (NOISE_LINK_PATTERN.test(absolute)) continue;
    const isDownloadButton = /dwd-button/i.test(match[2]);
    const isHostLink = HOST_PATTERN.test(absolute);
    if (!isDownloadButton && !isHostLink) continue;
    if (!ordered.has(absolute)) {
      ordered.set(absolute, { url: absolute, label: label.slice(0, 60), kind: isDownloadButton ? "download" : "host" });
    }
  }
  return Array.from(ordered.values());
}

export function extractDownloadPageLinks(html, baseUrl) {
  const links = new Set();
  for (const match of html.matchAll(/<a\s+([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/dwd-button/i.test(match[2])) continue;
    const href = (match[1].match(/href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    links.add(href.startsWith("http") ? href : new URL(href, baseUrl).href);
  }
  return Array.from(links);
}

export function extractDirectMediaUrls(html) {
  const urls = new Set();
  for (const match of html.matchAll(MEDIA_URL_PATTERN)) {
    urls.add(match[0]);
  }
  return Array.from(urls);
}

export function extractPixelDrainUrl(html) {
  const match = html.match(/var\s+pxl\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}

export function extractServerButtons(html) {
  const buttons = [];
  for (const match of html.matchAll(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    buttons.push({ href: match[1], label: match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
  }
  return buttons;
}

export function parseVegaSearch(json) {
  const hits = json?.hits ?? [];
  return hits
    .map((hit) => {
      const doc = hit?.document ?? {};
      const permalink = doc.permalink ?? null;
      if (!permalink) return null;
      const { title, year } = cleanVegaTitle(doc.post_title);
      const type = SERIES_HINT.test(`${doc.post_title ?? ""} ${permalink}`) ? "series" : "movie";
      return {
        id: permalink,
        title,
        type,
        poster: doc.post_thumbnail ?? null,
        backdrop: null,
        overview: null,
        year,
        releaseInfo: null,
        genres: null,
        rating: null,
        popularity: null,
        source: "VegaMovies",
        provider: "VegaMovies",
        sourceUrl: permalink
      };
    })
    .filter(Boolean);
}

export function normalizeForMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function scoreTitleMatch(query, candidateTitle, candidateYear, wantedYear) {
  const q = normalizeForMatch(query);
  const t = normalizeForMatch(candidateTitle);
  if (!q || !t) return 0;

  let score;
  if (t === q) score = 1000;
  else if (t.startsWith(`${q} `)) score = 700 - Math.min(100, t.length - q.length);
  else if (t.startsWith(q)) score = 650;
  else if (new RegExp(`(?:^| )${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`).test(t)) score = 500;
  else if (q.split(" ").every((token) => t.split(" ").includes(token))) score = 400;
  else if (t.includes(q)) score = 300;
  else {
    const qTokens = q.split(" ").filter(Boolean);
    const tTokens = new Set(t.split(" ").filter(Boolean));
    const overlap = qTokens.filter((token) => tTokens.has(token)).length;
    score = qTokens.length > 0 ? Math.round((overlap / qTokens.length) * 200) : 0;
  }

  if (wantedYear && candidateYear) {
    const diff = Math.abs(Number(candidateYear) - Number(wantedYear));
    if (diff === 0) score += 120;
    else if (diff === 1) score += 60;
    else if (diff > 3) score -= 80;
  }
  return score;
}

export function pickBestMatch(items, { title, year, minScore = 400 } = {}) {
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const score = scoreTitleMatch(title, item.title, item.year, year);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= minScore ? { item: best, score: bestScore } : null;
}

export function rankTitleCandidates(items, { title, year = null, type = null, minScore = 400, limit = 5 } = {}) {
  const scored = [];
  for (const item of items) {
    let score = scoreTitleMatch(title, item.title, item.year, year);
    if (score <= 0) continue;
    if (type && item.type) {
      score += item.type === type ? 90 : -120;
    }
    if (score >= minScore) scored.push({ item, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (Number(b.item.year) || 0) - (Number(a.item.year) || 0);
  });

  const seen = new Set();
  const unique = [];
  for (const entry of scored) {
    const key = entry.item.id ?? `${entry.item.title}:${entry.item.year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
    if (unique.length >= limit) break;
  }
  return unique;
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function absoluteUrl(base, value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return new URL(value, base).href;
}

export class VegaMoviesProvider extends BaseProvider {
  constructor(options = {}) {
    super({ name: "VegaMovies", timeoutMs: 15000, ...options });
    this.cache = options.cache ?? null;
    this.ffprobePath = options.ffprobePath ?? "ffprobe";
  }

  getName() {
    return "VegaMovies";
  }

  getCapabilities() {
    return {
      supportsHomePage: false,
      supportsSearch: true,
      supportsDetail: true,
      supportsStreamResolution: true,
      rankingMethod: "VegaMovies search.php JSON index (provider-side relevance ordering)",
      homeCatalogTypes: []
    };
  }

  async getBaseUrl() {
    const cacheKey = "vega:base";
    const cached = this.cache?.get(cacheKey);
    if (cached) return cached;
    let base = FALLBACK_BASE;
    try {
      const data = await this.fetchJson(URLS_JSON, { timeoutMs: 8000 });
      if (data && typeof data.vegamovies === "string" && data.vegamovies.startsWith("http")) {
        base = data.vegamovies;
      }
    } catch {
      // provider url list unavailable; keep the known fallback base
    }
    this.cache?.set(cacheKey, base, 3600000);
    return base;
  }

  async search(query) {
    const base = await this.getBaseUrl();
    const url = `${base}/search.php?q=${encodeURIComponent(query)}&page=1`;
    const json = await this.fetchJson(url, { timeoutMs: 12000 });
    return parseVegaSearch(json);
  }

  async getDetails(type, id) {
    if (/^tt\d+$/i.test(id) || /kitsu/i.test(id) || /^mal[:\-]/i.test(id)) {
      throw new ProviderError("id does not belong to VegaMovies", "unsupported");
    }
    const base = await this.getBaseUrl();
    const pageUrl = absoluteUrl(base, id);
    if (!pageUrl) throw new ProviderError("invalid VegaMovies id", "validation");
    const html = await this.fetchText(pageUrl, {
      headers: { Referer: `${base}/` }
    });

    const titleTag = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] ?? "";
    let title = titleTag.replace(/^download\s+/i, "").replace(/\s*\|\s*vegamovies[^|]*$/i, "").trim();
    let poster = (html.match(/<p[^>]*>\s*<img[^>]+src="([^"]+)"/i) || [])[1]
      ?? (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1]
      ?? null;
    const overview = (html.match(/<h3[^>]*>[\s\S]*?synopsis[\s\S]*?<\/h3>\s*(?:<p>)?([\s\S]*?)<\/(?:p|div)>/i) || [])[1]?.replace(/<[^>]+>/g, " ").trim() ?? null;
    const imdbId = extractImdbId(html);
    const isSeries =
      /series-?synopsis|series info/i.test(html) || SERIES_HINT.test(`${titleTag} ${pageUrl}`);

    const { title: cleanedTitle, year } = cleanVegaTitle(title);
    let item = {
      id,
      title: cleanedTitle || title,
      type: isSeries ? "series" : "movie",
      poster,
      backdrop: null,
      overview,
      year,
      releaseInfo: null,
      genres: null,
      rating: null,
      popularity: null,
      source: "VegaMovies",
      provider: "VegaMovies",
      sourceUrl: pageUrl,
      episodes: isSeries ? [] : null
    };

    if (imdbId) {
      try {
        const meta = await this.fetchJson(`${CINEMETA}/meta/${isSeries ? "series" : "movie"}/${imdbId}.json`);
        const m = meta?.meta;
        if (m) {
          item = {
            ...item,
            title: m.name ?? item.title,
            poster: m.poster ?? item.poster,
            backdrop: m.background ?? item.backdrop,
            overview: m.description ?? item.overview,
            year: Number(String(m.year ?? "").match(/\d{4}/)?.[0]) || item.year,
            genres: m.genre ?? m.genres ?? item.genres,
            rating: Number.parseFloat(m.imdbRating) || item.rating,
            episodes: isSeries
              ? (m.videos ?? [])
                  .filter((ep) => ep.season != null && ep.season !== 0)
                  .map((ep) => ({
                    id: ep.id ?? null,
                    season: ep.season ?? null,
                    episode: ep.episode ?? ep.number ?? null,
                    name: ep.name ?? ep.title ?? null,
                    overview: ep.overview ?? ep.description ?? null,
                    thumbnail: ep.thumbnail ?? null,
                    firstAired: ep.firstAired ?? ep.released ?? null,
                    rating: Number.parseFloat(ep.rating) || null
                  }))
                  .sort((a, b) => a.season - b.season || a.episode - b.episode)
              : null
          };
        }
      } catch {
        // cinemeta enrichment is best-effort; keep provider-page metadata
      }
    }

    return item;
  }

  async resolveByTitle({ title, year = null, type = "movie" } = {}) {
    if (!title) {
      throw new ProviderError("title is required for title-based resolution", "validation");
    }
    const items = await this.search(title);
    logger.info("vega.title_search", { query: title, year, type, results: items.length });

    const ranked = rankTitleCandidates(items, { title, year, type });
    if (ranked.length === 0) {
      logger.warn("vega.title_no_match", {
        query: title,
        year,
        type,
        sample: items.slice(0, 5).map((item) => `${item.title} (${item.year ?? "?"})`)
      });
      throw new ProviderError(
        `VegaMovies has no close match for "${title}"${year ? ` (${year})` : ""} among ${items.length} result(s)`,
        "not_found"
      );
    }

    logger.info("vega.title_candidates", {
      query: title,
      candidates: ranked.map(({ item, score }) => `${item.title} (${item.year ?? "?"}) [${item.type}] score=${score}`)
    });

    const attempts = [];
    for (const [index, { item, score }] of ranked.entries()) {
      try {
        const detail = await this.getDetails(item.type, item.id);
        const source = await this.resolveStream(detail);
        logger.info("vega.resolved", {
          query: title,
          matched: item.title,
          matchedYear: item.year ?? null,
          score,
          attempt: index + 1,
          candidatesTried: attempts.length + 1,
          mediaType: source.mediaType ?? null,
          host: hostOf(source.url)
        });
        return {
          ...source,
          note: `Resolved via VegaMovies title match: "${item.title}"${item.year ? ` (${item.year})` : ""}, score ${score} (candidate ${index + 1} of ${ranked.length})`,
          matchedTitle: item.title,
          matchedYear: item.year ?? null,
          matchScore: score,
          pageUrl: detail.sourceUrl,
          attempts: attempts.concat([{ title: item.title, id: item.id, score, ok: true }])
        };
      } catch (err) {
        attempts.push({ title: item.title, id: item.id, score, ok: false, error: err.message });
        logger.warn("vega.candidate_failed", {
          query: title,
          candidate: item.title,
          candidateYear: item.year ?? null,
          score,
          attempt: index + 1,
          code: err.code ?? "error",
          reason: String(err.message ?? "").slice(0, 200)
        });
      }
    }

    throw new ProviderError(
      `VegaMovies matched ${ranked.length} candidate(s) for "${title}"${year ? ` (${year})` : ""} but none yielded a validated playable source: ${attempts
        .map((a) => `${a.title}${a.error ? ` (${String(a.error).slice(0, 60)})` : ""}`)
        .join("; ")}`,
      "unsupported"
    );
  }

  async resolveStream(detail) {
    const base = await this.getBaseUrl();
    const pageUrl = detail?.sourceUrl && /^https?:\/\//i.test(detail.sourceUrl)
      ? detail.sourceUrl
      : absoluteUrl(base, detail?.id);
    if (!pageUrl) throw new ProviderError("VegaMovies detail page unavailable for resolution", "unsupported");

    const html = await this.fetchText(pageUrl, { headers: { Referer: `${base}/` } });
    const candidates = new Set();
    let chosenLabel = null;

    for (const mediaUrl of extractDirectMediaUrls(html)) candidates.add(mediaUrl);

    // Movies expose `dwd-button` anchors; series pages link straight to host pages
    // (e.g. nexdrive) from quality sections. Handle both.
    const linkPages = extractLinkPages(html, pageUrl).slice(0, 4);
    logger.info("vega.link_pages", {
      page: hostOf(pageUrl),
      count: linkPages.length,
      kinds: [...new Set(linkPages.map((p) => p.kind))],
      labels: linkPages.map((p) => p.label).slice(0, 6)
    });

    for (const linkPage of linkPages) {
      if (selectMediaCandidates(candidates).length >= 3) break;
      let linkHtml;
      try {
        linkHtml = await this.fetchText(linkPage.url, {
          headers: { Referer: pageUrl },
          timeoutMs: 12000
        });
      } catch {
        logger.warn("vega.link_page_failed", { host: hostOf(linkPage.url) });
        continue;
      }
      for (const mediaUrl of extractDirectMediaUrls(linkHtml)) candidates.add(mediaUrl);

      for (const hostLink of extractHostLinks(linkHtml).slice(0, 6)) {
        if (selectMediaCandidates(candidates).length >= 3) break;
        try {
          const hostHtml = await this.fetchText(hostLink, {
            headers: { Referer: linkPage.url },
            timeoutMs: 12000
          });
          for (const mediaUrl of extractDirectMediaUrls(hostHtml)) candidates.add(mediaUrl);

          const vcloudToken = extractDoubleAtobValue(hostHtml);
          if (vcloudToken && /^https?:\/\//i.test(vcloudToken)) {
            const tokenHtml = await this.fetchText(vcloudToken, {
              headers: { Referer: hostLink },
              timeoutMs: 12000
            });
            for (const mediaUrl of extractDirectMediaUrls(tokenHtml)) candidates.add(mediaUrl);
            const pxl = extractPixelDrainUrl(tokenHtml);
            if (pxl) {
              const pxId = pxl.split("/").filter(Boolean).pop();
              if (pxId) candidates.add(`https://pixeldrain.com/api/file/${pxId}?download`);
            }
          }
        } catch {
          // individual host failures must not abort resolution
        }
      }
      if (selectMediaCandidates(candidates).length > 0 && !chosenLabel) {
        chosenLabel = linkPage.label;
      }
    }

    const ranked = selectMediaCandidates(candidates);
    logger.info("vega.extraction_candidates", {
      page: hostOf(pageUrl),
      total: ranked.length,
      hosts: [...new Set(ranked.map((url) => hostOf(url)).filter(Boolean))]
    });

    for (const candidate of ranked) {
      const playable = await this.isPlayableMedia(candidate, pageUrl);
      logger.info("vega.ffprobe_check", { host: hostOf(candidate), playable });
      if (playable) {
        logger.info("vega.media_validated", { host: hostOf(candidate), mediaType: candidate.includes(".m3u8") ? "hls" : "mkv" });
        return {
          url: candidate,
          headers: { Referer: `${base}/` },
          mediaType: candidate.includes(".m3u8") ? "hls" : "mkv",
          sourceType: "provider",
          note: chosenLabel
            ? `Resolved from VegaMovies (real provider source; page section: "${chosenLabel}")`
            : "Resolved from VegaMovies (real provider source)"
        };
      }
    }

    logger.warn("vega.extraction_failed", {
      page: hostOf(pageUrl),
      candidates: ranked.length,
      sampleHosts: [...new Set(ranked.map((url) => hostOf(url)).filter(Boolean))].slice(0, 5)
    });
    throw new ProviderError(
      `VegaMovies detail page was fetched but none of ${ranked.length} candidate media URL(s) passed ffprobe validation`,
      "unsupported"
    );
  }

  async isPlayableMedia(url, referer) {
    if (isPlaceholderMedia(url)) return false;
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      let settled = false;
      let output = "";
      const proc = spawn(
        this.ffprobePath,
        [
          "-v", "error",
          "-headers", `Referer: ${referer}\r\n`,
          "-show_entries", "stream=codec_type",
          "-of", "json",
          url
        ],
        { windowsHide: true }
      );
      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            // already gone
          }
          resolve(false);
        }
      }, 20000);
      proc.on("error", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(code === 0 && /"codec_type"\s*:\s*"video"/.test(output));
        }
      });
    });
  }
}
