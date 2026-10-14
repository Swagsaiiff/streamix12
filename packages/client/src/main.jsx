import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import ClientPlaybackPoc from "./poc/ClientPlaybackPoc.jsx";
import "./index.css";

// Production STREAMIX application integrates client-side-first playback directly into Player.jsx.
// The /poc/client-playback route remains available as a standalone diagnostic and testing workbench.
const isPocRoute = window.location.pathname.replace(/\/+$/, "") === "/poc/client-playback";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isPocRoute ? <ClientPlaybackPoc /> : <App />}
  </React.StrictMode>
);
