# STREAMIX — Progress

## Current phase

Post-Phase-5 restoration: CSX catalog/search/poster repair and playback honesty (requested repair work).

## Multi-provider search, search-result details, and real playback (verified)

## Real-playback bug fix (progressive HLS + remux) and stale provider status

## Three fixes: CineStream real playback, search grid, search relevance

## Intermittent playback failures: root causes and fixes

## Series playback fix + player redesign

### Series failures (e.g. "Legend of the Blue Sea (2016)") — root cause and fix

Inspected the live VegaMovies series page and chain:
- Series pages have **no `dwd-button` anchors** (movie-only). Links sit in quality `<h3>` sections as direct host links: `nexdrive.beer/genxfm…` labelled "⚡ Single Episodes" / "Batch/Zip". Our `HOST_PATTERN` **omitted `nexdrive`**, and `extractDownloadPageLinks` only matched `dwd-button` → zero candidates → "no playable media" → 422.
- Verified the real chain works: series page → `nexdrive` → nested `vcloud` → `atob(atob(...))` token → direct signed media `Legend.Of.The.Blue.Sea.S01E01.480p.Hindi.WEB-DL…mkv` (R2 + workers.dev mirror).
- Nested pages also contain CMS noise (`xmlrpc.php`, `feed`, `wp-json`, `wp-content`); these are now filtered so they cannot consume the candidate budget.

Changes (`vegamovies.js`):
- `HOST_PATTERN` extended (`nexdrive`, `gdflix`, `hubdrive`, `driveseed`, `driveleech`, `drivebot`) and a `NOISE_LINK_PATTERN` filter applied in `extractHostLinks`.
- New `extractLinkPages(html, baseUrl)` returns ordered `{url,label,kind}` link pages for **both** layouts (`dwd-button` movie downloads and series host links), noise-filtered.
- `resolveStream` now uses `extractLinkPages` (limit 4), follows hosts with noise filtering (limit 6), and reports the chosen page section in the note; per-page failures are logged (`vega.link_page_failed`, `vega.link_pages`).
- Logging added earlier retained: `vega.title_search`, `vega.title_candidates`, `vega.extraction_candidates`, `vega.ffprobe_check`, `vega.media_validated`, `vega.resolved`, `vega.candidate_failed`, `vega.extraction_failed`.

Verified live: `POST /api/stream/series/tt5766194?provider=CineStream` → 5.8 s, `provider_stream`, mode `remux`, master 200, segment 200 (48 KB). Browser: series plays — "Real source · VegaMovies", `duration=1244.9 s`, `readyState=4`, no media error.

### Player UI redesign

`Player.jsx` rewritten as a modern streaming overlay with a **working** controller (no decorative controls):
- Cinematic black stage, `object-fit: contain` video, gradient top/bottom overlays.
- Top bar: Back, title, TEST MODE / "Real source · provider" badges, source note (ellipsised, full text on hover).
- Bottom controller: play/pause, −10 s / +10 s, **timeline with buffered + played fill and elapsed/total time**, **volume slider + mute**, **audio-track selector**, **language preference**, **playback speed**, **fullscreen**.
- Controls show on mouse/touch movement and auto-hide after 3 s of inactivity while playing (verified: `visibleOnMove=true`, `hiddenAfterIdle=true`); cursor hides too.
- Loading spinner during resolution; compact centred error panel (max 420 px — not stretched) with **Retry** and Back.
- Keyboard: Space/K play-pause, ←/→ ±10 s, M mute, F fullscreen, Esc back; form fields excluded.
- Session/HLS cleanup preserved (destroy + DELETE session, orphan cleanup on aborted mount).

Fix found during verification: `hls.audioTracks` was read at `MANIFEST_PARSED`, when it is still empty, so the audio selector never rendered. Now subscribed to `Hls.Events.AUDIO_TRACKS_UPDATED` (with `MANIFEST_PARSED` re-sync). Verified in-browser: 2 real tracks (`hin`, `eng`), switching to `eng` keeps playing with no media error. Rendition names no longer duplicate the language (`hin`, not `hin (hin) (hin)`).

### Verification (all observed)

- `npm run test` → **86/86 pass** (added: series host-link collection, noise filtering, `extractLinkPages` movie+series, series chain to validated media, master CODECS output-vs-source, unique rendition names).
- `npm run build` → OK.
- Browser: spinner shown; all controls present and functional (speed → 1.5, volume → 0.3, seek, autohide, Back → modal); audio selector with `hin`/`eng` and successful switch; series and movie titles both play real sources; "War Dogs" (no source) shows the compact error panel with a working Retry and an honest message.

### Remaining blockers

- Titles with no close VegaMovies match by title+year still return an explicit error (no fabrication).
- Series playback uses the first available episode link ("Single Episodes"); full season/episode selection UI is not implemented.
- Non-H.264/AAC sources transcode (slower start; `streamMode` reports it).

### Root cause of the intermittent browser stall (found and fixed)

`buildMasterPlaylist` derived `CODECS` from the **source** probe, so a session that **transcoded** a non-H.264 source (e.g. HEVC) advertised `CODECS="hvc1..."` while the HLS variants were actually H.264/AAC. hls.js parsed the master, found no level it could play (HEVC unsupported in the test browser's MSE), requested no variant, and the player sat at `readyState 0` — an intermittent "some titles play, others do not" failure (remux/H.264 titles played; HEVC-source titles stalled). Fix: `buildMasterPlaylist({ ..., mode })` now advertises the **output** codecs (`avc1.4d401f,mp4a.40.2` when transcoding). Verified: `Inception` (HEVC source, `mode=transcode`) now plays in the browser — `duration=172.05s`, `readyState=4`, `error=null`, full segment chain 200.

### Title-fallback and diagnostics changes

- `vegamovies.js`: `rankTitleCandidates()` scores by normalized title, year and type (type bonus/penalty rather than a hard filter, dedupe by id, cap 5); `resolveByTitle()` now walks candidates **in rank order**, continuing to the next when a candidate's detail fetch, host-chain extraction, or ffprobe validation fails, and returns the first validated source (note records "candidate N of M"); all-candidates-failed raises an aggregated `unsupported` error listing each candidate and reason. Unknown titles still raise an honest `not_found`.
- Structured logs added: `resolve.title_bridge`, `vega.title_search`, `vega.title_candidates`, `vega.extraction_candidates`, `vega.ffprobe_check`, `vega.media_validated`, `vega.resolved`, `vega.candidate_failed`, `vega.extraction_failed`, `vega.title_no_match`, `resolve.title_bridge_failed` (host-only, no signed URLs logged).
- `extractor.js`: bridge attempts are logged; the final unsupported error now includes the title-bridge failure reason; `resolution` carries `matchedBy`, `matchScore`, `matchesTried`.
- Provider-specific ids preserved: cinemeta `tt…` ids are still routed to CineStream, VegaMovies permalinks to VegaMovies (the bridge only runs for ids the requested provider owns, and adapters reject foreign ids with a permanent `unsupported` error rather than retrying).
- Source headers preserved end-to-end (`Referer` from the resolver reaches ffprobe validation and is returned in the resolved source for FFmpeg).

### Verification (live)

- CineStream titles resolved via the title bridge (exact title + year, score 1210): The Batman (2022), Inception (2010), Oppenheimer (2023), Dune (2021 — ranked above Dune 1984), Avengers: Endgame (2019), Spy x Family Code: White (2023). Honest failures: War Dogs (2016) — no VegaMovies match; series (e.g. `tt5766194`) — episode extraction not ported.
- Browser end-to-end: transcoded CineStream title plays (`readyState=4`, `duration=172.05s`, no media error); HLS + audio tracks unchanged.
- `npm run test` → **81/81 pass** (added: transcode-vs-remux CODECS, ranked candidates, next-candidate-on-failure, aggregated all-failed error, honest no-match, bridge success/failure through the resolver).
- `npm run build` → OK. `GET /api/providers/status` → `verifiedRealProviderPlayback=true`, `realPlaybackProviders=["VegaMovies"]`.

### Remaining blockers

- Series episode extraction for VegaMovies still not ported (music/series titles return an explicit error).
- Titles with no close VegaMovies match (by title + year) return an explicit 422.
- Non-H.264/AAC sources transcode (slower start; `streamMode` reports which).

### 1. CineStream titles now play real streams (title bridge)

- **Blocker fixed:** CineStream is metadata-only (no extractor); its ids are IMDb ids, so its titles previously ended in `No real stream source is available`.
- **Implementation:** `VegaMoviesProvider.resolveByTitle({ title, year, type })` searches the real VegaMovies index, scores candidates (`normalizeForMatch`, `scoreTitleMatch`, `pickBestMatch` with `minScore 400`), fetches the matched detail page and runs the existing real extractor chain. `extractor.js` calls it after the per-provider loop when a provider has no extractor, and reports `resolution.status=provider_stream`, `provider=VegaMovies`, `resolution.requestedProvider`, `matchedBy: "title"`, `matchScore`.
- **Verified:** `POST /api/stream/movie/tt1877830?provider=CineStream` (The Batman 2022) → `provider_stream` via VegaMovies title match (score 1120), 13.4 s, 2 audio tracks, mode `transcode`. Honest negative: `POST /api/stream/movie/tt2005151?provider=CineStream` (War Dogs 2016) → 422 because VegaMovies genuinely has no such title (its search returns other "war" films scored < 400) — no fabrication, no fixture.

### 2. Search results: responsive grid (was one horizontal row)

- New `packages/client/src/components/Grid.jsx`; `App.jsx` renders search results with `<Grid>` instead of `<Row>`.
- CSS `.grid`: `grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))` with breakpoints at 1024 px (135 px) and 640 px (110 px); `.grid .card` fills the column so poster sizes are consistent.
- **Measured (Puppeteer + Edge, query "batman"):** 1440 px → 8 columns, 900 px → 5 columns, 390 px → 2 columns; card width uniform (~154 px); poster ratio 1.5 (2:3); multiple rows. Homepage rows unchanged.

### 3. Search relevance ranking

- `routes/search.js`: `normalizeTitle` (lowercase, NFKD, strip diacritics + punctuation) and `relevanceScore` (exact 1000 > starts-with 800/750 > word-boundary 600 > all-tokens 450 > contains 350 > token-overlap ≤200) with `rankSearchResults` (score desc, then newer year, then source order). Applied after the multi-provider merge.
- **Verified live:** `q=batman` → "Batman" (1989), "Batman" (1966) first, then prefixes; `q=the batman` → "The Batman" (2022) first; `q=Spider-Man: No Way Home` → exact 2021 entry first despite 40+ variants.

### Tests

- `npm run test` → **74/74 pass** (added relevance/normalization/ranking tests and VegaMovies `normalizeForMatch`/`scoreTitleMatch`/`pickBestMatch` tests; two initial test cases were corrected where the fixture titles genuinely started with the query).
- `npm run build` → OK.

### Remaining playback blockers

- Titles whose name/year do not closely match any VegaMovies post return an explicit 422 (real gap, not a bug).
- Non-H.264/non-AAC sources still transcode (slower start; mode reported).
- VegaMovies series episode extraction still not ported; Bollyflix/MoviesDrive/Moviesmod remain Cloudflare-blocked.

### Reproduced failure

- `POST /api/stream/movie/<vega permalink>?provider=VegaMovies` with the default `.env` (no `STREAMIX_SESSION_MAX_SECONDS`) never returned until a **full VOD transcode** of a 963 MB movie finished: `createSession` awaited FFmpeg exit and `-hls_playlist_type vod` only writes playlists at the end. Play therefore hung on "Resolving stream and preparing HLS..." — the reported blue/stuck state. Verified working earlier only because a 45 s cap env var was set.

### Root causes and fixes (packages/server/src/providers/stream.js)

1. **No progressive playback** → FFmpeg now uses `-hls_list_size 0 -hls_playlist_type event`; `createSession` returns as soon as the video variant playlist and first segment exist (`status: "streaming"`) instead of waiting for process exit; `getMasterPlaylist`/`resolveFile` accept `ready` or `streaming`.
2. **Always re-encoded** → new `pickStreamMode()` remuxes (`-c:v copy -c:a copy`) when video is H.264 and every audio track is AAC, otherwise transcodes (`libx264`/`aac`). Mode and reason are returned by the API (`streamMode`, `streamModeReason`).
3. **Master playlist had no video variant** (the client stall) → with `event` playlists FFmpeg's auto-generated master (`-master_pl_name`) contained only `#EXT-X-MEDIA` audio renditions and **never** a `#EXT-X-STREAM-INF`; hls.js parsed zero levels and never requested the variant playlist (browser showed `readyState: 0`, no variant/segment requests). Fix: drop `-master_pl_name` and write the master ourselves (`buildMasterPlaylist`) from the ffprobe data, including `#EXT-X-STREAM-INF` with BANDWIDTH/RESOLUTION/CODECS/AUDIO.
4. **Duplicate rendition names** → both audio tracks carried the same release-group title, producing two `NAME="VegaMovies.is"` entries; names are now made unique (`<name> (<lang>)`, with a numeric suffix when still duplicated).
5. **ffprobe ignored source headers** → `probeStreams(ffprobePath, url, headers)` now forwards the resolver's headers (Referer/UA) to ffprobe.
6. **Stale `/api/providers/status`** → `routes/providers.js` hardcoded `verifiedRealProviderPlayback: false` and the "no extractor ported" blocker. It now derives the flag and the real-provider list from `getProviderStatuses()` and reports `fixtureFallbackEnabled`.

### Verification (observed)

- `POST /api/stream/movie/<permalink>?provider=VegaMovies`, no cap → session in **7.4-11.8 s**, `status=streaming`, `streamMode=remux`, reason `copy (h264 + aac/aac)`, 2 audio tracks, `resolution.status=provider_stream`.
- Master playlist (immediately after ready): 2 `#EXT-X-MEDIA:TYPE=AUDIO` (unique names, `DEFAULT=YES`/`NO`, `LANGUAGE="hin"`/`"eng"`) + `#EXT-X-STREAM-INF:BANDWIDTH=...,RESOLUTION=856x356,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="group_aud"` → `index_v0.m3u8`.
- Progressive growth: video segments 273 → 590 within 12 s; variant playlist listed 590 `#EXTINF`. `seg_v0_000.ts` 200 `video/mp2t`.
- `GET /api/stream/:sid/status` → `streaming`, `streamMode=remux`, `playlistUrl` present.
- `GET /api/providers/status` → `verifiedRealProviderPlayback=true`, `realPlaybackProviders=["VegaMovies"]`, `fixtureFallbackEnabled=false`.
- Browser (Puppeteer + Edge, real title): badge "Real source - VegaMovies", `video.duration=888.33 s` (the full movie, not the fixture), `currentTime` advancing, `readyState=4`, `error=null`; requests: master → `index_v0.m3u8` → `index_a0.m3u8` → video+audio segments, all `200`.
- `npm run test` → **65/65 pass** (added `pickStreamMode` and `buildMasterPlaylist` unit tests; stream tests accept `ready`/`streaming`). `npm run build` → OK.

### Files changed this round

- `packages/server/src/providers/stream.js` (progressive event HLS, `pickStreamMode`, `buildMasterPlaylist`, header-aware probe, unique rendition names, servable `streaming` state)
- `packages/server/src/routes/stream.js` (`streamMode`/`status` in responses; status endpoint reports mode/stderr)
- `packages/server/src/routes/providers.js` (status derived from providers; fixture flag)
- `packages/server/src/index.js` (pass `fixtureFallback` to providers router)
- `packages/server/src/providers/stream.test.js` (new/updated tests)

### Remaining limitations

- Non-H.264 video or non-AAC audio still requires transcoding (slower start, CPU-heavy); mode is reported so the client can show it.
- Series episode extraction for VegaMovies is still not ported; other CSX providers (Bollyflix/MoviesDrive/Moviesmod) remain Cloudflare-blocked and unimplemented.
- Signed provider URLs expire (~3 h); each play re-resolves (never cached).

### Diagnosed root causes

1. **Search missed titles** — only one provider (CineStream/cinemeta) was searched; the four other CSX providers were never queried. Fixed by adding a second real provider adapter (VegaMovies) and searching all search-capable providers concurrently.
2. **Search-result clicks did not open details** — the search-results `Row` in `App.jsx` was rendered without `onSelect`, so cards had no click handler. Also, details always used the default provider, so a VegaMovies result was looked up by the CineStream adapter (`/api/detail/movie/<permalink>` → 502). Fixed with `onSelect` + a `provider` parameter end-to-end.
3. **Blue screen on Play** — the resolver always fell back to the local test fixture (a solid-blue synthetic clip) and FFmpeg played it, so Play never used a real source. Fixed by implementing a real VegaMovies extractor path and changing the fixture to an explicit, labelled opt-in.

### Provider source inspected and chosen

- Inspected `Bollyflix/BollyflixProvider.kt`, `MoviesDrive/MoviesDriveProvider.kt`, `Moviesmod/MoviesmodProvider.kt`, `VegaMovies/VegaMoviesProvider.kt`, `VegaMovies/Extractors.kt` on CSX `master`.
- **VegaMovies chosen** because its search is a JSON endpoint (`GET {base}/search.php?q=…&page=1`), portable to Node without JS execution; details resolve via the `imdb_id` on the page + cinemeta merge; and its movie link chain reaches a **direct signed media URL**.
- **Bollyflix / MoviesDrive / Moviesmod** are HTML-scrape providers guarded by Cloudflare (`cfKiller` interceptor) and need a browser/anti-bot path — not ported this round (documented blocker, not claimed as supported).
- Base URL is read dynamically from the CSX `Utils/urls.json` (`vegamovies` key) with a known fallback.

### Real playback path (implemented and verified)

`search.php` JSON → detail page (title/poster/`imdb_id`) → `a:has(button.dwd-button)` download pages → host links (`vcloud.beer` etc.) → `atob(atob(...))` token URL → direct signed media URL on Cloudflare R2 (`.mkv`, expiring `X-Amz-Expires`) → validated with ffprobe → existing FFmpeg → HLS pipeline.

Live evidence for "Beast of War (2025)":
- `POST /api/stream/movie/<permalink>?provider=VegaMovies` → `resolution.status=provider_stream`, `provider=VegaMovies`, note "Resolved from VegaMovies (real provider source)", 2 audio tracks, session ready in ~17 s.
- Real master playlist: `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_1",DEFAULT=YES,LANGUAGE="hin"` + `audio_2 DEFAULT=NO LANGUAGE="eng"` + a 856x356 H.264 video variant (real Hindi/English dual audio). Segment `seg_v0_000.ts` served 200 `video/mp2t` (163 KB).
- Browser journey (Puppeteer + Edge): search "war" → 66 cards (CineStream 54, VegaMovies 12); clicked a VegaMovies card → detail request `?provider=VegaMovies` → modal "Beast of War · 2025 · 5.4 · Action, Biography, Drama"; Play → badge "Real source - VegaMovies"; `video.currentTime=3.57s, duration=45.09s, readyState=4, paused=false`; console errors `[]`.

### Fixture policy (no silent substitution)

- `STREAMIX_FIXTURE_FALLBACK` (default **false**): when a title has no supported real extractor, Play returns `422 unsupported` with an actionable message (verified: "No real stream source is available for this title (no supported extractor in: CineStream). VegaMovies search results can play real sources.").
- Passing `?fixture=1` explicitly opts into the local fixture, which is labelled "TEST MODE" in the API note and as a yellow badge in the player. Real playback shows a green "Real source" badge.

### Additional fixes in this round

- Multi-provider search: bounded per-provider timeout (12 s), `Promise.allSettled`-style isolation (one provider failing never blocks others), cross-provider dedupe by `type+normalizedTitle+year` (remakes and movie/series with the same name are preserved), and per-provider diagnostics returned to the client (`providers:[{provider,count,ms,error}]`) and logged.
- Provider-aware details: `GET /api/detail/:type/:id?provider=Name`; unknown provider falls back safely; the resolver tries the requested provider first.
- Resolver fan-out: a non-requested provider rejecting an id no longer aborts resolution; the explicitly requested provider's permanent error does abort.
- In-flight session dedupe: concurrent identical play requests (e.g. React StrictMode double-mount) share one HLS session — verified: two requests → one `stream_created`.
- Player releases an aborted mount's session (`cleanupStream`) so no orphan session lingers.
- FFmpeg now receives source headers when the resolver supplies them; optional `STREAMIX_SESSION_MAX_SECONDS` bounds transcode length (used at 45 s for verification).

### Provider status (honest)

- **CineStream** — catalog/search/detail (metadata). Real stream resolution: not implemented.
- **VegaMovies** — search/details/real playback: implemented and verified. `verifiedRealPlayback: true` in `/api/providers/status`.
- **Bollyflix / MoviesDrive / Moviesmod** — not implemented (Cloudflare-gated scraping). Not claimed as supported.

### Specs added/attempted

- `STREAMIX_FIXTURE_FALLBACK`, `STREAMIX_SESSION_MAX_SECONDS` documented in `.env.example`.

### Commands and results

- `npm run test` → 63/63 pass (added: VegaMovies parsers/chain/placeholder-filter, multi-provider merge/dedupe, provider-param routing, fixture policy, fan-out semantics).
- `npm run build` → Vite 8.3.4 OK (main 238 kB + lazy hls chunk).
- Live curl checks and the browser journey above.

### Remaining limitations

- Resolution depends on third-party hosts (`vcloud.beer` etc.) and expiring signed URLs; each play re-resolves (by design — no caching of expiring URLs).
- VegaMovies movie chain verified; **series** episode link extraction is not ported (returns the clear "no playable media" error).
- `ffprobe` validation is required before a candidate is used, so a slow host can add latency.

## Mandatory bug-fix round (visible failures, browser-verified)

### Reproduced (browser harness: Puppeteer-core + Edge, computed styles + image network checks)

1. Poster boxes had `width: 0` (poster images collapsed); 35/72 home posters dead.
2. `.card-title` and `.card-meta` computed `display: inline` — titles, media types, years, ratings ran together on one line.
3. Root cause of 1+2: the Phase-5 TitleCard rewrite used `<span>` containers whose CSS (`width`, `padding-top`, `white-space`, `overflow`, `text-overflow`) only works on block boxes, but the spans were left inline.
4. Search backend was 404 (`/api/search` mount mismatch) in the prior state; UI results were gated behind a `view === "search"` that nothing ever set.
5. Catalog responses were blocked on serial, timeout-less TMDB lookups; the shared route/TMDB cache (500 entries) let TMDB inserts evict route responses, causing constant upstream refetch + re-enrich churn ("pending" forever) and slower loads.
6. Trending and Latest drew from the same catalog slice (19/24 identical titles).
7. Row headers exposed provider jargon (`ranking` strings) to visitors.

### Fixes implemented and verified in-browser

- `index.css`: `.card-poster`, `.card-title`, `.card-meta` are `display: block`; `.card` gets a fixed `width: 150px` (120px mobile); poster box measures exactly 150x225 (2:3); title and metadata are separate block elements; placeholder stays behind lazy posters.
- `App.jsx`: search sets `view: "search"`, clear returns home, latest-query guard prevents stale overwrite.
- `index.js`: dedicated caches — `routeCache` (200), `providerCache` (200), `tmdbCache` (2000, 24h) — no more cross-eviction between routes and TMDB lookups.
- `home.js`: enrichment runs in background on the displayed 24-item slice only; honest section titles "Top Movies" / "Newest Movies" / "Top Series"; "Newest Movies" sourced from a separate catalog band (skip 147+, 5 pages, newest-first, documented in the API `ranking`).
- `cinemeta.js`: `getTopMovies/getTopSeries` accept a `startSkip` so sections can draw from different catalog positions.
- `Row.jsx`/`App.jsx`: `ranking` jargon no longer rendered (still present in API payloads).
- `index.html`: data-URI favicon removes the stray 404 console error.

### Browser verification (Puppeteer + Edge, real page at localhost:5173)

- Home: 72 cards; computed `posterBox 150x225`; `titleDisplay`/`metaDisplay = block`; `loadedImages 72/72`, `broken 0`; console errors `[]`; row titles "Top Movies | Newest Movies | Top Series".
- Search "from": 54 cards, first "From Dusk Till Dawn (1996)"; after horizontal scroll `54/54` posters loaded.
- Search "dune": 23 cards, first "Dune (2021)".
- Clear: catalog restored (72 cards, 72/72 posters).
- API: trending 24/24 and latest 24/24 items carry poster fields without TMDB; overlap trending-vs-latest now `0/24`; first catalog response returns in 0.2-0.3 s with `enrichment.status=pending`, then `enabled` on the next fetch; third fetch `0.004 s` (stable cache).
- Search endpoint timing: cached searches `0.00-0.13 s`; cold 0.4-5.4 s (upstream warm-up); direct upstream probes 71-470 ms.
- `npm run test` → 34/34 pass; `npm run build` → OK (main 238 kB, lazy hls 575 kB).

### Files changed in this round

- `packages/client/src/index.css`, `packages/client/src/components/Row.jsx`, `packages/client/src/App.jsx`, `packages/client/index.html`
- `packages/server/src/index.js`, `packages/server/src/routes/home.js`, `packages/server/src/providers/cinemeta.js`

## Confirmed defects reproduced before repair

1. **Search API was 404.** The search router defines `GET /search` but was mounted at `/api/search`, so the real path was `/api/search/search`; `GET /api/search?q=...` returned `Cannot GET /api/search`.
2. **Search results never rendered in the UI.** App only rendered results when `view === "search"`, but no code path ever set that view (nav links are Home/Movies/Series).
3. **Catalog responses blocked on TMDB.** `home.js` and `search.js` did `await enricher.enrich(items)` before responding; the enricher made a serial, timeout-less TMDB HTTP call per item (146 calls for trending), making TMDB effectively required for the catalog to appear.
4. **Metahub posters were routed through the wsrv.nl proxy unnecessarily.** Direct `images.metahub.space` posters return 200 with a browser UA; the extra proxy hop added an external dependency for every card.
5. **Search input was disabled while results loaded**, blocking continued typing.
6. Playback explicitly fell back to a local fixture (correct behavior); it was labeled, but the real-provider blocker was not precisely pinned to the extractor layer.

## Fixes implemented

- `index.js`: search router mounted at `/api` → `/api/search` works again.
- `App.jsx`: `handleSearch` sets `view = "search"`; `clearSearch` returns to home; `latestQueryRef` guard ensures older responses cannot overwrite newer results (belt-and-braces with the existing abort).
- `SearchBox.jsx`: input stays enabled while requests are in flight; debounce + abort/cancel preserved.
- `tmdb.js`: bounded concurrency (`mapWithConcurrency`, 4 workers), 4 s per-search timeout, items preserved in order.
- `home.js` / `search.js`: provider data is returned **immediately**; when TMDB is configured, enrichment runs in the background and warms the cache (first response `enrichment.status: "pending"`, next fetch `"enabled"` with matched count). TMDB is never required for cards to render.
- `cinemeta.js`: metahub poster URLs are served directly (only Kitsu images stay proxied via wsrv).
- Tests: `mapWithConcurrency` order/limit/empty/rejection coverage.

## Verification (actual results)

- `npm run test` → 34/34 pass
- `npm run build` → OK (main 238 kB, lazy hls chunk 575 kB)
- `GET /api/home/trending` → 0.13 s cold, `enrichment.status=pending`, 24 items; poster now direct `https://images.metahub.space/poster/small/tt6933238/img`; next fetch `cached=true enrichment=enabled matched=146`
- `GET /api/search?q=batman` → 37 results, first `Batman` (1989); `inception` → 30 (`Inception`); `avengers` → 33 (`Avengers: Endgame`); `dune` → 23 (`Dune`); `interstellar` via Vite proxy → 31 (`Interstellar`)
- Cold search latency bound: 0.4-5.4 s (upstream warm-up); cached searches are instant (0.00-0.13 s); direct upstream endpoint probes measured 71-470 ms each
- Proxy page 200/STREAMIX; stream session: `provider=CineStream/local_fixture`, `resolution.status=fixture_fallback`, note "Provider stream resolution is not implemented yet; playing the local test fixture"; playlist 200 `application/vnd.apple.mpegurl`; cleanup OK
- Missing-poster path (TitleCard placeholder behind image) unchanged and verified by code review

## Provider documentation (inspection notes)

- Inspected the real CSX sources: `CineStream/src/main/kotlin/com/megix/{CineStreamProvider,CineStreamExtractors,ApiConstants,CineSimklProvider,CineTmdbProvider}.kt` on the CSX `master` branch, plus the `builds/CS.json` manifest and provider metadata.
- Catalog/search/detail flow used by STREAMIX is the CineStream main API port (cinemeta top catalogs, v3-cinemeta search, kitsu anime search, meta detail) — primary source, no TMDB dependency.
- Playback blocker (exact step): `CineStreamProvider.loadLinks` → `invokeAllSources(...)` → dozens of host extractors (GDLink, GDFlix, febbox, akwam, levidia, ...). Each extractor performs multi-step page fetches with host-specific referer/UA/cookies, JSoup HTML parsing, and media-link extraction using CloudStream-only primitives (`app.get`, `document`, `newExtractorLink`). That Kotlin/Android-dependent pipeline is not ported; no direct, keyless media URL endpoint was validated this session. Fixture playback is clearly labeled in the API response (`provider.resolution=local_fixture`, `resolution.status=fixture_fallback`, note text) and shown in the player.

## Remaining work

1. Port the first permitted extractor path from `CineStreamExtractors.kt` (single host, validate a real media URL end-to-end), then flip `supportsStreamResolution`.
2. Optional: per-endpoint search timeouts after collecting more latency data; browser-level UI QA.
