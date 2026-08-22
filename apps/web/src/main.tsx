import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LabProvider } from "./state/LabContext";
import "./styles.css";
import "./styles-scale.css";
import "./styles-hum.css";
import "./styles-input.css";
import "./styles-responsive.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><LabProvider><App /></LabProvider></StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}
