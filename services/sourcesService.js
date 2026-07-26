// Advice sources: the people, groups, books and websites your trade ideas
// come from. The base row is narrow; type-specific fields live in 1:1
// extension tables (see docs/DB_ARCHITECTURE.md for why), so this file's job
// is mostly keeping base + detail in sync as one unit.
import db, { withTransaction } from "../lib/db.js";

export const SOURCE_TYPES = ["person", "group", "book", "website"];

// Maps each source type to its detail table and the fields it owns. Adding a
// new type means adding one entry here plus a table -- not editing five
// different switch statements.
const DETAIL_TABLES = {
  person: { table: "advice_source_person_details", fields: ["email", "phone", "app_type", "app_handle"] },
  group: {
    table: "advice_source_group_details",
    fields: ["primary_contact", "email", "phone", "app_type", "app_handle"],
  },
  book: { table: "advice_source_book_details", fields: ["author", "isbn", "websites", "pdfs"] },
  website: { table: "advice_source_website_details", fields: ["websites", "pdfs"] },
};

const insertSource = db.prepare(`
  INSERT INTO advice_sources (name, type, url, description, image_path)
  VALUES (@name, @type, @url, @description, @imagePath) RETURNING *
`);
const updateSource = db.prepare(`
  UPDATE advice_sources SET name = @name, type = @type, url = @url,
    description = @description, image_path = @imagePath
  WHERE id = @id
`);
const getSourceStmt = db.prepare("SELECT * FROM advice_sources WHERE id = ?");
const deleteSourceStmt = db.prepare("DELETE FROM advice_sources WHERE id = ?");

const listSourcesQuery = db.prepare(`
  SELECT s.*,
    (SELECT COUNT(*) FROM strategies st WHERE st.source_id = s.id) AS strategy_count,
    (SELECT COUNT(*) FROM watched_items w WHERE w.source_id = s.id) AS watched_count
  FROM advice_sources s
  ORDER BY s.name
`);

function upsertDetails(sourceId, type, details) {
  const spec = DETAIL_TABLES[type];
  if (!spec) return;

  // A source can be retyped (person -> book). Clear stale rows from the
  // other detail tables so a leftover person row doesn't shadow the new type.
  for (const [otherType, otherSpec] of Object.entries(DETAIL_TABLES)) {
    if (otherType !== type) {
      db.prepare(`DELETE FROM ${otherSpec.table} WHERE source_id = ?`).run(sourceId);
    }
  }

  const columns = ["source_id", ...spec.fields];
  const placeholders = columns.map((c) => `@${c}`).join(", ");
  const updates = spec.fields.map((f) => `${f} = excluded.${f}`).join(", ");
  const params = { source_id: sourceId };
  for (const field of spec.fields) params[field] = details?.[field] ?? null;

  db.prepare(
    `INSERT INTO ${spec.table} (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(source_id) DO UPDATE SET ${updates}`,
  ).run(params);
}

function loadDetails(sourceId, type) {
  const spec = DETAIL_TABLES[type];
  if (!spec) return {};
  return db.prepare(`SELECT * FROM ${spec.table} WHERE source_id = ?`).get(sourceId) ?? {};
}

export function listSources() {
  return listSourcesQuery.all();
}

/** Returns the base row with its type-specific fields merged under `details`. */
export function getSource(id) {
  const source = getSourceStmt.get(id);
  if (!source) return null;
  return { ...source, details: loadDetails(id, source.type) };
}

export function createSource(input) {
  const type = String(input?.type || "").toLowerCase();
  if (!SOURCE_TYPES.includes(type)) {
    throw new Error(`type must be one of: ${SOURCE_TYPES.join(", ")}`);
  }
  const name = String(input?.name || "").trim();
  if (!name) throw new Error("Source name is required");

  return withTransaction(() => {
    const row = insertSource.get({
      name,
      type,
      url: input.url || null,
      description: input.description || null,
      imagePath: input.imagePath || null,
    });
    upsertDetails(row.id, type, input.details);
    return { ...row, details: loadDetails(row.id, type) };
  });
}

export function updateSourceById(id, input) {
  const existing = getSourceStmt.get(id);
  if (!existing) throw new Error("Source not found");

  const type = String(input?.type || existing.type).toLowerCase();
  if (!SOURCE_TYPES.includes(type)) {
    throw new Error(`type must be one of: ${SOURCE_TYPES.join(", ")}`);
  }
  const name = String(input?.name ?? existing.name).trim();
  if (!name) throw new Error("Source name is required");

  return withTransaction(() => {
    updateSource.run({
      id,
      name,
      type,
      url: input.url ?? existing.url,
      description: input.description ?? existing.description,
      imagePath: input.imagePath ?? existing.image_path,
    });
    upsertDetails(id, type, input.details);
    return getSource(id);
  });
}

/**
 * Deleting a source CASCADEs to its strategies, and NULLs the source_id on
 * any watched items that referenced it (the items themselves survive).
 */
export function deleteSource(id) {
  return { deleted: deleteSourceStmt.run(id).changes };
}
