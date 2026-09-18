import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Simple from "./Simple.jsx";
import { LangProvider } from "./lib/i18n.js";
// The language sits above the page so the page itself can read it: it is chosen once per device
// (or from the browser) and every string, the <html lang> included, follows it.
createRoot(document.getElementById("root")).render(<StrictMode><LangProvider><Simple /></LangProvider></StrictMode>);
