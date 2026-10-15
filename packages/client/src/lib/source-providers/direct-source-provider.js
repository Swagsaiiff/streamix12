import { BaseSourceProvider } from "./provider-interface.js";
import { detectFormatFromUrl } from "../source-detector.js";

export class DirectSourceProvider extends BaseSourceProvider {
  constructor(options = {}) {
    super("direct", "Direct Media", options);
  }

  async resolveStreams(query = {}, options = {}) {
    const { streamUrl, mediaUrl, url, sourceUrl, title, mediaType } = query;

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
      diagnostics: ["No direct stream URL provided in query"]
    };
  }
}
