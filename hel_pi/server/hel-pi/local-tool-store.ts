import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../http';
import { limits } from './local-tool-values';

export type Definition = {
  description: string; source: string; connectionId: string;
  sampleInput: Record<string, unknown>; sampleFixtures: Record<string, unknown>;
};
type Revision = Definition & {revision: number};
type Slot = 'draft' | 'active';
type State = 'draft' | 'disabled' | 'enabled';
type Row = {name: string; slot: Slot; revision: number; definition: string; enabled: number};
type Item = {name: string; enabled: boolean; active: Revision | null; draft: Revision | null};

function unpack(row: Row): Revision { return {...JSON.parse(row.definition), revision: row.revision}; }

export function openToolStore(home: string) {
  const dir = join(home, 'local-tools');
  mkdirSync(dir, {recursive: true, mode: 0o700});
  if (!lstatSync(dir).isDirectory()) throw new Error('Expected a private local tools directory.');
  chmodSync(dir, 0o700);
  const path = join(dir, 'tools.sqlite');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected a private regular local tools database.');
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }

  const db = new Database(path);
  // Keep only the two reviewable versions. AUTOINCREMENT prevents a deleted revision being
  // reused, even if its name disappears and is re-created after restart.
  db.run(`CREATE TABLE IF NOT EXISTS revisions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    slot TEXT NOT NULL CHECK(slot IN ('active','draft')), definition TEXT NOT NULL,
    UNIQUE(name,slot)
  )`);
  // Disabling changes availability, not the reviewed definition. A replacement approval for
  // a disabled name also stays disabled until the human explicitly enables that revision.
  db.run('CREATE TABLE IF NOT EXISTS disabled (name TEXT PRIMARY KEY)');
  const select = "SELECT *, (slot='active' AND name NOT IN (SELECT name FROM disabled)) AS enabled FROM revisions";
  const bySlot = db.query(`${select} WHERE name=? AND slot=?`);
  const find = db.query<Row, [string, number]>(`${select} WHERE name=? AND revision=?`);
  const remove = db.query('DELETE FROM revisions WHERE name=? AND slot=?');

  function current(name: string, revision: number, required?: State) {
    const row = Number.isSafeInteger(revision) && find.get(name, revision);
    const state: State = row && row.slot === 'active' ? row.enabled ? 'enabled' : 'disabled' : 'draft';
    if (!row || (required && state !== required)) throw new HttpError('This revision is no longer current or enabled for this action. Refresh the tool library.', 409);
    return {state, version: unpack(row)};
  }

  return {
    inventory() {
      // Listing callable tools need not read full scripts or deserialize all the sample data.
      return db.query<{name: string; revision: number; description: string; connectionId: string}, []>(`
        SELECT name, revision, json_extract(definition,'$.description') AS description,
          json_extract(definition,'$.connectionId') AS connectionId
        FROM (${select}) WHERE enabled ORDER BY name
      `).all();
    },
    list(name?: string): Item[] {
      const items = new Map<string, Item>();
      const rows = name === undefined ? db.query<Row, []>(`${select} ORDER BY name`).all() : db.query<Row, [string]>(`${select} WHERE name=?`).all(name);
      for (const row of rows) {
        const item = items.get(row.name) ?? {name: row.name, enabled: false, active: null, draft: null};
        item[row.slot] = unpack(row);
        if (row.slot === 'active') item.enabled = Boolean(row.enabled);
        items.set(row.name, item);
      }
      return [...items.values()];
    },
    draft: db.transaction((name: string, definition: Definition) => {
      if (!bySlot.get(name, 'draft') && !bySlot.get(name, 'active') &&
          db.query<{count: number}, []>('SELECT count(DISTINCT name) AS count FROM revisions').get()!.count >= limits.tools)
        throw new HttpError('Local tool library is full. Replace an existing tool or reject an unused draft-only tool.', 409);
      remove.run(name, 'draft');
      return Number(db.query("INSERT INTO revisions(name,slot,definition) VALUES (?,'draft',?)").run(name, JSON.stringify(definition)).lastInsertRowid);
    }).immediate,
    current,
    change: db.transaction((name: string, revision: number, action: 'approve' | 'reject' | 'disable' | 'enable') => {
      current(name, revision, action === 'disable' ? 'enabled' : action === 'enable' ? 'disabled' : 'draft');
      if (action === 'approve') {
        remove.run(name, 'active');
        db.query("UPDATE revisions SET slot='active' WHERE revision=?").run(revision);
      } else if (action === 'reject') remove.run(name, 'draft');
      else if (action === 'disable') db.query('INSERT INTO disabled(name) VALUES (?)').run(name);
      else db.query('DELETE FROM disabled WHERE name=?').run(name);
    }).immediate,
    close() { db.close(); },
  };
}
