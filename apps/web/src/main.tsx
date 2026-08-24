import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { App } from "./App";
import { MusicalProvider } from "./state/MusicalContext";
import { UserPreferencesProvider } from "./state/UserPreferencesContext";
import { AudioInputProvider } from "./audio/use-audio-input";
import "./styles.css";
import "./styles-responsive.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("NoteForge requires a #root mount element.");

createRoot(rootElement).render(
  <StrictMode><HashRouter><AudioInputProvider><MusicalProvider><UserPreferencesProvider><App /></UserPreferencesProvider></MusicalProvider></AudioInputProvider></HashRouter></StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch((error) => console.warn("NoteForge offline update check failed.", error));
  });
}
