import { useEffect, useMemo, useRef, useState } from "react";
import { getStreamResolutionPlan } from "../lib/client-provider.js";
import { tmdbGetSeasonEpisodes } from "../api.js";
import { languageName } from "../lib/languages.js";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const POPULAR_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi" },
  { code: "es", name: "Spanish" },
  { code: "ko", name: "Korean" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "ja", name: "Japanese" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" }
];

function MetaItem({ label, value }) {
  if (!value) return null;
  return (
    <div className="detail-meta-item">
      <span className="detail-meta-label">{label}</span>
      <span className="detail-meta-value">{value}</span>
    </div>
  );
}

export default function DetailModal({ modal, onClose, onPlay, suppressEscape = false, resumeInfo = null }) {
  const { item, detail, state } = modal;
  const closeRef = useRef(null);
  const restoreRef = useRef(null);
  const containerRef = useRef(null);
  const [selectedSeason, setSelectedSeason] = useState(null);
  const [seasonEpisodesCache, setSeasonEpisodesCache] = useState({});
  const [loadingSeason, setLoadingSeason] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState(() => {
    return localStorage.getItem("streamix.lang") || "en";
  });

  const availableLanguages = useMemo(() => {
    const map = new Map();

    const orig = detail?.original_language || item?.original_language;
    if (orig) {
      const origCode = String(orig).toLowerCase();
      const origName = languageName(origCode) || origCode.toUpperCase();
      map.set(origCode, { code: origCode, name: `${origName} (Original)` });
    }

    const spoken = detail?.spoken_languages || [];
    if (Array.isArray(spoken)) {
      for (const sp of spoken) {
        const code = (sp.iso_639_1 || "").toLowerCase();
        if (!code) continue;
        if (!map.has(code)) {
          const name = sp.english_name || sp.name || languageName(code) || code.toUpperCase();
          map.set(code, { code, name });
        }
      }
    }

    for (const pop of POPULAR_LANGUAGES) {
      if (!map.has(pop.code)) {
        map.set(pop.code, pop);
      }
    }

    return Array.from(map.values());
  }, [detail, item]);

  useEffect(() => {
    const container = containerRef.current;
    restoreRef.current = document.activeElement;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") {
        if (suppressEscape) return;
        e.preventDefault();
        onClose();
      }
      if (e.key !== "Tab" || !container) return;
      const focusables = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      restoreRef.current?.focus?.();
    };
  }, [onClose, suppressEscape]);

  // Derive seasons from detail.seasons (TMDB) or detail.episodes
  const seasons = useMemo(() => {
    if (Array.isArray(detail?.seasons) && detail.seasons.length > 0) {
      return detail.seasons.map((s) => ({
        season: s.season,
        name: s.name,
        episodeCount: s.episodeCount || 0
      }));
    }
    if (!detail?.episodes || detail.episodes.length === 0) return [];
    const map = new Map();
    for (const ep of detail.episodes) {
      const list = map.get(ep.season) ?? [];
      list.push(ep);
      map.set(ep.season, list);
    }
    return Array.from(map.entries())
      .map(([season, episodes]) => ({
        season,
        name: `Season ${season}`,
        episodeCount: episodes.length,
        episodes
      }))
      .sort((a, b) => a.season - b.season);
  }, [detail]);

  useEffect(() => {
    if (seasons.length === 0) {
      setSelectedSeason(null);
      return;
    }
    setSelectedSeason((prev) => (prev != null && seasons.some((s) => s.season === prev) ? prev : seasons[0].season));
  }, [seasons]);

  // Populate cache with initial episodes if already present
  useEffect(() => {
    if (Array.isArray(detail?.episodes) && detail.episodes.length > 0) {
      const firstEpSeason = detail.episodes[0].season;
      setSeasonEpisodesCache((prev) => ({
        ...prev,
        [firstEpSeason]: detail.episodes
      }));
    }
  }, [detail]);

  // When selectedSeason changes, fetch episodes if not already cached
  useEffect(() => {
    if (!selectedSeason || !detail?.tmdbId || (detail?.type !== "series" && item?.type !== "series")) return;
    if (seasonEpisodesCache[selectedSeason]) return;

    let cancelled = false;
    setLoadingSeason(true);
    tmdbGetSeasonEpisodes(detail.tmdbId, selectedSeason)
      .then((eps) => {
        if (cancelled) return;
        setSeasonEpisodesCache((prev) => ({
          ...prev,
          [selectedSeason]: eps
        }));
        setLoadingSeason(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingSeason(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSeason, detail, item]);

  const activeSeasonEpisodes = useMemo(() => {
    if (!selectedSeason) return [];
    if (seasonEpisodesCache[selectedSeason]) return seasonEpisodesCache[selectedSeason];
    return (detail?.episodes || []).filter((ep) => ep.season === selectedSeason);
  }, [selectedSeason, seasonEpisodesCache, detail]);

  const backdrop = detail?.backdrop ?? item.backdrop ?? detail?.poster ?? item.poster;
  const poster = detail?.poster ?? item.poster;
  const title = detail?.title ?? item.title;
  const year = detail?.year ?? item.year;
  const rating = detail?.rating ?? item.rating;
  const genres = detail?.genres ?? item.genres;
  const overview = detail?.overview ?? item.overview;
  const runtime = detail?.runtime ?? null;
  const country = detail?.country ?? null;
  const language = detail?.language ?? null;
  const cast = detail?.cast ?? null;
  const director = detail?.director ?? null;
  const writer = detail?.writer ?? null;
  const awards = detail?.awards ?? null;
  const isSeries = (detail?.type ?? item.type) === "series";
  const episodeCount = detail?.numberOfEpisodes || detail?.episodes?.length || 0;

  return (
    <div
      className="modal-overlay"
      ref={containerRef}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="modal-close" onClick={onClose} aria-label="Close details">
          ×
        </button>

        <div className="modal-hero">
          {backdrop && <div className="modal-hero-bg" style={{ backgroundImage: `url(${backdrop})` }} />}
          <div className="modal-hero-shade" />
          <div className="modal-hero-content">
            {poster && (
              <img
                className="modal-poster"
                src={poster}
                alt=""
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            )}
            <div className="modal-hero-text">
              <h2 id="modal-title">{title}</h2>
              <div className="modal-badges">
                {year && <span className="badge">{year}</span>}
                {rating && <span className="badge badge-rating">★ {rating}</span>}
                {runtime && <span className="badge">{runtime}</span>}
                {isSeries && episodeCount > 0 && <span className="badge">{episodeCount} episodes</span>}
                {genres?.slice(0, 3).map((genre) => (
                  <span className="badge badge-genre" key={genre}>
                    {genre}
                  </span>
                ))}
              </div>
              {state === "done" && (
                <div className="modal-actions-bar">
                  <div className="modal-actions">
                    <button
                      className="btn btn-play"
                      onClick={() =>
                        onPlay?.({
                          ...(item || {}),
                          ...(detail || {}),
                          selectedLanguage,
                          lang: selectedLanguage
                        })
                      }
                      title={resumeInfo ? `Resume from ${Math.floor(resumeInfo.position / 60)}m` : "Play"}
                    >
                      {resumeInfo ? "Resume" : "Play"}
                    </button>
                    {resumeInfo && (
                      <button
                        className="btn btn-secondary"
                        onClick={() =>
                          onPlay?.({
                            ...(item || {}),
                            ...(detail || {}),
                            selectedLanguage,
                            lang: selectedLanguage,
                            restart: true
                          })
                        }
                      >
                        Start over
                      </button>
                    )}
                  </div>

                  <div className="modal-lang-selector" title="Choose Preferred Audio Language">
                    <label htmlFor="modal-audio-lang" className="modal-lang-label">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                      <span>Audio:</span>
                    </label>
                    <select
                      id="modal-audio-lang"
                      className="modal-lang-dropdown"
                      value={selectedLanguage}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedLanguage(val);
                        try {
                          localStorage.setItem("streamix.lang", val);
                        } catch {}
                      }}
                      aria-label="Select audio language"
                    >
                      {availableLanguages.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-body">
          {state === "loading" && (
            <div className="detail-loading">
              <div className="player-spinner" aria-hidden="true" />
              <p className="muted">Loading details…</p>
            </div>
          )}

          {state === "error" && (
            <div className="detail-error">
              <p>Failed to load title details.</p>
              <button
                className="btn btn-play"
                onClick={() => onPlay?.({ ...(item || {}), selectedLanguage, lang: selectedLanguage })}
              >
                Play Anyway
              </button>
            </div>
          )}

          {state === "done" && (
            <>
              {overview && <p className="detail-overview">{overview}</p>}

              <div className="detail-meta">
                <MetaItem label="Runtime" value={runtime} />
                <MetaItem label="Country" value={country} />
                <MetaItem label="Language" value={language} />
                <MetaItem label="Rating" value={rating ? `★ ${rating}` : null} />
                <MetaItem label="Director" value={director?.length ? director.join(", ") : null} />
                <MetaItem label="Writer" value={writer?.length ? writer.join(", ") : null} />
                <MetaItem label="Cast" value={cast?.length ? cast.join(", ") : null} />
                <MetaItem label="Awards" value={awards} />
              </div>

              {isSeries && (
                <section className="episodes">
                  {seasons.length > 0 ? (
                    <>
                      <div className="episodes-header">
                        {seasons.length > 1 ? (
                          <label className="season-select">
                            <span>Season</span>
                            <select value={selectedSeason ?? ""} onChange={(e) => setSelectedSeason(Number(e.target.value))}>
                              {seasons.map((s) => (
                                <option key={s.season} value={s.season}>
                                  Season {s.season} {s.episodeCount ? `(${s.episodeCount} eps)` : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <h3>Season {seasons[0].season}</h3>
                        )}
                        <span className="muted">{activeSeasonEpisodes.length} episodes</span>
                      </div>
                      {loadingSeason ? (
                        <div className="detail-loading" style={{ minHeight: "100px" }}>
                          <div className="player-spinner" aria-hidden="true" />
                          <p className="muted">Loading season episodes…</p>
                        </div>
                      ) : (
                        <ul className="episode-grid">
                          {activeSeasonEpisodes.map((ep) => (
                            <li key={ep.id ?? `${ep.season}-${ep.episode}`}>
                              <button
                                type="button"
                                className="episode-card"
                                onClick={() =>
                                  onPlay?.({
                                    ...(item || {}),
                                    ...(detail || {}),
                                    type: "series",
                                    tmdbId: detail?.tmdbId || item?.tmdbId,
                                    imdbId: detail?.imdbId || item?.imdbId,
                                    season: ep.season,
                                    episode: ep.episode,
                                    episodeTitle: ep.name ?? null,
                                    poster: ep.thumbnail ?? item.poster,
                                    selectedLanguage,
                                    lang: selectedLanguage
                                  })
                                }
                              >
                                <span className="episode-thumb">
                                  {ep.thumbnail ? (
                                    <img
                                      src={ep.thumbnail}
                                      alt=""
                                      loading="lazy"
                                      onError={(e) => {
                                        e.currentTarget.style.visibility = "hidden";
                                      }}
                                    />
                                  ) : (
                                    <span className="episode-thumb-fallback">{ep.episode}</span>
                                  )}
                                </span>
                                <span className="episode-body">
                                  <span className="episode-head">
                                    <span className="episode-num">E{ep.episode}</span>
                                    <span className="episode-name">{ep.name ?? `Episode ${ep.episode}`}</span>
                                  </span>
                                  <span className="episode-sub">
                                    {ep.firstAired ? String(ep.firstAired).slice(0, 10) : ""}
                                    {ep.rating ? ` · ★ ${ep.rating}` : ""}
                                  </span>
                                  {ep.overview && <span className="episode-overview">{ep.overview}</span>}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="muted">No episode data available for this series.</p>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}