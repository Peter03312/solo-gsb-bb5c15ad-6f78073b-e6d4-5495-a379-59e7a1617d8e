// SQLite 持久层。启动时自动建表（幂等），数据库文件按 DB_PATH 配置。
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db;

export function openDb(path) {
  if (dirname(path) !== '.') mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate();
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      width      INTEGER NOT NULL,
      height     INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pieces (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label      INTEGER NOT NULL,
      color      TEXT NOT NULL,
      vertices   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS publications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version    INTEGER NOT NULL,
      snapshot   TEXT NOT NULL,
      came       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (project_id, version)
    );
  `);
}

const now = () => new Date().toISOString();

export function createProject(name, width, height) {
  const info = db
    .prepare('INSERT INTO projects (name, width, height, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, width, height, now());
  return getProject(info.lastInsertRowid);
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function listProjects() {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM pieces WHERE project_id = p.id) AS piece_count,
      (SELECT COALESCE(MAX(version), 0) FROM publications WHERE project_id = p.id) AS version_count
    FROM projects p ORDER BY p.id
  `).all();
}

export function listPieces(projectId) {
  return db.prepare('SELECT * FROM pieces WHERE project_id = ? ORDER BY label').all(projectId)
    .map(rowToPiece);
}

export function getPiece(id) {
  const row = db.prepare('SELECT * FROM pieces WHERE id = ?').get(id);
  return row ? rowToPiece(row) : null;
}

export function addPiece(projectId, color, vertices) {
  return db.transaction(() => {
    const max = db.prepare('SELECT COALESCE(MAX(label), 0) AS m FROM pieces WHERE project_id = ?').get(projectId).m;
    const info = db
      .prepare('INSERT INTO pieces (project_id, label, color, vertices) VALUES (?, ?, ?, ?)')
      .run(projectId, max + 1, color, JSON.stringify(vertices));
    touchProject(projectId);
    return getPiece(info.lastInsertRowid);
  })();
}

export function updatePiece(id, patch) {
  const cur = getPiece(id);
  if (!cur) return null;
  db.prepare('UPDATE pieces SET color = ?, vertices = ? WHERE id = ?')
    .run(patch.color ?? cur.color, JSON.stringify(patch.vertices ?? cur.vertices), id);
  touchProject(cur.project_id);
  return getPiece(id);
}

export function deletePiece(id) {
  const cur = getPiece(id);
  if (!cur) return false;
  db.prepare('DELETE FROM pieces WHERE id = ?').run(id);
  touchProject(cur.project_id);
  return true;
}

export function addPublication(projectId, snapshot, came) {
  return db.transaction(() => {
    const next = db
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM publications WHERE project_id = ?')
      .get(projectId).v;
    db.prepare('INSERT INTO publications (project_id, version, snapshot, came) VALUES (?, ?, ?, ?)')
      .run(projectId, next, JSON.stringify(snapshot), JSON.stringify(came));
    touchProject(projectId);
    return getPublication(projectId, next);
  })();
}

export function getPublication(projectId, version) {
  const row = db
    .prepare('SELECT * FROM publications WHERE project_id = ? AND version = ?')
    .get(projectId, version);
  return row ? rowToPub(row) : null;
}

export function listPublications(projectId) {
  return db.prepare('SELECT id, project_id, version, created_at FROM publications WHERE project_id = ? ORDER BY version')
    .all(projectId);
}

function touchProject(id) {
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), id);
}

function rowToPiece(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    label: row.label,
    color: row.color,
    vertices: JSON.parse(row.vertices),
    created_at: row.created_at,
  };
}

function rowToPub(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    version: row.version,
    created_at: row.created_at,
    snapshot: JSON.parse(row.snapshot),
    came: JSON.parse(row.came),
  };
}
