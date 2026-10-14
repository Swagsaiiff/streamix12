// Client-side media source inspection and format detection.
// Inspects URLs, response status, Content-Type, initial bytes, and container signatures
// to accurately route media to native <video>, hls.js, dash.js, or client MKV processing,
// preventing format errors and false assumptions.

export function detectFormatFromUrl(url) {
  if (!url || typeof url !== "string") return "unknown";

  const clean = url.split("?")[0].toLowerCase();
  const lowerUrl = url.toLowerCase();

  // Query parameter filename checks (e.g. response-content-disposition=...filename.mkv)
  if (lowerUrl.includes(".m3u8")) return "hls";
  if (lowerUrl.includes(".mpd")) return "dash";

  if (clean.endsWith(".json")) return "json";
  if (clean.endsWith(".html") || clean.endsWith(".htm") || clean.endsWith(".php") || clean.endsWith(".asp") || clean.endsWith(".aspx")) return "html";

  if (clean.endsWith(".m3u8")) return "hls";
  if (clean.endsWith(".mpd")) return "dash";
  if (clean.endsWith(".mp4") || clean.endsWith(".m4v") || clean.endsWith(".mov")) return "mp4";
  if (clean.endsWith(".webm")) return "webm";
  if (clean.endsWith(".mkv") || lowerUrl.includes(".mkv")) return "mkv";

  return "unknown";
}

export function detectFormatFromBytes(bytes) {
  if (!bytes || bytes.length === 0) return "unknown";

  // Check EBML header: 0x1A 0x45 0xDF 0xA3
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const textSlice = String.fromCharCode(...bytes.slice(0, Math.min(bytes.length, 128)));
    if (textSlice.includes("webm")) return "webm";
    if (textSlice.includes("matroska")) return "mkv";
    return "mkv";
  }

  // Check MP4: bytes 4..8 === "ftyp" (0x66 0x74 0x79 0x70)
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "mp4";
  }

  // Check text signatures
  const headStr = String.fromCharCode(...bytes.slice(0, Math.min(bytes.length, 256))).trim();
  if (headStr.startsWith("#EXTM3U")) return "hls";
  if (headStr.includes("<MPD") || headStr.includes("urn:mpeg:dash")) return "dash";
  if (headStr.startsWith("<!DOCTYPE") || headStr.toLowerCase().startsWith("<html")) return "html";
  if (headStr.startsWith("{") || headStr.startsWith("[")) return "json";

  return "unknown";
}

export function detectFormatFromContentType(contentType = "") {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html")) return "html";
  if (ct.includes("application/json")) return "json";
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl") || ct.includes("audio/mpegurl")) return "hls";
  if (ct.includes("application/dash+xml")) return "dash";
  if (ct.includes("video/mp4") || ct.includes("audio/mp4")) return "mp4";
  if (ct.includes("video/webm") || ct.includes("audio/webm")) return "webm";
  if (ct.includes("video/x-matroska") || ct.includes("video/mkv") || ct.includes("matroska")) return "mkv";
  return "unknown";
}

export async function probeMediaSource(url, { signal, headers = {}, declaredType } = {}) {
  if (!url || typeof url !== "string") {
    return {
      format: "unknown",
      isPlayable: false,
      error: "No source URL provided"
    };
  }

  const urlFormat = detectFormatFromUrl(url);

  // If the URL is explicitly an API JSON endpoint or HTML page, reject immediately
  if (urlFormat === "json") {
    return {
      format: "json",
      isPlayable: false,
      error: "Stream URL points to a JSON metadata endpoint, not a video stream"
    };
  }
  if (urlFormat === "html") {
    return {
      format: "html",
      isPlayable: false,
      error: "Stream URL points to a web page, not a video stream"
    };
  }

  let res = null;
  let probeBytes = null;
  let status = null;
  let contentType = "";
  let corsBlocked = false;
  let redirectedFormat = "unknown";
  let dispositionFormat = "unknown";

  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-511",
        ...headers
      },
      signal
    });
    status = res.status;
    contentType = res.headers.get("content-type") || "";
    const contentDisposition = res.headers.get("content-disposition") || "";

    if (res.url && res.url !== url) {
      redirectedFormat = detectFormatFromUrl(res.url);
    }

    if (contentDisposition) {
      const match = contentDisposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']+)['"]?/i);
      if (match && match[1]) {
        dispositionFormat = detectFormatFromUrl(match[1]);
      }
    }

    if (status === 401 || status === 403) {
      return {
        format: "blocked",
        status,
        isPlayable: false,
        error: `Stream URL is blocked or expired (HTTP ${status})`
      };
    }

    if (status === 404) {
      return {
        format: "not_found",
        status: 404,
        isPlayable: false,
        error: "Stream media not found (HTTP 404)"
      };
    }

    if (status === 410) {
      return {
        format: "expired",
        status: 410,
        isPlayable: false,
        error: "Stream media link has expired (HTTP 410)"
      };
    }

    if (!res.ok && status !== 206) {
      return {
        format: "error",
        status,
        isPlayable: false,
        error: `Stream server returned HTTP ${status}`
      };
    }

    const ctFormat = detectFormatFromContentType(contentType);
    if (ctFormat === "html") {
      return {
        format: "html",
        status,
        isPlayable: false,
        error: "Stream URL returned an HTML web page instead of media"
      };
    }
    if (ctFormat === "json") {
      return {
        format: "json",
        status,
        isPlayable: false,
        error: "Stream URL returned a JSON response instead of media"
      };
    }

    const buffer = await res.arrayBuffer();
    probeBytes = new Uint8Array(buffer);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    // Cross-origin request blocked by CORS or network failure
    corsBlocked = true;
  }

  let finalFormat = "unknown";

  // 1. Byte sniffing (most reliable: magic numbers)
  if (probeBytes && probeBytes.length > 0) {
    finalFormat = detectFormatFromBytes(probeBytes);
  }

  // 2. Content-Type header
  if (finalFormat === "unknown") {
    const fromCt = detectFormatFromContentType(contentType);
    if (fromCt !== "unknown") finalFormat = fromCt;
  }

  // 3. Content-Disposition filename
  if (finalFormat === "unknown" && dispositionFormat !== "unknown") {
    finalFormat = dispositionFormat;
  }

  // 4. Redirected URL
  if (finalFormat === "unknown" && redirectedFormat !== "unknown") {
    finalFormat = redirectedFormat;
  }

  // 5. Original URL filename/extension
  if (finalFormat === "unknown" && urlFormat !== "unknown") {
    finalFormat = urlFormat;
  }

  // 6. Explicitly declared type
  if (finalFormat === "unknown" && declaredType && declaredType !== "unknown") {
    finalFormat = declaredType;
  }

  if (finalFormat === "html") {
    return {
      format: "html",
      status,
      isPlayable: false,
      error: "Stream URL returned an HTML page instead of playable video"
    };
  }

  if (finalFormat === "json") {
    return {
      format: "json",
      status,
      isPlayable: false,
      error: "Stream URL returned a JSON API response instead of playable video"
    };
  }

  const isPlayable = ["mp4", "webm", "hls", "dash", "mkv"].includes(finalFormat);

  return {
    format: finalFormat,
    status,
    contentType,
    corsBlocked,
    isPlayable,
    initialBytes: probeBytes,
    error: isPlayable ? null : `Unable to detect a supported media format (MP4, WebM, HLS, DASH, MKV) from source URL or headers`
  };
}
