import { BaseSourceProvider } from "./provider-interface.js";
import { detectFormatFromUrl } from "../source-detector.js";

export class DirectSourceProvider extends BaseSourceProvider {
  constructor(options = {}) {
    super("direct", "Direct Media & Fixtures", options);
  }

  async resolveStreams(query = {}, options = {}) {
    const { streamUrl, mediaUrl, url, sourceUrl, id, title, mediaType } = query;

    // 1. Check local fixtures / sample clips
    if (id === "sample-clip" || id === "multi-audio-test") {
      return {
        sources: [
          {
            url: "/fixtures/multi-audio-test.mkv",
            format: "mkv",
            title: "Dual-Audio Sample Clip (H.264 / AAC Eng + Spa)",
            quality: "360p",
            isPlayableInBrowser: true,
            provider: this.name,
            note: "Built-in dual-audio MKV fixture"
          }
        ],
        diagnostics: ["Resolved built-in dual-audio test fixture"]
      };
    }

    // 2. Check explicit direct media URLs
    const explicitUrl =
      streamUrl ||
      mediaUrl ||
      url ||
      (sourceUrl && !sourceUrl.endsWith(".json") && !sourceUrl.includes("/meta/") ? sourceUrl : null);

    if (explicitUrl) {
      const detected = detectFormatFromUrl(explicitUrl);
      const format = detected !== "unknown" ? detected : (mediaType || "auto");

      if (format !== "json" && format !== "html") {
        return {
          sources: [
            {
              url: explicitUrl,
              format,
              title: title || "Direct Media Stream",
              isPlayableInBrowser: true,
              provider: this.name,
              headers: query.headers || options.headers || {}
            }
          ],
          diagnostics: [`Resolved explicit direct stream URL (${format})`]
        };
      }
    }

    return {
      sources: [],
      diagnostics: ["No direct stream URL or test fixture provided in query"]
    };
  }
}
