import { BaseSourceProvider } from "./provider-interface.js";
import {
  movieboxSearch,
  movieboxGetDetails,
  movieboxGetResources,
  movieboxResolveStreams,
  cleanMovieboxTitle
} from "../moviebox/index.js";
import { languageName, LANGUAGE_NAMES } from "../languages.js";

export const KNOWN_LANGUAGES = [
  { code: "hi", name: "Hindi", patterns: [/\bhindi\b/i, /\bhin\b/i, /\[hindi\]/i, /\[hin\]/i, /हिंदी/i] },
  { code: "en", name: "English", patterns: [/\benglish\b/i, /\beng\b/i, /\[english\]/i, /\[eng\]/i] },
  { code: "es", name: "Spanish", patterns: [/\bspanish\b/i, /\bespañol\b/i, /\besp\b/i, /\bspa\b/i] },
  { code: "ko", name: "Korean", patterns: [/\bkorean\b/i, /\bkor\b/i, /한국어/i] },
  { code: "ja", name: "Japanese", patterns: [/\bjapanese\b/i, /\bjap\b/i, /\bjpn\b/i, /日本語/i] },
  { code: "fr", name: "French", patterns: [/\bfrench\b/i, /\bfrançais\b/i, /\bfra\b/i, /\bfre\b/i] },
  { code: "de", name: "German", patterns: [/\bgerman\b/i, /\bdeutsch\b/i, /\bger\b/i, /\bdeu\b/i] },
  { code: "ta", name: "Tamil", patterns: [/\btamil\b/i, /\btam\b/i, /தமிழ்/i] },
  { code: "te", name: "Telugu", patterns: [/\btelugu\b/i, /\btel\b/i, /తెలుగు/i] },
  { code: "ml", name: "Malayalam", patterns: [/\bmalayalam\b/i, /\bmal\b/i, /മലയാളം/i] },
  { code: "kn", name: "Kannada", patterns: [/\bkannada\b/i, /\bkan\b/i, /ಕನ್ನಡ/i] },
  { code: "bn", name: "Bengali", patterns: [/\bbengali\b/i, /\bben\b/i, /\bbangla\b/i, /বাংলা/i] },
  { code: "mr", name: "Marathi", patterns: [/\bmarathi\b/i, /\bmar\b/i] },
  { code: "pa", name: "Punjabi", patterns: [/\bpunjabi\b/i, /\bpun\b/i] },
  { code: "ur", name: "Urdu", patterns: [/\burdu\b/i, /\burd\b/i] },
  { code: "zh", name: "Chinese", patterns: [/\bchinese\b/i, /\bmandarin\b/i, /\bcantonese\b/i, /\bchi\b/i, /\bzho\b/i, /中文/i] },
  { code: "ru", name: "Russian", patterns: [/\brussian\b/i, /\brus\b/i, /русский/i] },
  { code: "pt", name: "Portuguese", patterns: [/\bportuguese\b/i, /\bportuguês\b/i, /\bpor\b/i] },
  { code: "it", name: "Italian", patterns: [/\bitalian\b/i, /\bitaliano\b/i, /\bita\b/i] },
  { code: "ar", name: "Arabic", patterns: [/\barabic\b/i, /\bara\b/i, /العربية/i] },
  { code: "tr", name: "Turkish", patterns: [/\bturkish\b/i, /\btürkçe\b/i, /\btur\b/i] },
  { code: "th", name: "Thai", patterns: [/\bthai\b/i, /\btha\b/i] },
  { code: "vi", name: "Vietnamese", patterns: [/\bvietnamese\b/i, /\bvie\b/i] },
  { code: "id", name: "Indonesian", patterns: [/\bindonesian\b/i, /\bind\b/i] }
];

export function parseLanguageTag(text) {
  if (!text || typeof text !== "string") return null;
  const clean = text.trim();
  if (!clean) return null;

  for (const lang of KNOWN_LANGUAGES) {
    if (clean.toLowerCase() === lang.code) {
      return { code: lang.code, name: lang.name };
    }
    for (const pat of lang.patterns) {
      if (pat.test(clean)) {
        return { code: lang.code, name: lang.name };
      }
    }
  }

  const lower = clean.toLowerCase();
  if (lower.length <= 4 && LANGUAGE_NAMES[lower]) {
    const name = LANGUAGE_NAMES[lower];
    const code = lower.length === 2 ? lower : (KNOWN_LANGUAGES.find((k) => k.name.toLowerCase() === name.toLowerCase())?.code || lower.slice(0, 2));
    return { code, name };
  }

  return null;
}

const audioLangCache = new Map();

export async function discoverAvailableAudioLanguages(query = {}, options = {}) {
  const item = query.item || query;
  const detail = query.detail || query;
  const tmdbId = detail?.tmdbId || item?.tmdbId || (typeof item?.id === "number" || /^\d{1,9}$/.test(String(item?.id)) ? Number(item?.id) : null);
  const imdbId = detail?.imdbId || item?.imdbId || item?.imdb_id;
  const origLang = (detail?.original_language || item?.original_language || "en").toLowerCase().trim();
  const title = detail?.title || item?.title || "";
  const year = detail?.year || item?.year;

  const cacheKey = `${tmdbId || imdbId || title}_${origLang}`;
  if (audioLangCache.has(cacheKey)) {
    return audioLangCache.get(cacheKey);
  }

  const origName = languageName(origLang) || origLang.toUpperCase();
  const languagesMap = new Map();

  // 1. Always include original language first
  languagesMap.set(origLang, {
    code: origLang,
    name: `${origName} (Original)`,
    isOriginal: true
  });

  // 2. Query MovieBox to discover real dubs and language-tagged streams
  try {
    let subjectId = null;
    if (item?.id && /^\d{10,25}$/.test(String(item.id))) {
      subjectId = String(item.id);
    } else {
      const searchTerms = [];
      if (imdbId) searchTerms.push(imdbId);
      if (title) searchTerms.push(cleanMovieboxTitle(title));

      for (const term of searchTerms) {
        if (!term) continue;
        try {
          const results = await movieboxSearch(term, 1, options);
          if (results.length > 0) {
            let best = results[0];
            if (year) {
              const matchYear = results.find((r) => r.year === String(year));
              if (matchYear) best = matchYear;
            }
            subjectId = best.id;
            break;
          }
        } catch {
          // continue search
        }
      }
    }

    if (subjectId) {
      let details = null;
      try {
        details = await movieboxGetDetails(subjectId, options);
      } catch {
        // details optional
      }

      // Check MovieBox dubs
      if (Array.isArray(details?.dubs)) {
        for (const dub of details.dubs) {
          const raw = dub.lanName || dub.language || dub.label || dub.title;
          const detected = parseLanguageTag(raw);
          if (detected) {
            const isOrig = detected.code === origLang;
            if (!languagesMap.has(detected.code)) {
              languagesMap.set(detected.code, {
                code: detected.code,
                name: `${detected.name} (${isOrig ? "Original" : "Dubbed"})`,
                subjectId: dub.subjectId,
                isOriginal: isOrig
              });
            } else {
              const existing = languagesMap.get(detected.code);
              if (dub.subjectId) existing.subjectId = dub.subjectId;
            }
          }
        }
      }

      // Check resources for audio language tags
      try {
        const resources = await movieboxGetResources(subjectId, 0, 0, 1, options);
        const list = resources?.list || resources?.data?.list || [];
        for (const res of list) {
          const text = `${res.title || ""} ${res.name || ""} ${res.lanName || ""} ${res.language || ""}`;
          const detected = parseLanguageTag(text);
          if (detected && !languagesMap.has(detected.code)) {
            const isOrig = detected.code === origLang;
            languagesMap.set(detected.code, {
              code: detected.code,
              name: `${detected.name} (${isOrig ? "Original" : "Dubbed"})`,
              streamUrl: res.resourceLink || res.url,
              isOriginal: isOrig
            });
          }
        }
      } catch {
        // resources optional
      }
    }
  } catch {
    // Graceful fallback to original language
  }

  const result = Array.from(languagesMap.values());
  audioLangCache.set(cacheKey, result);
  return result;
}

export function buildWebEmbedUrl({
  tmdbId,
  type = "movie",
  season = 1,
  episode = 1,
  selectedLanguage,
  lang,
  server = "vidsrc"
}) {
  if (!tmdbId) return null;
  const isSeries = type === "series" || type === "tv";
  const s = season || 1;
  const ep = episode || 1;
  const language = (selectedLanguage || lang || "").toLowerCase().trim();
  const langParam = language && language !== "en" && language !== "original" ? `?lang=${encodeURIComponent(language)}` : "";

  if (server === "multiembed") {
    const multiLangParam = language && language !== "en" && language !== "original" ? `&lang=${encodeURIComponent(language)}` : "";
    if (isSeries) {
      return `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${s}&e=${ep}${multiLangParam}`;
    }
    return `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1${multiLangParam}`;
  }

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
        let matchedResourceUrl = null;

        if (targetLang) {
          if (details?.dubs && details.dubs.length > 0) {
            const matchDub = details.dubs.find((d) => {
              const raw = d.lanName || d.language || d.label || d.title;
              const detected = parseLanguageTag(raw);
              return (
                detected?.code === targetLang ||
                d.language?.toLowerCase().startsWith(targetLang) ||
                d.label?.toLowerCase().includes(targetLang)
              );
            });
            if (matchDub?.subjectId) {
              targetSubjectId = matchDub.subjectId;
              diagnostics.push(`Switching to MovieBox dubbed subjectId ${targetSubjectId} for audio language "${targetLang}"`);
            }
          }

          // Also check resources for language-tagged stream
          try {
            const resData = await movieboxGetResources(targetSubjectId, seasonNum, episodeNum, 1, options);
            const rList = resData?.list || resData?.data?.list || [];
            for (const r of rList) {
              const rText = `${r.title || ""} ${r.name || ""} ${r.lanName || ""} ${r.language || ""}`;
              const rDetected = parseLanguageTag(rText);
              if (rDetected?.code === targetLang && (r.resourceLink || r.url)) {
                matchedResourceUrl = r.resourceLink || r.url;
                diagnostics.push(`Found language-tagged resource stream for "${targetLang}": ${matchedResourceUrl}`);
                break;
              }
            }
          } catch {
            // ignore
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
          const primaryUrl = matchedResourceUrl || resolved.sourceUrl;
          return {
            sources: [
              {
                url: primaryUrl,
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
                isEmbed: false,
                selectedLanguage: targetLang || "original"
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
              corsEnabled: true,
              selectedLanguage: targetLang || "original"
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

