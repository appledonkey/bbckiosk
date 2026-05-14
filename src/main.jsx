import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import storage from "./storage.js";
import App from "./App.jsx";

window.storage = storage;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
