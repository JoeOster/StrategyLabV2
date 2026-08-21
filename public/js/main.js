import { initializeWatchlistModule, reloadWatchlistView, openAddTickerDialog } from "./modules/watchlist/index.js";
import { initializeSettingsModule, refreshSettingsView } from "./modules/settings/index.js";
import { initializeOrdersModule, reloadOrdersView, openOrderDialog } from "./modules/orders/index.js";
import { initializeDashboardModule, reloadDashboardView } from "./modules/dashboard/index.js";
import { initializeJournalModule, reloadJournalView } from "./modules/journal/index.js";
import { initializePaperTradeModule, reloadPaperTradeView } from "./modules/papertrade/index.js";
import { initializeAlertsModule } from "./modules/alerts/index.js";
import { initPlansUi } from "./modules/plans/dialog.js";
import { initializeNotificationsModule, reloadNotificationsView } from "./modules/notifications/index.js";

document.addEventListener("DOMContentLoaded", async () => {
  try {
    initPlansUi(); // shared by Orders and Paper Trade -- one dialog, both tabs
    await initializeDashboardModule();
    await initializeWatchlistModule();
    await initializeOrdersModule();
    await initializeJournalModule();
    await initializePaperTradeModule();
    await initializeAlertsModule();
    // Deciding on an alert can record a sale, so the position views need to
    // reload behind it.
    await initializeNotificationsModule({
      onChange: () => Promise.all([reloadOrdersView(), reloadPaperTradeView(), reloadDashboardView()]),
    });
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
    setupGlobalAddMenu();
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
    notifications: document.getElementById("view-notifications"),
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
      else if (target === "notifications") await reloadNotificationsView();
      else await reloadWatchlistView();
    });
  }
}


// The header's add control is global -- it works on every view, unlike
// #watchlist-actions which main.js hides off the Watchlist. Each item defers to
// the owning module's own opener so there is one code path per dialog.
function setupGlobalAddMenu() {
  const wrap = document.getElementById("global-add");
  const btn = document.getElementById("global-add-btn");
  const menu = document.getElementById("global-add-menu");
  if (!wrap || !btn || !menu) return;

  const close = () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  };

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) open();
    else close();
  });

  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-add]");
    if (!item) return;
    close();
    if (item.dataset.add === "watchlist") openAddTickerDialog();
    else openOrderDialog();
  });

  // Without these the menu strands itself open when you click elsewhere.
  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
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
