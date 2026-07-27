# Bugs — all three FIXED 2026-07-25

Kept for the record. Nothing below is outstanding; see `STATUS.md` for
current state.

---

## 1. No way to delete from the Orders tab

**Reported:** "On the orders tab, there is no way to delete; you mentioned a
history, and I don't necessarily see where that might be."

Delete currently only exists as a ✕ on rows in the **History** sub-tab
(the tab sits next to "Open Positions" at the top of the Orders view). It is
not reachable at all from Open Positions, which is where you'd naturally look
after entering a bad order.

**Fix:** put a **Delete** button inside the Edit dialog, so it's reachable
from anywhere a transaction can be edited — Open Positions and History both.
Keep the confirm step; deleting a SELL restores shares to its lot, and
deleting an already-sold BUY is refused.

Also worth reconsidering: History being a sub-tab makes it easy to miss. It
may deserve a more obvious label or to be surfaced differently.

---

## 2. Watchlist: add a 10-day sparkline column

**Requested:** a small graph of the last ten days showing **$ change**, sized
to about **90% of the current row height**.

Data is already stored — `historical_prices` has daily bars, and the
Dashboard's detail dialog already renders a dependency-free inline SVG
sparkline (`public/js/modules/dashboard/render.js`, `renderSparkline`). That
function can be adapted rather than written fresh.

Notes for implementation:
- Plot **$ change**, not absolute price — so the baseline is the 10-day-ago
  close and the line shows movement from there.
- Needs the last 10 bars per watched security added to the watchlist list
  query (the current query returns only `history_days` / `history_latest`
  counts, not the series).
- Colour green/red by net direction, matching the existing convention.

---

## 3. (Spotted, not reported) Header buttons show on the wrong tabs

In the screenshot, the header still shows **Refresh History / Refresh Prices /
+ Add Ticker** while the **Orders** tab is active. Those are watchlist-only
actions.

Cause: `main.js` hides them in the view-switch click handler
(`watchlistActions.hidden = target !== "watchlist"`), but never sets the
initial state on page load — and the default view is now Dashboard, not
Watchlist. So they're visible until the first tab click.

**Fix:** set the initial visibility during `setupViewSwitching()` rather than
only on click.

Related: the Orders tab now has two "Refresh Prices" buttons — one in the
header (which shouldn't be there) and one in the panel. Fixing the above
removes the duplicate.
