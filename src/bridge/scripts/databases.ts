/**
 * databases.ts — Database and group browsing JXA templates
 */

import { escapeForJXA } from "../executor.js";

/**
 * List all document records across databases (metadata only, no content).
 * Used by the RAG indexer to enumerate documents for semantic indexing.
 *
 * Traverses groups recursively (instead of relying on app.search("*")) to avoid
 * missing records in large databases.
 *
 * Filters out groups, smart groups, feeds, and non-text media types.
 * If a database name is provided, only that database is scanned.
 * If group UUID is provided, only that group subtree is scanned.
 */
export function listAllRecordsScript(database?: string, groupUuid?: string): string {
  const dbFilter = database ? escapeForJXA(database) : "null";
  const groupFilter = groupUuid ? escapeForJXA(groupUuid) : "null";
  return `(() => {
  const app = Application("DEVONthink");
  const dbFilter = ${dbFilter};
  const groupFilter = ${groupFilter};
  const skip = {"group":1,"smart group":1,"feed":1,"picture":1,"movie":1,"sound":1,"unknown":1};
  const out = [];

  // De-duplicate by UUID to avoid replicated records being indexed repeatedly.
  const seen = {};
  // Guard against cyclic/replicated group references.
  const seenGroups = {};

  function walkGroup(group, dbName) {
    let gUuid = "";
    try { gUuid = group.uuid(); } catch(e) {}
    if (gUuid && seenGroups[gUuid]) return;
    if (gUuid) seenGroups[gUuid] = 1;

    let kids = [];
    try { kids = group.children(); } catch(e) { return; }
    for (let i = 0; i < kids.length; i++) {
      try {
        const r = kids[i];
        const rType = r.recordType();
        if (rType === "group") {
          walkGroup(r, dbName);
          continue;
        }
        if (skip[rType]) continue;
        const uuid = r.uuid();
        if (seen[uuid]) continue;
        seen[uuid] = 1;
        let path = "";
        try { path = r.path() || ""; } catch(e) {}
        out.push({
          uuid: uuid,
          name: r.name(),
          recordType: rType,
          database: dbName,
          path: path,
          modificationDate: r.modificationDate().toISOString(),
        });
      } catch(e) { /* skip problematic records */ }
    }
  }

  if (groupFilter) {
    let group = null;
    try { group = app.getRecordWithUuid(groupFilter); } catch(e) { group = null; }
    if (!group) return JSON.stringify([]);

    let dbName = "";
    try { dbName = group.database().name(); } catch(e) { dbName = ""; }
    if (dbFilter && dbName !== dbFilter) return JSON.stringify([]);
    walkGroup(group, dbName);
    return JSON.stringify(out);
  }

  const allDbs = app.databases();
  for (let d = 0; d < allDbs.length; d++) {
    const db = allDbs[d];
    const dbName = db.name();
    if (dbFilter && dbName !== dbFilter) continue;
    walkGroup(db.root(), dbName);
  }
  return JSON.stringify(out);
})()`;
}

/**
 * List all open databases.
 */
export function listDatabasesScript(): string {
  return `(() => {
  const app = Application("DEVONthink");
  const dbs = app.databases();
  const out = [];
  for (let i = 0; i < dbs.length; i++) {
    const db = dbs[i];
    let count = 0;
    try { count = db.contents().length; } catch(e) { count = -1; }
    out.push({
      uuid: db.uuid(),
      name: db.name(),
      path: db.path(),
      recordCount: count,
    });
  }
  return JSON.stringify(out);
})()`;
}

/**
 * List the direct children of a group.
 * If uuid is empty, lists the current database's root contents.
 */
export function listGroupContentsScript(uuid?: string, limit: number = 30): string {
  const parent = uuid
    ? `app.getRecordWithUuid(${escapeForJXA(uuid)})`
    : "app.currentDatabase().root()";

  return `(() => {
  const app = Application("DEVONthink");
  const parent = ${parent};
  if (!parent) return JSON.stringify({error: "Group not found"});
  const kids = parent.children();
  const limit = Math.min(kids.length, ${limit});
  const out = [];
  for (let i = 0; i < limit; i++) {
    const c = kids[i];
    out.push({
      uuid: c.uuid(),
      name: c.name(),
      recordType: c.recordType(),
      size: c.size(),
      childCount: c.recordType() === "group" ? c.children().length : 0,
    });
  }
  return JSON.stringify({
    parentName: parent.name(),
    totalChildren: kids.length,
    children: out,
  });
})()`;
}
