import express from "express";
import { config } from "./config.js";
import { TtlCache } from "./cache.js";
import { createTmdbEnricher } from "./providers/tmdb.js";
import { listConfiguredProviders } from "./providers/index.js";
import { homeRouter } from "./routes/home.js";
import { searchRouter } from "./routes/search.js";
import { detailRouter } from "./routes/detail.js";
import { streamRouter } from "./routes/stream.js";
import { providersRouter } from "./routes/providers.js";
import { createResolver } from "./providers/extractor.js";
import { createStreamManager } from "./providers/stream.js";
import { logger } from "./logger.js";

const routeCache = new TtlCache({ ttlMs: 300000, maxEntries: 200 });
const providerCache = new TtlCache({ ttlMs: 300000, maxEntries: 200 });
const tmdbCache = new TtlCache({ ttlMs: 86400000, maxEntries: 2000 });
const providers = listConfiguredProviders({ cache: providerCache });
const provider = providers[0];
const enricher = createTmdbEnricher({ apiKey: config.tmdbApiKey, cache: tmdbCache });
const streamManager = createStreamManager({
  ffmpegPath: config.ffmpegPath,
  ffprobePath: config.ffprobePath,
  maxConcurrent: config.maxConcurrentSessions,
  sessionMaxAgeMs: config.sessionMaxAgeMs,
  reaperIntervalMs: config.sessionReaperIntervalMs
});
const resolver = createResolver({
  providers,
  fixturePath: config.fixturePath,
  allowFixture: config.fixtureFallback
});

const app = express();
const PORT = config.port;

app.use(express.json({ limit: "16kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    name: "streamix-server",
    version: "0.3.0",
    time: new Date().toISOString()
  });
});

app.use("/api/home", homeRouter({ provider, enricher, cache: routeCache }));
app.use("/api", searchRouter({ provider, enricher, cache: routeCache }));
app.use("/api", detailRouter({ provider, cache: routeCache, providerOptions: { cache: providerCache } }));
app.use(
  "/api",
  streamRouter({
    resolver,
    streamManager,
    defaultLanguage: config.preferredAudioLanguage,
    sessionMaxSeconds: config.sessionMaxSeconds
  })
);
app.use("/api", providersRouter({ fixtureFallback: config.fixtureFallback }));

app.listen(PORT, async () => {
  logger.info("server.start", { port: PORT, provider: provider.getName(), tmdbEnrichment: enricher.isEnabled ? "enabled" : "disabled" });
  try {
    await streamManager.initHlsDir();
    logger.info("hls.workspace_ready", {});
  } catch (err) {
    logger.error("hls.workspace_init_failed", { error: err.message });
  }
});
