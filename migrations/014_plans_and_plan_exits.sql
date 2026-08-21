-- v13 -> v14: exit plans.
--
-- A plan is ONE ENTRY THESIS covering one or more lots, and it owns the exit
-- ladder. Exits belong here rather than on a lot (which cannot express scaling
-- into one thesis) or on a position (which merges two sources' theses into one
-- ladder and destroys the attribution the app exists for).

CREATE TABLE plans (
  id            INTEGER PRIMARY KEY,
  holder_id     INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  security_id   INTEGER NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
  source_id     INTEGER REFERENCES advice_sources(id) ON DELETE SET NULL,
  strategy_id   INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','closed','cancelled')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE plan_exits (
  id            INTEGER PRIMARY KEY,
  plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('TAKE_PROFIT','STOP')),
  sequence      INTEGER NOT NULL DEFAULT 0,
  quantity      REAL NOT NULL CHECK (quantity > 0),
  price_low     REAL,
  price_high    REAL,
  status        TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','hit','cancelled')),
  hit_at        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (price_low IS NOT NULL OR price_high IS NOT NULL)
);

ALTER TABLE transactions ADD COLUMN plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL;

-- alerts has to be REBUILT rather than altered: watched_item_id must become
-- nullable (a rung alert has no watched_item) and a table-level CHECK cannot be
-- added by ALTER. Rows are copied rather than dropped -- this migration must be
-- safe on a database that already has alert history, even though the ones it
-- ran against first happened to be empty.
CREATE TABLE alerts_v14 (
  id                INTEGER PRIMARY KEY,
  watched_item_id   INTEGER REFERENCES watched_items(id) ON DELETE CASCADE,
  plan_exit_id      INTEGER REFERENCES plan_exits(id) ON DELETE CASCADE,
  triggered_at      TEXT NOT NULL DEFAULT (datetime('now')),
  trigger_price     REAL NOT NULL,
  trigger_reason    TEXT CHECK (trigger_reason IN ('STOP','BUY','TAKE_PROFIT','TAKE_PROFIT_2')),
  message           TEXT,
  acknowledged_at   TEXT,
  CHECK ((watched_item_id IS NOT NULL) <> (plan_exit_id IS NOT NULL))
);

INSERT INTO alerts_v14 (id, watched_item_id, plan_exit_id, triggered_at,
                        trigger_price, trigger_reason, message, acknowledged_at)
  SELECT id, watched_item_id, NULL, triggered_at,
         trigger_price, trigger_reason, message, acknowledged_at
  FROM alerts;

DROP TABLE alerts;
ALTER TABLE alerts_v14 RENAME TO alerts;

CREATE INDEX idx_transactions_plan ON transactions(plan_id);
CREATE INDEX idx_plan_exits_pending ON plan_exits (plan_id) WHERE status = 'pending';
CREATE INDEX idx_plans_open ON plans (holder_id) WHERE status = 'open';
CREATE INDEX idx_alerts_plan_exit ON alerts(plan_exit_id);

CREATE TRIGGER trg_plans_updated_at
AFTER UPDATE ON plans
BEGIN
  UPDATE plans SET updated_at = datetime('now') WHERE id = NEW.id;
END;
