import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { UiStateProvider } from "./hooks/useUiState";
/* ── Foundation & shared styles ── */
import "./styles/_reset.css";
import "./styles/_layout.css";
import "./styles/_form-fields.css";
import "./styles/_scrollbar-tooltips.css";

/* ── Component styles ── */
import "./styles/components/_upload-panel.css";
import "./styles/components/_pipeline-progress.css";
import "./styles/components/_transcript-panel.css";
import "./styles/components/_notifications.css";
import "./styles/components/_status-bar.css";

/* ── Panel styles ── */
import "./styles/components/_dev-panel.css";
import "./styles/components/_config-panel.css";
import "./styles/components/_history-results.css";
import "./styles/components/_server-status-banner.css";
import "./styles/components/_about-panel.css";
import "./styles/components/_appearance-panel.css";
import "./styles/components/_speaker-label-modal.css";
import "./styles/components/_delivery-config.css";
import "./styles/components/_dev-panel-testing.css";
import "./styles/components/_loading-modal.css";
import "./styles/components/_tooltip.css";
import "./styles/components/_rich-text-editor.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UiStateProvider>
      <App />
    </UiStateProvider>
  </React.StrictMode>,
);
