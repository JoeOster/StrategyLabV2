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

/** Paper Trade's positions table always shows the Promote action. */
export function renderPositionsRows(positions, columns) {
  return renderOrdersPositionsRows(positions, columns, {
    showPromote: true,
    emptyMessage: 'No open paper positions. Use "+ Log Paper Trade" to start one.',
  });
}
