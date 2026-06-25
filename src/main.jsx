import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <main className="page">
          <section className="shell">
            <article className="card card--danger">
              <span className="eyebrow">Error de arranque</span>
              <h1>RC Wallet no pudo abrir correctamente</h1>
              <p className="warning">
                Actualiza la página. Si sigue pasando, borra el cache de la PWA o abre una ventana privada.
              </p>
              <code className="address">
                {this.state.error instanceof Error ? this.state.error.message : "Error desconocido"}
              </code>
            </article>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[PWA]", error);
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
