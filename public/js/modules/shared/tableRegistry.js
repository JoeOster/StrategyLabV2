// Single source of truth for "which sortable tables exist and where their
// column preferences live." Settings' "Table Columns" panel reads this list
// to build itself generically -- adding a future table (Imports, Journal)
// means adding one entry here, not writing new Settings UI code.
//
// Storage keys are defined here (not inside each module's own index.js) so
// there's exactly one place that owns the localStorage key string for a
// given table -- Settings and the table's own "⚙ Columns" button must agree
// on it, and a typo'd duplicate key here would be caught by node --check
// failing to find the import, rather than silently drifting apart at runtime.
import { ALL_COLUMNS as WATCHLIST_COLUMNS } from "../watchlist/render.js";
import { POSITION_COLUMNS, HISTORY_COLUMNS } from "../orders/render.js";

export const COLUMN_STORAGE_KEYS = {
  watchlist: "sl_columns_watchlist",
  ordersPositions: "sl_columns_orders_positions",
  ordersHistory: "sl_columns_orders_history",
  paperPositions: "sl_columns_paper_positions",
  paperHistory: "sl_columns_paper_history",
};

/**
 * @typedef {object} TableRegistryEntry
 * @property {string} id
 * @property {string} label displayed in the Table Columns settings panel
 * @property {Array<{key: string, label: string, default?: boolean}>} columns
 * @property {string} storageKey
 */

/** @type {TableRegistryEntry[]} */
export const TABLE_REGISTRY = [
  {
    id: "watchlist",
    label: "Watchlist",
    columns: WATCHLIST_COLUMNS,
    storageKey: COLUMN_STORAGE_KEYS.watchlist,
  },
  {
    id: "ordersPositions",
    label: "Orders — Open Positions",
    columns: POSITION_COLUMNS,
    storageKey: COLUMN_STORAGE_KEYS.ordersPositions,
  },
  {
    id: "ordersHistory",
    label: "Orders — Transaction History",
    columns: HISTORY_COLUMNS,
    storageKey: COLUMN_STORAGE_KEYS.ordersHistory,
  },
  {
    // Paper Trade reuses Orders' own column arrays (same shape of data --
    // lots, positions, strategy_title and all) but gets its own storage key
    // so a user can customize the two tables' visible columns independently.
    id: "paperPositions",
    label: "Paper Trade — Open Positions",
    columns: POSITION_COLUMNS,
    storageKey: COLUMN_STORAGE_KEYS.paperPositions,
  },
  {
    id: "paperHistory",
    label: "Paper Trade — Transaction History",
    columns: HISTORY_COLUMNS,
    storageKey: COLUMN_STORAGE_KEYS.paperHistory,
  },
];
