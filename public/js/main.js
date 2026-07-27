import { initializeWatchlistModule, reloadWatchlistView } from "./modules/watchlist/index.js";
import { initializeSettingsModule, refreshSettingsView } from "./modules/settings/index.js";
import { initializeOrdersModule, reloadOrdersView } from "./modules/orders/index.js";
import { initializeDashboardModule, reloadDashboardView } from "./modules/dashboard/index.js";
import { initializeJournalModule, reloadJournalView } from "./modules/journal/index.js";
import { initializePaperTradeModule, reloadPaperTradeView } from "./modules/papertrade/index.js";
import { initializeAlertsModule } from "./modules/alerts/index.js";

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await initializeDashboardModule();
    await initializeWatchlistModule();
    await initializeOrdersModule();
    await initializeJournalModule();
    await initializePaperTradeModule();
    await initializeAlertsModule();
    // Settings changes (renaming a list, deleting a holder) can invalidate
    // what the other views are showing, so they reload on any change.
    await initializeSettingsModule({
      onChange: () =>
        Promise.all([
          reloadWatchlistView(),
          reloadOrdersView(),
          reloadDashboardView(),
          reloadJournalView(),
          reloadPaperTradeView(),
        ]),
    });
    setupViewSwitching();
    await applyAppTitle();
  } catch (err) {
    console.error("Failed to initialize app:", err);
  }
});

function setupViewSwitching() {
  const buttons = [...document.querySelectorAll(".view-btn")];
  const views = {
    dashboard: document.getElementById("view-dashboard"),
    watchlist: document.getElementById("view-watchlist"),
    orders: document.getElementById("view-orders"),
    journal: document.getElementById("view-journal"),
    papertrade: document.getElementById("view-papertrade"),
    settings: document.getElementById("view-settings"),
  };
  const watchlistActions = document.getElementById("watchlist-actions");

  // Apply the starting state up front. Previously this only ran on a tab
  // click, so on first load the watchlist-only header buttons were visible
  // over whichever view was default -- which since the Dashboard was added is
  // never the Watchlist.
  const initialView =
    buttons.find((b) => b.classList.contains("active"))?.dataset.view ?? "dashboard";
  watchlistActions.hidden = initialView !== "watchlist";
  for (const [name, el] of Object.entries(views)) el.hidden = name !== initialView;

  for (const btn of buttons) {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.view;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      for (const [name, el] of Object.entries(views)) el.hidden = name !== target;
      // The Refresh/Add buttons in the header only apply to the watchlist.
      watchlistActions.hidden = target !== "watchlist";

      if (target === "settings") await refreshSettingsView();
      else if (target === "orders") await reloadOrdersView();
      else if (target === "dashboard") await reloadDashboardView();
      else if (target === "journal") await reloadJournalView();
      else if (target === "papertrade") await reloadPaperTradeView();
      else await reloadWatchlistView();
    });
  }
}

async function applyAppTitle() {
  try {
    const res = await fetch("/api/settings/general");
    if (!res.ok) return;
    const settings = await res.json();
    if (settings.app_title) {
      document.getElementById("app-title").textContent = settings.app_title;
      document.title = `${settings.app_title} — Watchlist`;
    }
  } catch {
    // Cosmetic only -- a failure here shouldn't block the app.
  }
}
