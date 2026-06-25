import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

function showStartupError(error) {
  const root = document.getElementById("root");
  if (!root) return;

  const message = error instanceof Error ? error.message : String(error ?? "Error desconocido");
  root.innerHTML = `
    <main class="page">
      <section class="shell">
        <article class="card card--danger">
          <span class="eyebrow">Error de arranque</span>
          <h1>RC Wallet no pudo abrir correctamente</h1>
          <p class="warning">
            Actualiza la página. Si sigue pasando, borra el cache de la PWA o abre una ventana privada.
          </p>
          <code class="address"></code>
        </article>
      </section>
    </main>
  `;
  root.querySelector("code")?.append(document.createTextNode(message));
}

window.addEventListener("error", (event) => {
  showStartupError(event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showStartupError(event.reason);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[PWA]", error);
    });
  });
}

try {
  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
} catch (error) {
  showStartupError(error);
}
