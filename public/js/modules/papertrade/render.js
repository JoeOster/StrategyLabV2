// The "Renderer" for the Paper Trade tab. Deliberately thin -- Paper Trade
// shows the exact same shape of data as Orders (lots, positions, history),
// so almost everything here just re-exports Orders' own pure functions
// rather than duplicating them. The one addition is a Promote button on
// each position row, which orders/render.js supports behind an opt-in flag.
export {
  POSITION_COLUMNS,
  HISTORY_COLUMNS,
  renderHeaderRow,
  renderHistoryRows,
  renderSummary,
  renderSourceOptions,
  renderLotOptions,
  sortRows,
  filterPositions,
} from "../orders/render.js";

import { renderPositionsRows as renderOrdersPositionsRows } from "../orders/render.js";
import { renderStrategyOptions } from "../journal/render.js";

export { renderStrategyOptions };

/**
 * Paper Trade's positions table always shows the Promote action.
 *
 * Everything else is passed straight through. This previously took only
 * (positions, columns) and built its own options object, which silently
 * dropped `expanded` -- so multi-lot tickers rendered a group row with a
 * disclosure caret that no state backed and no handler answered. The lots
 * behind it were unreachable from this tab. A wrapper that discards its
 * caller's options is a trap the next option will fall into as well, so it
 * forwards them and overrides only what is genuinely fixed here.
 */
export function renderPositionsRows(positions, columns, opts = {}) {
  return renderOrdersPositionsRows(positions, columns, {
    emptyMessage: 'No open paper positions. Use "+ Log Paper Trade" to start one.',
    ...opts,
    showPromote: true,
  });
}

export { renderPositionsFooter } from "../orders/render.js";
