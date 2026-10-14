import {
  fetchDirectHomeSections,
  directSearch,
  directGetDetails
} from "./lib/direct-catalog.js";

const HOME_ROWS = ["trending", "popular-movies", "new-releases", "top-rated", "action", "comedy", "horror", "popular-series", "action-series", "anime-airing", "anime-trending"];

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
        errorMsg = `Backend server is unreachable or offline (HTTP ${res.status}). CineStream stream resolution requires the backend server to bridge and scrape provider links. Start the backend with 'npm run dev'.`;
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
  try {
    const data = await request("/api/home", options);
    return data.rows.map((row) => ({ key: row.key, data: row }));
  } catch {
    // If backend is not running or returns an error, load directly from Stremio Cinemeta / Kitsu APIs
    try {
      const directRows = await fetchDirectHomeSections(options);
      if (directRows && directRows.length > 0) {
        return directRows;
      }
    } catch {
      // Continue to per-row fallback
    }

    const results = await Promise.allSettled(
      HOME_ROWS.map((key) =>
        request(`/api/home/${key}`, options).then((data) => {
          const row = Array.isArray(data.rows) ? data.rows[0] : data;
          return { key, data: { ...row, key } };
        })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    return ok;
  }
}

export async function fetchSearch(q, options = {}) {
  try {
    return await request(`/api/search?q=${encodeURIComponent(q)}`, options);
  } catch {
    // Direct search fallback
    const items = await directSearch(q, options);
    return {
      query: q,
      count: items.length,
      items
    };
  }
}

export async function fetchDetail(type, id, { provider, ...options } = {}) {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  try {
    return await request(`/api/detail/${type}/${encodeURIComponent(id)}${query}`, options);
  } catch {
    // Direct detail fallback
    const item = await directGetDetails(type, id, options);
    return { item };
  }
}

import { resolveClientStream } from "./lib/client-provider.js";

export function createStream(type = "movie", id = "direct", { lang, provider, season, episode, sourceUrl, mediaType, title, ...options } = {}) {
  const directResolved = resolveClientStream(
    {
      type,
      id,
      title,
      provider,
      season,
      episode,
      sourceUrl: sourceUrl || options.sourceUrl,
      streamUrl: options.streamUrl,
      mediaType,
      ...options
    },
    { mediaType }
  );

  if (directResolved) {
    return Promise.resolve(directResolved);
  }

  // Under the browser-only architecture, never call /api/stream/:type/:id.
  // Report honest limitation directly without misleading backend-offline 502 errors.
  const err = new Error(
    `No browser-accessible stream source found for "${title || id}". This title requires server-side scraping (VegaMovies / Cloudflare bypass) which is not available in browser-only mode.`
  );
  err.code = "NO_BROWSER_STREAM";
  return Promise.reject(err);
}

export function cleanupStream(sessionId) {
  return request(`/api/stream/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => null);
}
