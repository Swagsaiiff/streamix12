import { BaseSourceProvider } from "./provider-interface.js";

const WIKIMEDIA_OPEN_TITLES = {
  // Big Buck Bunny
  "tt1254207": {
    title: "Big Buck Bunny",
    year: 2008,
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm",
    format: "webm",
    quality: "360p",
    license: "Creative Commons Attribution 3.0",
    corsEnabled: true
  },
  // Sintel
  "tt1727587": {
    title: "Sintel",
    year: 2010,
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.360p.vp9.webm",
    format: "webm",
    quality: "360p",
    license: "Creative Commons Attribution 3.0",
    corsEnabled: true
  },
  // Tears of Steel
  "tt2285752": {
    title: "Tears of Steel",
    year: 2012,
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/2/22/Tears_of_Steel_in_4k_-_An_Open_Movie_by_Blender_Foundation.webm/Tears_of_Steel_in_4k_-_An_Open_Movie_by_Blender_Foundation.webm.360p.vp9.webm",
    format: "webm",
    quality: "360p",
    license: "Creative Commons Attribution 3.0",
    corsEnabled: true
  },
  // Elephants Dream
  "tt0841150": {
    title: "Elephants Dream",
    year: 2006,
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/8/83/Elephants_Dream_%282006%29_1080p24.webm/Elephants_Dream_%282006%29_1080p24.webm.360p.vp9.webm",
    format: "webm",
    quality: "360p",
    license: "Creative Commons Attribution 2.5",
    corsEnabled: true
  }
};

function normalizeTitle(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export class WikimediaSourceProvider extends BaseSourceProvider {
  constructor(options = {}) {
    super("wikimedia", "Wikimedia Commons Open Cinema", options);
  }

  async resolveStreams(query = {}, options = {}) {
    const { id, title } = query;

    // 1. Direct ID match
    if (id && WIKIMEDIA_OPEN_TITLES[id]) {
      const item = WIKIMEDIA_OPEN_TITLES[id];
      return {
        sources: [
          {
            url: item.url,
            format: item.format,
            title: item.title,
            quality: item.quality,
            isPlayableInBrowser: true,
            provider: this.name,
            note: `Verified open media stream (${item.license})`,
            corsEnabled: true
          }
        ],
        diagnostics: [`Matched verified Wikimedia open title by ID: ${id}`]
      };
    }

    // 2. Normalized title match
    if (title) {
      const cleanTarget = normalizeTitle(title);
      for (const [key, item] of Object.entries(WIKIMEDIA_OPEN_TITLES)) {
        if (normalizeTitle(item.title) === cleanTarget) {
          return {
            sources: [
              {
                url: item.url,
                format: item.format,
                title: item.title,
                quality: item.quality,
                isPlayableInBrowser: true,
                provider: this.name,
                note: `Verified open media stream (${item.license})`,
                corsEnabled: true
              }
            ],
            diagnostics: [`Matched verified Wikimedia open title by title: "${item.title}"`]
          };
        }
      }
    }

    return {
      sources: [],
      diagnostics: ["Title not found in Wikimedia open cinema library"]
    };
  }
}
