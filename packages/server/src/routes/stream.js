import { Router } from "express";
import { sendError } from "../errors.js";
import { logger } from "../logger.js";
import { ProviderError } from "../providers/base.js";
import { proxyMediaRequest, registerStreamToken } from "./proxy.js";

const SESSION_ID_RE = /^[a-f0-9]{64}$/;
const FILE_RE = /^[A-Za-z0-9._-]+$/;
const inflightSessions = new Map();

function sanitizeClientHeaders(headers = {}) {
  const safe = {};
  const sensitive = /^(cookie|set-cookie|authorization|proxy-authorization|x-amz-|token|secret)/i;
  for (const [key, val] of Object.entries(headers)) {
    if (!sensitive.test(key)) {
      safe[key] = val;
    }
  }
  return safe;
}

function validSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function validFile(value) {
  return typeof value === "string" && value.length <= 80 && FILE_RE.test(value);
}

export function streamRouter({
  provider,
  cache,
  streamManager,
  resolver,
  defaultLanguage = null,
  sessionMaxSeconds = 0
}) {
  const router = Router();

  router.all("/stream/proxy", (req, res) => {
    return proxyMediaRequest(req, res);
  });

  router.all("/proxy", (req, res) => {
    return proxyMediaRequest(req, res);
  });

  router.post("/stream/:type/:id", async (req, res) => {
    const { type, id } = req.params;
    const preferredLanguage =
      req.query.lang ?? req.query.preferredLanguage ?? defaultLanguage ?? null;
    const providerName = req.query.provider ? String(req.query.provider) : null;
    const season = req.query.season != null && req.query.season !== "" ? Number(req.query.season) : null;
    const episode = req.query.episode != null && req.query.episode !== "" ? Number(req.query.episode) : null;
    const allowFixture =
      req.query.fixture === "1" || req.query.fixture === "true"
        ? true
        : req.query.fixture === "0" || req.query.fixture === "false"
          ? false
          : undefined;

    try {
      logger.info("stream.resolve", { type, id, preferredLanguage, provider: providerName });
      const stream = await resolver.resolveStream(type, id, {
        preferredLanguage,
        provider: providerName,
        allowFixture,
        season: Number.isFinite(season) ? season : null,
        episode: Number.isFinite(episode) ? episode : null
      });
      logger.info("stream.source_resolved", {
        sourceType: stream.sourceType,
        resolution: stream.resolution.status,
        provider: stream.provider.name
      });

      if (stream.sourceType === "local_fixture") {
        logger.warn("stream.fixture_fallback", { type, id, provider: providerName });
      }

      const useBackendSession = req.query.legacyBackend === "1" || req.query.legacyBackend === "true";
      let session = null;
      if (useBackendSession) {
        const dedupeKey = `${stream.provider.name}:${type}:${id}:${season ?? ""}:${episode ?? ""}:${preferredLanguage ?? ""}:${stream.sourceUrl}`;
        let sessionPromise = inflightSessions.get(dedupeKey);
        if (!sessionPromise) {
          sessionPromise = streamManager
            .createSession(stream.sourceUrl, {
              preferredLanguage,
              maxSeconds: sessionMaxSeconds,
              headers: stream.headers ?? {},
              variants: stream.variants ?? null
            })
            .finally(() => inflightSessions.delete(dedupeKey));
          inflightSessions.set(dedupeKey, sessionPromise);
        } else {
          logger.info("stream.session_deduped", { type, id, provider: providerName });
        }
        session = await sessionPromise;
        logger.info("stream.session_created", { sessionId: session.sessionId, status: session.status });
      }

      const streamToken = registerStreamToken({
        url: stream.sourceUrl,
        headers: stream.headers ?? {},
        provider: stream.provider?.name
      });

      res.status(201).json({
        sessionId: session?.sessionId ?? null,
        streamToken,
        proxyUrl: `/api/stream/proxy?token=${streamToken}`,
        provider: stream.provider,
        resolution: stream.resolution,
        quality: stream.resolution?.quality ?? null,
        qualities: Array.isArray(stream.variants) ? stream.variants.map((variant) => `${variant.height}p`) : null,
        status: session?.status ?? "ready",
        streamMode: session?.mode ?? "client",
        streamModeReason: session?.streamMode?.reason ?? "client_side_playback",
        audioTracks: session?.audioTracks ?? [],
        preferredLanguage: session?.audioTracks?.find((t) => t.default)?.language ?? preferredLanguage ?? null,
        title: stream.title,
        year: stream.year,
        episode: stream.episode ?? null,
        mediaType: stream.mediaType,
        sourceUrl: stream.sourceUrl,
        variants: stream.variants ?? null,
        headers: sanitizeClientHeaders(stream.headers ?? {}),
        note: stream.note ?? null,
        playlistUrl: session?.sessionId ? `/api/stream/${session.sessionId}/master.m3u8` : null
      });
    } catch (err) {
      if (err instanceof ProviderError) {
        logger.warn("stream.resolve_failed", { type, id, code: err.code, reason: String(err.message).slice(0, 200) });
      } else {
        logger.error("stream.unexpected_error", { type, id, reason: String(err?.message).slice(0, 300), stack: String(err?.stack ?? "").split("\n").slice(0, 4).join(" | ") });
      }
      return sendError(res, err);
    }
  });

  router.get("/stream/:sessionId/master.m3u8", async (req, res) => {
    const { sessionId } = req.params;
    if (!validSessionId(sessionId)) {
      return res.status(400).json({ error: "validation_error", message: "Invalid session id" });
    }
    try {
      const { content } = await streamManager.getMasterPlaylist(sessionId);
      res.type("application/vnd.apple.mpegurl");
      res.send(content);
    } catch (err) {
      if (err.message.includes("not ready") || err.message.includes("not found")) {
        return res.status(404).json({ error: "not_found", message: "Session not found or not ready" });
      }
      return res.status(500).json({ error: "internal_error", message: "Failed to read playlist" });
    }
  });

  router.get("/stream/:sessionId/status", async (req, res) => {
    const { sessionId } = req.params;
    if (!validSessionId(sessionId)) {
      return res.status(400).json({ error: "validation_error", message: "Invalid session id" });
    }
    const session = await streamManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "not_found", message: "Session not found" });
    }
    res.json({
      sessionId: session.sessionId,
      status: session.status,
      streamMode: session.mode,
      audioTracks: session.audioTracks,
      error: session.error,
      stderr: session.stderr ? session.stderr.slice(-500) : null,
      playlistUrl:
        session.status === "ready" || session.status === "streaming"
          ? `/api/stream/${sessionId}/master.m3u8`
          : null
    });
  });

  router.get("/stream/:sessionId/:file", async (req, res) => {
    const { sessionId, file } = req.params;
    if (!validSessionId(sessionId) || !validFile(file)) {
      return res.status(400).json({ error: "validation_error", message: "Invalid session id or file name" });
    }
    try {
      const fullPath = await streamManager.resolveFile(sessionId, file);
      res.sendFile(fullPath);
    } catch (err) {
      if (err.message.includes("not ready") || err.message.includes("not found")) {
        return res.status(404).json({ error: "not_found", message: "Session or file not found" });
      }
      return res.status(400).json({ error: "validation_error", message: "Invalid session id or file name" });
    }
  });

  router.delete("/stream/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    if (!validSessionId(sessionId)) {
      return res.status(400).json({ error: "validation_error", message: "Invalid session id" });
    }
    await streamManager.cleanupSession(sessionId);
    res.json({ status: "cleaned" });
  });

  return router;
}
