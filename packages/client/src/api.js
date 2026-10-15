import {
  fetchDirectHomeSections,
  directSearch,
  directGetDetails
} from "./lib/direct-catalog.js";
import {
  movieboxSearch,
  movieboxGetDetails
} from "./lib/moviebox/index.js";
import { discoverClientStream } from "./lib/client-provider.js";

async function safeParseResponse(res) {
  const contentType = res.headers?.get?.("content-type") || "";
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { data: null, text: "", contentType };
  }
  if (contentType.includes("application/json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { data: JSON.parse(trimmed), text: trimmed, contentType };
    } catch {
      return { data: null, text: trimmed, contentType };
    }
  }
  return { data: null, text: trimmed, contentType };
}

export async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error(`Network error connecting to ${path}: ${err.message}`);
  }

  const { data: body, text, contentType } = await safeParseResponse(res);

  if (!res.ok) {
    let errorMsg = body?.message || body?.error;
    if (!errorMsg) {
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        errorMsg = `Backend server is unreachable or offline (HTTP ${res.status}).`;
      } else if (text && text.length <= 200 && !contentType.includes("html") && !text.startsWith("<")) {
        errorMsg = text;
      } else {
        errorMsg = `Request failed with status ${res.status}${res.statusText ? ` (${res.statusText})` : ""}`;
      }
    }
    const err = new Error(errorMsg);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  if (body === null) {
    if (res.status === 204 || !text) {
      return {};
    }
    throw new Error(`Expected JSON from ${path}, received ${res.headers.get("content-type") || "non-JSON content"}`);
  }

  return body;
}

export async function fetchHomeSections(options = {}) {
  return await fetchDirectHomeSections(options);
}

export async function fetchSearch(q, options = {}) {
  const trimmed = (q || "").trim();
  if (!trimmed) {
    return { query: q, count: 0, items: [] };
  }

  // 1. MovieBox frontend search
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
    // fallback to Cinemeta / Kitsu catalog search
  }

  // 2. Direct catalog search fallback
  const items = await directSearch(trimmed, options);
  return {
    query: trimmed,
    count: items.length,
    items
  };
}

export async function fetchDetail(type, id, { provider, ...options } = {}) {
  // If provider is MovieBox or id is a MovieBox numeric subjectId
  if (provider === "MovieBox" || (typeof id === "string" && /^\d{10,25}$/.test(id))) {
    try {
      const item = await movieboxGetDetails(id, options);
      return { item };
    } catch {
      // fallback
    }
  }

  const item = await directGetDetails(type, id, options);
  return { item };
}

export async function createStream(type = "movie", id = "direct", { lang, provider, season, episode, sourceUrl, mediaType, title, year, imdbId, signal, ...options } = {}) {
  return await discoverClientStream(
    {
      type,
      id,
      title,
      year,
      imdbId: imdbId || (typeof id === "string" && id.startsWith("tt") ? id : null),
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
