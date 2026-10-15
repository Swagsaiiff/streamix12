import { useState, useRef, useEffect } from "react";

const PRESETS = [
  {
    name: "Mux Multi-Bitrate (CORS HLS)",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    type: "hls",
    description: "Adaptive HTTP Live Streaming (.m3u8) with multiple quality levels handled via hls.js."
  },
  {
    name: "Big Buck Bunny (CORS MP4)",
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    type: "mp4",
    description: "Standard CORS-accessible MP4 stream playing directly in native browser video element."
  }
];

export default function DirectStreamModal({ onClose, onPlay }) {
  const [url, setUrl] = useState("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
  const [title, setTitle] = useState("Mux Multi-Bitrate HLS");
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
      <div className="modal-container" onClick={(e) => e.stopPropagation()} ref={modalRef} style={{ maxWidth: "560px" }}>
        <div className="modal-header">
          <h2 id="direct-modal-title" style={{ fontSize: "1.3rem", fontWeight: "700" }}>
            Direct Media Playback
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>

        <div className="modal-body" style={{ padding: "1.25rem 1.5rem" }}>
          <p style={{ color: "#94a3b8", fontSize: "0.9rem", marginBottom: "1.2rem", lineHeight: "1.5" }}>
            Play any direct stream URL (HLS <code>.m3u8</code>, DASH <code>.mpd</code>, or MP4) directly in the STREAMIX player.
          </p>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#e2e8f0", marginBottom: "0.5rem" }}>
              Sample Streams:
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {PRESETS.map((p, idx) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => handleSelectPreset(idx)}
                  style={{
                    textAlign: "left",
                    padding: "0.6rem 0.85rem",
                    background: selectedPreset === idx ? "rgba(229, 9, 20, 0.18)" : "rgba(255, 255, 255, 0.05)",
                    border: selectedPreset === idx ? "1px solid #e50914" : "1px solid rgba(255, 255, 255, 0.1)",
                    borderRadius: "6px",
                    color: "#fff",
                    cursor: "pointer",
                    transition: "all 0.15s ease"
                  }}
                >
                  <div style={{ fontWeight: "600", fontSize: "0.85rem" }}>{p.name}</div>
                  <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "0.2rem" }}>{p.description}</div>
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: "1rem" }}>
              <label htmlFor="stream-title-input" style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#e2e8f0", marginBottom: "0.35rem" }}>
                Title:
              </label>
              <input
                id="stream-title-input"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Mux Multi-Bitrate HLS"
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
              <label htmlFor="stream-url-input" style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#e2e8f0", marginBottom: "0.35rem" }}>
                Stream URL:
              </label>
              <input
                id="stream-url-input"
                type="text"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setSelectedPreset(-1);
                }}
                placeholder="https://..."
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
