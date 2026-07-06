import React from "react";
import ReactDOM from "react-dom/client";
import { MiniKitProvider } from "@worldcoin/minikit-js/minikit-provider";
import App from "./App.jsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <MiniKitProvider>
    <App />
  </MiniKitProvider>,
);
