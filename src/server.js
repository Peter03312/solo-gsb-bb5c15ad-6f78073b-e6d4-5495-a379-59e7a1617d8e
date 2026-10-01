// HTTP 服务：拼片草稿 CRUD（带几何校验）、发布快照、历史版本只读查询。
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  openDb, createProject, getProject, listProjects,
  listPieces, addPiece, updatePiece, deletePiece, getPiece,
  addPublication, getPublication, listPublications,
} from './db.js';
import {
  canonicalize, validatePolygon, pairConflict, computeGaps, computeCame, polygonArea,
} from './geometry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'glass.db');

openDb(DB_PATH);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, '..', 'public')));

const COLORS = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085', '#d35400', '#7f8c8d'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const loadProject = (req, res) => {
  const project = getProject(Number(req.params.pid));
  if (!project) res.status(404).json({ error: '项目不存在' });
  return project;
};

/**
 * 校验一组拼片（草稿全集）。
 * 返回 { ok } 或 { ok:false, error:{...} }。
 */
export function validateDraft(project, pieces, candidate) {
  // candidate 可以是已存在片的更新版，先按 id 替换
  const all = pieces.map((p) =>
    candidate && p.id === candidate.id ? { ...p, ...candidate } : p
  );
  if (candidate && !all.some((p) => p.id === candidate.id)) all.push(candidate);

  const canon = [];
  for (const piece of all) {
    const c = canonicalize(piece.vertices);
    if (!c.vertices) {
      return { ok: false, error: { reason: 'invalid', label: piece.label, message: c.error } };
    }
    const selfErr = validatePolygon(c.vertices, project.width, project.height);
    if (selfErr) {
      return { ok: false, error: { reason: selfErr.reason, label: piece.label, point: selfErr.point, message: selfErr.message } };
    }
    canon.push({ piece, vertices: c.vertices });
  }
  for (let i = 0; i < canon.length; i++) {
    for (let j = i + 1; j < canon.length; j++) {
      const conflict = pairConflict(canon[i].vertices, canon[j].vertices);
      if (conflict) {
        return {
          ok: false,
          error: {
            reason: conflict.reason,
            labels: [canon[i].piece.label, canon[j].piece.label],
            point: conflict.point,
            message: conflict.message,
          },
        };
      }
    }
  }
  return { ok: true, pieces: canon.map((c) => ({ ...c.piece, vertices: c.vertices })) };
}

// ---------- 项目 ----------

app.get('/api/projects', (req, res) => res.json(listProjects()));

app.post('/api/projects', (req, res) => {
  const { name, width, height } = req.body || {};
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    return res.status(400).json({ error: '宽和高必须是正整数（毫米）' });
  }
  if (width > 100000 || height > 100000) {
    return res.status(400).json({ error: '窗框尺寸过大（上限 100000 mm）' });
  }
  res.status(201).json(createProject(String(name || '未命名窗框').slice(0, 100), width, height));
});

app.get('/api/projects/:pid', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  res.json({ project, pieces: listPieces(project.id) });
});

// ---------- 拼片草稿 ----------

app.post('/api/projects/:pid/pieces', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const pieces = listPieces(project.id);
  const tempId = -(pieces.length + 1);
  let { color } = req.body || {};
  if (!color || !COLOR_RE.test(color)) color = COLORS[pieces.length % COLORS.length];
  const candidate = { id: tempId, label: pieces.length + 1, color, vertices: req.body?.vertices };

  const result = validateDraft(project, pieces, candidate);
  if (!result.ok) return res.status(422).json({ error: result.error });

  const saved = addPiece(project.id, color, result.pieces.find((p) => p.id === tempId).vertices);
  res.status(201).json(saved);
});

app.put('/api/projects/:pid/pieces/:id', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const id = Number(req.params.id);
  const current = getPiece(id);
  if (!current || current.project_id !== project.id) return res.status(404).json({ error: '拼片不存在' });

  const color = COLOR_RE.test(req.body?.color) ? req.body.color : current.color;
  const candidate = { id, label: current.label, color, vertices: req.body?.vertices ?? current.vertices };
  const pieces = listPieces(project.id);
  const result = validateDraft(project, pieces, candidate);
  if (!result.ok) return res.status(422).json({ error: result.error });

  res.json(updatePiece(id, { color, vertices: result.pieces.find((p) => p.id === id).vertices }));
});

app.delete('/api/projects/:pid/pieces/:id', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const id = Number(req.params.id);
  const current = getPiece(id);
  if (!current || current.project_id !== project.id) return res.status(404).json({ error: '拼片不存在' });
  deletePiece(id);
  res.status(204).end();
});

// 草稿缺口（编辑过程中随时可查）
app.get('/api/projects/:pid/gaps', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const pieces = listPieces(project.id);
  res.json({ gaps: computeGaps(pieces, project.width, project.height) });
});

// ---------- 发布（仅草稿；历史版本不可变） ----------

app.post('/api/projects/:pid/publish', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const pieces = listPieces(project.id);
  if (pieces.length === 0) {
    return res.status(422).json({ error: { reason: 'empty', message: '草稿为空，无法发布' }, gaps: [] });
  }
  const result = validateDraft(project, pieces);
  if (!result.ok) return res.status(422).json({ error: result.error });

  const gaps = computeGaps(result.pieces, project.width, project.height);
  if (gaps.length > 0) {
    return res.status(422).json({
      error: { reason: 'gaps', message: `窗框未被完整覆盖，存在 ${gaps.length} 个缺口区域` },
      gaps,
    });
  }

  const frameArea = project.width * project.height;
  const snapshot = {
    project: { name: project.name, width: project.width, height: project.height },
    pieces: result.pieces.map((p) => ({
      label: p.label,
      color: p.color,
      vertices: p.vertices,
      area: Math.round(polygonArea(p.vertices) * 100) / 100,
    })),
    frameArea,
    totalArea: Math.round(result.pieces.reduce((s, p) => s + polygonArea(p.vertices), 0) * 100) / 100,
  };
  const came = computeCame(result.pieces, project.width, project.height);
  res.status(201).json(addPublication(project.id, snapshot, came));
});

app.get('/api/projects/:pid/publications', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  res.json(listPublications(project.id));
});

app.get('/api/projects/:pid/publications/:version', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const pub = getPublication(project.id, Number(req.params.version));
  if (!pub) return res.status(404).json({ error: '发布版本不存在' });
  res.json(pub);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`彩绘玻璃拼片台已启动: http://localhost:${PORT} （数据库: ${DB_PATH}）`);
});
