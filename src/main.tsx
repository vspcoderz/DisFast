import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSpoilers } from "./markdown";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

initSpoilers();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary label="DisFast hit an error">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
