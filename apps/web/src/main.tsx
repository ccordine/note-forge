import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LabProvider } from "./state/LabContext";
import { AudioInputProvider } from "./audio/use-audio-input";
import "./styles.css";
import "./styles-scale.css";
import "./styles-hum.css";
import "./styles-range-simulator.css";
import "./styles-range-loop.css";
import "./styles-arcade.css";
import "./styles-pitch-maze.css";
import "./styles-resonance.css";
import "./styles-voice-draw.css";
import "./styles-input.css";
import "./styles-components.css";
import "./styles-responsive.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("NoteForge requires a #root mount element.");

createRoot(rootElement).render(
  <StrictMode><AudioInputProvider><LabProvider><App /></LabProvider></AudioInputProvider></StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch((error) => console.warn("NoteForge offline update check failed.", error));
  });
}
