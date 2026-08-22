// The "HTML" file for the dashboard. Pure functions: data in, markup out.
// Includes a hand-rolled inline SVG sparkline -- no chart library, so there's
// no CDN dependency and nothing to keep in sync.

import { money, signedMoney, formatQty } from "../shared/format.js";

export const TABLE_COLUMNS = [
  { key: "symbol", label: "Ticker" },
  { key: "exchange_code", label: "Exch" },
  { key: "quantity_remaining", label: "Qty" },
  { key: "cost_per_share", label: "Entry" },
  { key: "last_price", label: "Price" },
  { key: "market_value", label: "Value" },
  { key: "unrealized_pnl", label: "Unreal. P/L" },
  { key: "unrealized_pnl_percent", label: "%" },
  { key: "days_held", label: "Held" },
];

export function renderCards(positions) {
  if (positions.length === 0) {
    return `<p class="empty-row">No open positions. Log a purchase from the Orders tab to see it here.</p>`;
  }
  return positions
    .map((p) => {
      const up = p.unrealized_pnl != null && p.unrealized_pnl >= 0;
      const pnlClass = p.unrealized_pnl == null ? "" : up ? "change-up" : "change-down";
      return `
        <button type="button" class="position-card ${pnlClass ? (up ? "card-up" : "card-down") : ""}" data-symbol="${escapeHtml(p.symbol)}">
          <div class="card-head">
            <div class="card-ticker">
              <strong>${escapeHtml(p.symbol)}</strong>
              <span class="card-exchange">${escapeHtml(p.exchange_code || "—")}</span>
            </div>
            <div class="card-price">${money(p.last_price)}</div>
          </div>
          <div class="card-name">${escapeHtml(p.security_name || "")}</div>
          <div class="card-stats">
            <div><span class="stat-label">Qty</span><span>${formatQty(p.quantity_remaining)}</span></div>
            <div><span class="stat-label">Entry</span><span>${money(p.cost_per_share)}</span></div>
            <div><span class="stat-label">Value</span><span>${money(p.market_value)}</span></div>
            <div><span class="stat-label">Held</span><span>${p.days_held == null ? "—" : `${p.days_held}d`}</span></div>
          </div>
          <div class="card-pnl ${pnlClass}">
            ${signedMoney(p.unrealized_pnl)}
            ${p.unrealized_pnl_percent == null ? "" : `<span class="card-pnl-pct">${p.unrealized_pnl_percent >= 0 ? "+" : ""}${p.unrealized_pnl_percent.toFixed(2)}%</span>`}
          </div>
        </button>`;
    })
    .join("");
}

export function renderTableHead(sortKey, sortDir) {
  return TABLE_COLUMNS.map((col) => {
    const active = col.key === sortKey;
    const arrow = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="sortable${active ? " sorted" : ""}" data-sort-key="${col.key}">${escapeHtml(col.label)}${arrow}</th>`;
  }).join("");
}

export function renderTableRows(positions) {
  if (positions.length === 0) {
    return `<tr><td colspan="${TABLE_COLUMNS.length}" class="empty-row">No open positions.</td></tr>`;
  }
  return positions
    .map((p) => {
      const pnlClass = p.unrealized_pnl == null ? "" : p.unrealized_pnl >= 0 ? "change-up" : "change-down";
      return `
        <tr class="clickable-row" data-symbol="${escapeHtml(p.symbol)}">
          <td><strong>${escapeHtml(p.symbol)}</strong></td>
          <td>${escapeHtml(p.exchange_code || "—")}</td>
          <td>${formatQty(p.quantity_remaining)}</td>
          <td>${money(p.cost_per_share)}</td>
          <td>${money(p.last_price)}</td>
          <td>${money(p.market_value)}</td>
          <td class="${pnlClass}">${signedMoney(p.unrealized_pnl)}</td>
          <td class="${pnlClass}">${p.unrealized_pnl_percent == null ? "—" : `${p.unrealized_pnl_percent >= 0 ? "+" : ""}${p.unrealized_pnl_percent.toFixed(2)}%`}</td>
          <td>${p.days_held == null ? "—" : `${p.days_held}d`}</td>
        </tr>`;
    })
    .join("");
}

export function renderExchangeOptions(positions) {
  const codes = [...new Set(positions.map((p) => p.exchange_code).filter(Boolean))].sort();
  return (
    `<option value="">All exchanges</option>` +
    codes.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")
  );
}

// --- Detail panel -----------------------------------------------------------

export function renderTickerDetail(d) {
  const q = d.quote;
  const changeClass = q.change == null ? "" : q.change >= 0 ? "change-up" : "change-down";
  const pos = d.position;
  const posClass = pos.unrealized_pnl == null ? "" : pos.unrealized_pnl >= 0 ? "change-up" : "change-down";

  return `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(d.security.symbol)} <span class="detail-name">${escapeHtml(d.security.name || "")}</span></h2>
        <div class="detail-meta">
          ${escapeHtml(d.security.exchange_code || "—")}
          ${d.security.sector ? ` · ${escapeHtml(d.security.sector)}` : ""}
          ${d.security.industry ? ` · ${escapeHtml(d.security.industry)}` : ""}
        </div>
      </div>
      <div class="detail-price">
        <div class="detail-last">${money(q.last_price)}</div>
        <div class="${changeClass}">${q.change == null ? "" : `${signedMoney(q.change)} (${q.change_percent >= 0 ? "+" : ""}${q.change_percent.toFixed(2)}%)`}</div>
      </div>
    </div>

    ${renderSparkline(d.series)}

    <div class="detail-grid">
      <div><span class="stat-label">Open</span><span>${money(q.open_price)}</span></div>
      <div><span class="stat-label">Prev close</span><span>${money(q.prev_close)}</span></div>
      <div><span class="stat-label">Day range</span><span>${money(q.day_low)} – ${money(q.day_high)}</span></div>
      <div><span class="stat-label">Volume</span><span>${q.volume == null ? "—" : Number(q.volume).toLocaleString()}</span></div>
      <div><span class="stat-label">52w range</span><span>${money(d.range.low_52w)} – ${money(d.range.high_52w)}</span></div>
      <div><span class="stat-label">52w position</span><span>${d.range.position_percent == null ? "—" : `${d.range.position_percent.toFixed(0)}%`}</span></div>
    </div>
    ${renderRangeBar(d.range)}

    <h3>Your position</h3>
    ${
      pos.total_shares > 0
        ? `<div class="detail-grid">
             <div><span class="stat-label">Shares</span><span>${formatQty(pos.total_shares)}</span></div>
             <div><span class="stat-label">Cost basis</span><span>${money(pos.total_cost)}</span></div>
             <div><span class="stat-label">Market value</span><span>${money(pos.total_value)}</span></div>
             <div><span class="stat-label">Unrealized</span><span class="${posClass}">${signedMoney(pos.unrealized_pnl)}${pos.unrealized_pnl_percent == null ? "" : ` (${pos.unrealized_pnl_percent >= 0 ? "+" : ""}${pos.unrealized_pnl_percent.toFixed(2)}%)`}</span></div>
           </div>
           <table class="items-table detail-table">
             <thead><tr><th>Lot date</th><th>Qty</th><th>Entry</th><th>Value</th><th>P/L</th><th>Source</th></tr></thead>
             <tbody>${pos.lots
               .map(
                 (l) => `<tr>
                   <td>${escapeHtml(l.transaction_date)}</td>
                   <td>${formatQty(l.quantity_remaining)}</td>
                   <td>${money(l.cost_per_share)}</td>
                   <td>${money(l.market_value)}</td>
                   <td class="${l.unrealized_pnl == null ? "" : l.unrealized_pnl >= 0 ? "change-up" : "change-down"}">${signedMoney(l.unrealized_pnl)}</td>
                   <td>${escapeHtml(l.source_name || "—")}</td>
                 </tr>`,
               )
               .join("")}</tbody>
           </table>`
        : `<p class="panel-hint">You don't currently hold this ticker.</p>`
    }

    ${
      d.watchedItems.length > 0
        ? `<h3>On your watchlists</h3>
           <ul class="detail-list">${d.watchedItems
             .map(
               (w) =>
                 `<li>${escapeHtml(w.watchlist_name)}: ${escapeHtml(w.order_type)} ${
                   w.order_type === "BUY_LIMIT" && w.buy_price_high != null
                     ? `at ${money(w.buy_price_high)}`
                     : w.order_type === "SELL_LIMIT" && w.take_profit_low != null
                       ? `at ${money(w.take_profit_low)}`
                       : ""
                 } <span class="status-pill">${escapeHtml(w.status)}</span></li>`,
             )
             .join("")}</ul>`
        : ""
    }

    ${
      d.trades.length > 0
        ? `<h3>Trade history</h3>
           <table class="items-table detail-table">
             <thead><tr><th>Date</th><th>Type</th><th>Qty</th><th>Price</th><th>Realized P/L</th></tr></thead>
             <tbody>${d.trades
               .map(
                 (t) => `<tr>
                   <td>${escapeHtml(t.transaction_date)}</td>
                   <td><span class="type-pill type-txn-${t.transaction_type.toLowerCase()}">${escapeHtml(t.transaction_type)}</span></td>
                   <td>${t.transaction_type === "DIVIDEND" ? "—" : formatQty(t.quantity)}</td>
                   <td>${money(t.price)}</td>
                   <td class="${t.realized_pnl == null ? "" : t.realized_pnl >= 0 ? "change-up" : "change-down"}">${signedMoney(t.realized_pnl)}</td>
                 </tr>`,
               )
               .join("")}</tbody>
           </table>`
        : ""
    }

    ${
      d.dividends.length > 0
        ? `<h3>Recent dividends</h3>
           <ul class="detail-list">${d.dividends
             .map((div) => `<li>${escapeHtml(div.ex_date)}: ${money(div.amount)}</li>`)
             .join("")}</ul>`
        : ""
    }

    ${
      d.security.description
        ? `<h3>About</h3><p class="detail-description">${escapeHtml(d.security.description)}</p>`
        : ""
    }

    <p class="panel-hint">
      Price data as of ${escapeHtml(d.quote.fetched_at || "unknown")}.
      ${d.range.bar_count} daily bars stored${d.range.last_date ? ` through ${escapeHtml(d.range.last_date)}` : ""}.
    </p>`;
}

/**
 * Inline SVG line chart. Deliberately dependency-free: a charting library
 * would mean a CDN load for what amounts to ~20 lines of coordinate math.
 */
export function renderSparkline(series, { width = 620, height = 120 } = {}) {
  if (!series || series.length < 2) {
    return `<p class="panel-hint">Not enough price history stored to chart yet — click "Refresh Data" below to fetch it for this ticker.</p>`;
  }
  const closes = series.map((s) => s.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1; // flat series would divide by zero
  const stepX = width / (series.length - 1);

  const points = closes.map((c, i) => {
    const x = i * stepX;
    const y = height - ((c - min) / span) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const rising = closes[closes.length - 1] >= closes[0];
  const stroke = rising ? "#15803d" : "#b91c1c";
  const fill = rising ? "rgba(21,128,61,0.08)" : "rgba(185,28,28,0.08)";

  return `
    <div class="sparkline-wrap">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="sparkline" role="img"
           aria-label="Price history from ${escapeHtml(series[0].date)} to ${escapeHtml(series[series.length - 1].date)}">
        <polygon points="0,${height} ${points.join(" ")} ${width},${height}" fill="${fill}" />
        <polyline points="${points.join(" ")}" fill="none" stroke="${stroke}" stroke-width="2" />
      </svg>
      <div class="sparkline-axis">
        <span>${escapeHtml(series[0].date)}</span>
        <span>${money(min)} – ${money(max)}</span>
        <span>${escapeHtml(series[series.length - 1].date)}</span>
      </div>
    </div>`;
}

function renderRangeBar(range) {
  if (range.position_percent == null) return "";
  return `
    <div class="range-bar" title="Where today's price sits in the 52-week range">
      <div class="range-fill" style="width:${Math.max(0, Math.min(100, range.position_percent)).toFixed(1)}%"></div>
    </div>`;
}

// --- shared sort/filter -----------------------------------------------------

export function sortPositions(positions, key, dir) {
  const mult = dir === "asc" ? 1 : -1;
  return [...positions].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last regardless of direction
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mult;
    return String(av).localeCompare(String(bv)) * mult;
  });
}

export function filterPositions(positions, query, exchange) {
  let result = positions;
  if (exchange) result = result.filter((p) => p.exchange_code === exchange);
  const q = (query || "").trim().toLowerCase();
  if (!q) return result;
  return result.filter(
    (p) => p.symbol.toLowerCase().includes(q) || (p.security_name || "").toLowerCase().includes(q),
  );
}

// --- formatting -------------------------------------------------------------




function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * Is this a URL a browser should be allowed to follow from a news item?
 *
 * Exported and separate from the renderer because it is the only part of the
 * news panel that is a DECISION rather than structure. The rest of the panel's
 * safety is structural -- it builds nodes and sets textContent, which cannot
 * be talked into parsing markup no matter what a headline contains -- and a
 * test for that against a faked DOM would only be testing the fake.
 *
 * This, by contrast, can genuinely be got wrong, and getting it wrong turns a
 * headline into a click-to-run script.
 */
export function isSafeNewsUrl(url) {
  if (typeof url !== "string") return false;
  // Parsed rather than pattern-matched. "java	script:alert(1)" and
  // " javascript:alert(1)" both defeat a naive prefix check and both are
  // resolved correctly here.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Recent headlines for a ticker.
 *
 * Every string here comes from a third party and none of it is trusted. The
 * headline, source and summary go in as TEXT, and the link is built as a real
 * anchor whose href is checked to be http(s) first -- a `javascript:` URL in a
 * news feed would otherwise become a click-to-run script in this page. That is
 * not paranoia about Finnhub specifically; it is that this is the first place
 * in the app where somebody else's content is rendered at all.
 */
export function renderTickerNews(payload) {
  const wrap = document.createElement("div");
  wrap.className = "ticker-news";

  const h = document.createElement("h4");
  h.textContent = "Recent headlines";
  wrap.append(h);

  if (payload?.error) {
    const p = document.createElement("p");
    p.className = "panel-hint";
    p.textContent = `Headlines unavailable: ${payload.error}`;
    wrap.append(p);
    return wrap;
  }

  const items = payload?.news ?? [];
  if (items.length === 0) {
    const p = document.createElement("p");
    p.className = "panel-hint";
    p.textContent = "No headlines in the last 14 days.";
    wrap.append(p);
    return wrap;
  }

  const list = document.createElement("ul");
  list.className = "news-list";
  for (const n of items) {
    const li = document.createElement("li");

    const date = document.createElement("span");
    date.className = "news-date";
    date.textContent = String(n.datetime).slice(0, 10);

    // An anchor only when the URL is one a browser should follow. Anything
    // else degrades to plain text rather than being dropped -- the headline is
    // still worth reading even if its link is unusable.
    let title;
    if (isSafeNewsUrl(n.url)) {
      title = document.createElement("a");
      title.href = n.url;
      title.target = "_blank";
      // noopener: the opened page gets no handle back to this one.
      title.rel = "noopener noreferrer";
    } else {
      title = document.createElement("span");
    }
    title.textContent = n.headline;

    const src = document.createElement("span");
    src.className = "news-source";
    src.textContent = n.source;

    li.append(date, title, src);
    list.append(li);
  }
  wrap.append(list);

  const note = document.createElement("p");
  note.className = "panel-hint";
  note.textContent = payload.cached
    ? `Headlines from Finnhub, cached — fetched ${String(payload.fetchedAt).slice(0, 16).replace("T", " ")}.`
    : "Headlines from Finnhub. Dates and sources only — nothing here has been read against your position.";
  wrap.append(note);

  return wrap;
}
