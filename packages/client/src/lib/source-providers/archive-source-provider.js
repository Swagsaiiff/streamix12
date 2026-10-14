import { BaseSourceProvider } from "./provider-interface.js";

function cleanSearchQuery(str = "") {
  return String(str)
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getSignificantWords(str = "") {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "movie", "full", "online", "ver", "pelicula"].includes(w));
}

function titlesMatch(target = "", candidate = "") {
  const normTarget = normalize(target);
  const normCandidate = normalize(candidate);
  if (!normTarget || !normCandidate) return false;
  if (normCandidate === normTarget) return true;

  const targetWords = getSignificantWords(target);
  if (targetWords.length === 0) return false;

  const candidateWords = new Set(getSignificantWords(candidate));
  return targetWords.every((w) => candidateWords.has(w));
}

export class ArchiveOrgSourceProvider extends BaseSourceProvider {
  constructor(options = {}) {
    super("archive", "Internet Archive (Public Domain)", options);
    this.searchEndpoint = options.searchEndpoint || "https://archive.org/advancedsearch.php";
    this.metadataEndpoint = options.metadataEndpoint || "https://archive.org/metadata";
  }

  async resolveStreams(query = {}, options = {}) {
    const { title, year, type } = query;

    // Internet Archive movie search applies primarily to movies, not series episodes
    if (!title || type === "series") {
      return {
        sources: [],
        diagnostics: ["Internet Archive provider skipped: requires movie title"]
      };
    }

    const cleanTitle = cleanSearchQuery(title);
    if (!cleanTitle) {
      return {
        sources: [],
        diagnostics: ["Title query was empty after cleaning"]
      };
    }

    const queryParts = [`mediatype:movies`, `title:(${encodeURIComponent(cleanTitle)})`];
    if (year && Number.isFinite(Number(year))) {
      queryParts.push(`year:${year}`);
    }

    const searchUrl = `${this.searchEndpoint}?q=${queryParts.join(" AND ")}&fl[]=identifier,title,year,downloads,mediatype&sort[]=downloads+desc&rows=5&output=json`;

    try {
      const searchRes = await fetch(searchUrl, {
        signal: options.signal,
        headers: { Accept: "application/json" }
      });

      if (!searchRes.ok) {
        return {
          sources: [],
          diagnostics: [`Internet Archive search returned HTTP ${searchRes.status}`]
        };
      }

      const searchData = await searchRes.json();
      const docs = searchData?.response?.docs ?? [];

      if (docs.length === 0) {
        return {
          sources: [],
          diagnostics: [`No documents found on Internet Archive for "${title}" (${year || "any year"})`]
        };
      }

      // Filter and score matching docs
      const candidates = docs.filter((doc) => {
        if (!doc.identifier) return false;
        // Verify title match to prevent irrelevant false positives
        if (!titlesMatch(title, doc.title)) return false;
        // If year is specified, ensure it is within ±1 year
        if (year && doc.year && Math.abs(Number(doc.year) - Number(year)) > 1) {
          return false;
        }
        return true;
      });

      if (candidates.length === 0) {
        return {
          sources: [],
          diagnostics: [`Found ${docs.length} Archive item(s), but none strictly matched title and year`]
        };
      }

      // Inspect metadata for the highest download candidate
      const topMatch = candidates[0];
      const metaUrl = `${this.metadataEndpoint}/${encodeURIComponent(topMatch.identifier)}`;
      const metaRes = await fetch(metaUrl, {
        signal: options.signal,
        headers: { Accept: "application/json" }
      });

      if (!metaRes.ok) {
        return {
          sources: [],
          diagnostics: [`Could not fetch metadata for Archive item ${topMatch.identifier}`]
        };
      }

      const metaData = await metaRes.json();
      const files = metaData?.files ?? [];

      // Look for genuine video files (.mp4 or .webm)
      const videoFiles = files.filter((f) => {
        const name = (f.name || "").toLowerCase();
        return (
          (name.endsWith(".mp4") || name.endsWith(".webm")) &&
          !name.includes("thumb") &&
          !name.includes("_ia.mp4") &&
          Number(f.size || 0) > 10 * 1024 * 1024 // Must be larger than 10MB to avoid preview fragments
        );
      });

      if (videoFiles.length === 0) {
        return {
          sources: [],
          diagnostics: [`Archive item ${topMatch.identifier} contains no playable video files (>10MB)`]
        };
      }

      // Sort by preference: prefer 720p/1080p MP4 or standard MP4 under 2GB
      videoFiles.sort((a, b) => {
        const aName = (a.name || "").toLowerCase();
        const bName = (b.name || "").toLowerCase();
        const aIs720 = aName.includes("720p");
        const bIs720 = bName.includes("720p");
        if (aIs720 && !bIs720) return -1;
        if (!aIs720 && bIs720) return 1;
        return Number(b.size || 0) - Number(a.size || 0);
      });

      const chosenFile = videoFiles[0];
      const format = chosenFile.name.toLowerCase().endsWith(".webm") ? "webm" : "mp4";
      const downloadUrl = `https://archive.org/download/${encodeURIComponent(topMatch.identifier)}/${encodeURIComponent(chosenFile.name)}`;

      return {
        sources: [
          {
            url: downloadUrl,
            format,
            title: `${topMatch.title} (${topMatch.year || year || "Public Domain"})`,
            size: Number(chosenFile.size || 0),
            quality: chosenFile.name.includes("720p") ? "720p" : chosenFile.name.includes("1080p") ? "1080p" : "SD",
            isPlayableInBrowser: true,
            provider: this.name,
            archiveId: topMatch.identifier,
            note: "Internet Archive public domain stream"
          }
        ],
        diagnostics: [`Resolved Archive item ${topMatch.identifier}: ${chosenFile.name}`]
      };
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return {
        sources: [],
        diagnostics: [`Archive.org resolution failed: ${err.message}`]
      };
    }
  }
}
