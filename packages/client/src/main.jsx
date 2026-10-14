import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import ClientPlaybackPoc from "./poc/ClientPlaybackPoc.jsx";
import "./index.css";

// The experimental client-side playback PoC lives on its own route and is the only page that
// uses the browser-only pipeline. Every other path renders the untouched production app.
const isPocRoute = window.location.pathname.replace(/\/+$/, "") === "/poc/client-playback";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isPocRoute ? <ClientPlaybackPoc /> : <App />}
  </React.StrictMode>
);
