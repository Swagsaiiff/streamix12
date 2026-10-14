import { useState, useRef, useEffect } from "react";

const PRESETS = [
  {
    name: "Sample Clip (Dual-Audio MKV)",
    url: "/fixtures/multi-audio-test.mkv",
    type: "mkv",
    description: "Multi-audio Matroska clip (English + Spanish AAC). Remuxed to FastStart MP4 in browser with track switching."
  },
  {
    name: "Big Buck Bunny (CORS MP4)",
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    type: "mp4",
    description: "Standard CORS-accessible MP4 stream playing directly in native browser video element."
  },
  {
    name: "Mux Multi-Bitrate (CORS HLS)",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    type: "hls",
    description: "Adaptive HTTP Live Streaming (.m3u8) with multiple quality levels handled via hls.js."
  }
];

export default function DirectStreamModal({ onClose, onPlay }) {
  const [url, setUrl] = useState("/fixtures/multi-audio-test.mkv");
  const [title, setTitle] = useState("Dual-Audio MKV Sample");
  const [selectedPreset, setSelectedPreset] = useState(0);
  const modalRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSelectPreset = (index) => {
    setSelectedPreset(index);
    const p = PRESETS[index];
    setUrl(p.url);
    setTitle(p.name);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const targetUrl = url.trim();
    if (!targetUrl) return;
    onClose();
    onPlay({
      title: title || "Direct Media Stream",
      streamUrl: targetUrl,
      provider: "Direct",
      type: "movie",
      id: "direct-stream"
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="direct-modal-title">
      <div className="modal" style={{ maxWidth: "600px" }} onClick={(e) => e.stopPropagation()} ref={modalRef}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        <div style={{ padding: "1.75rem 2rem" }}>
          <h2 id="direct-modal-title" style={{ fontSize: "1.5rem", fontWeight: "700", marginBottom: "0.5rem" }}>
            Browser Direct Playback
          </h2>
          <p style={{ color: "#9ca3af", fontSize: "0.9rem", lineHeight: "1.4", marginBottom: "1.25rem" }}>
            Play browser-accessible media directly in the production player without contacting the backend server.
          </p>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#e5e7eb", marginBottom: "0.5rem" }}>
              Quick Presets
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {PRESETS.map((p, idx) => (
                <button
                  key={p.url}
                  type="button"
                  onClick={() => handleSelectPreset(idx)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "0.25rem",
                    padding: "0.6rem 0.85rem",
                    background: selectedPreset === idx ? "rgba(229, 9, 20, 0.15)" : "rgba(255, 255, 255, 0.05)",
                    border: selectedPreset === idx ? "1px solid #e50914" : "1px solid rgba(255, 255, 255, 0.1)",
                    borderRadius: "6px",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "#fff"
                  }}
                >
                  <span style={{ fontWeight: "600", fontSize: "0.85rem", color: selectedPreset === idx ? "#f87171" : "#e5e7eb" }}>
                    {p.name}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>{p.description}</span>
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: "1rem" }}>
              <label htmlFor="direct-title-input" style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#e5e7eb", marginBottom: "0.4rem" }}>
                Title
              </label>
              <input
                id="direct-title-input"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.55rem 0.75rem",
                  background: "rgba(16, 18, 23, 0.9)",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  borderRadius: "6px",
                  color: "#fff",
                  fontSize: "0.9rem"
                }}
              />
            </div>

            <div style={{ marginBottom: "1.25rem" }}>
              <label htmlFor="direct-url-input" style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#e5e7eb", marginBottom: "0.4rem" }}>
                Media URL (MP4, WebM, HLS, DASH, or MKV)
              </label>
              <input
                id="direct-url-input"
                type="text"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setSelectedPreset(-1);
                }}
                placeholder="https://... or /fixtures/..."
                style={{
                  width: "100%",
                  padding: "0.55rem 0.75rem",
                  background: "rgba(16, 18, 23, 0.9)",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  borderRadius: "6px",
                  color: "#fff",
                  fontSize: "0.9rem"
                }}
              />
            </div>

            <div style={{ padding: "0.75rem", background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.25)", borderRadius: "6px", fontSize: "0.8rem", color: "#a7f3d0", marginBottom: "1.25rem", lineHeight: "1.4" }}>
              <strong>Execution Boundary:</strong> Direct playback executes completely in your browser. Media hosts must provide CORS headers (<code>Access-Control-Allow-Origin: *</code>). Protected providers (VegaMovies scraping) require the backend server.
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-play" disabled={!url.trim()}>
                Play in STREAMIX
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
