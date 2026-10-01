// 彩绘玻璃拼片台前端（原生 JS）
const $ = (id) => document.getElementById(id);

const state = {
  project: null,
  pieces: [],
  gaps: [],
  mode: 'idle', // idle | add | edit
  drawing: [],  // 正在绘制/编辑的整数毫米点
  editingId: null,
  editingColor: null,
  scale: 1,
  offsetX: 20,
  offsetY: 20,
  hover: null,
  view: null,   // 发布只读视图 {snapshot, came, version}
};

const COLORS = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085', '#d35400', '#7f8c8d'];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || data?.error || '请求失败');
    err.payload = data;
    throw err;
  }
  return data;
}

// ---------- 项目列表 ----------

async function refreshProjectList() {
  const projects = await api('/api/projects');
  const wrap = $('projectList');
  if (!projects.length) {
    wrap.innerHTML = '<p class="muted">还没有窗框项目。</p>';
  } else {
    wrap.innerHTML = `<table><tr><th>名称</th><th>尺寸</th><th>草稿片数</th><th>发布次数</th><th></th></tr>` +
      projects.map((p) => `<tr>
        <td>${esc(p.name)}</td><td>${p.width} × ${p.height} mm</td>
        <td>${p.piece_count}</td><td>${p.version_count}</td>
        <td><button data-open="${p.id}">打开</button></td>
      </tr>`).join('') + '</table>';
    wrap.querySelectorAll('[data-open]').forEach((b) =>
      b.addEventListener('click', () => openProject(Number(b.dataset.open))));
  }
  $('projectTabs').innerHTML = projects
    .map((p) => `<button data-tab="${p.id}" class="${state.project?.id === p.id ? 'active' : ''}">${esc(p.name)}</button>`)
    .join('');
  $('projectTabs').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => openProject(Number(b.dataset.tab))));
}

$('newProjectBtn').addEventListener('click', () => {
  $('welcome').classList.remove('hidden');
  $('workspace').classList.add('hidden');
});
$('npCreate').addEventListener('click', async () => {
  try {
    const p = await api('/api/projects', {
      method: 'POST',
      body: {
        name: $('npName').value.trim(),
        width: Number($('npWidth').value),
        height: Number($('npHeight').value),
      },
    });
    await refreshProjectList();
    await openProject(p.id);
  } catch (e) { alert(e.message); }
});

// ---------- 打开项目 / 画布 ----------

async function openProject(id) {
  const data = await api(`/api/projects/${id}`);
  state.project = data.project;
  state.pieces = data.pieces;
  state.gaps = [];
  state.view = null;
  cancelDraw();
  $('welcome').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('pubView').classList.add('hidden');
  switchTab('draft');
  $('projName').textContent = state.project.name;
  $('projSize').textContent = `${state.project.width} × ${state.project.height} mm`;
  fitCanvas();
  await Promise.all([renderSidebar(), refreshGaps()]);
  await refreshProjectList();
}

$('backBtn').addEventListener('click', () => {
  $('welcome').classList.remove('hidden');
  $('workspace').classList.add('hidden');
  refreshProjectList();
});

function fitCanvas() {
  const wrap = document.querySelector('.canvas-wrap');
  const maxW = Math.max(320, wrap.clientWidth - 24);
  const maxH = window.innerHeight - 210;
  const s = Math.min(maxW / state.project.width, maxH / state.project.height, 4);
  state.scale = s > 0 ? s : 1;
  const cw = Math.ceil(state.project.width * state.scale + 40);
  const ch = Math.ceil(state.project.height * state.scale + 40);
  const canvas = $('canvas');
  canvas.width = cw;
  canvas.height = ch;
  draw();
}
window.addEventListener('resize', () => state.project && fitCanvas());

// 毫米坐标 -> 画布像素（y 翻转，窗框顶边在上）
const X = (x) => state.offsetX + x * state.scale;
const Y = (y) => state.offsetY + (state.project.height - y) * state.scale;

function draw() {
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 窗框阴影底
  ctx.fillStyle = '#e9e6de';
  ctx.fillRect(X(0), Y(state.project.height), state.project.width * state.scale, state.project.height * state.scale);

  // 拼片
  for (const p of state.pieces) {
    const isEditing = state.mode === 'edit' && state.editingId === p.id;
    path(ctx, p.vertices);
    ctx.fillStyle = p.color + (isEditing ? '33' : 'cc');
    ctx.fill();
    path(ctx, p.vertices);
    ctx.lineWidth = isEditing ? 3 : 1.5;
    ctx.strokeStyle = isEditing ? '#ef8354' : '#222';
    ctx.stroke();
    const c = centroid(p.vertices);
    const isEditingHere = isEditing && state.mode === 'edit';
    if (!isEditingHere) {
      ctx.fillStyle = '#1a1a1a';
      ctx.font = `${Math.max(11, Math.min(16, 13 * Math.max(1, state.scale)))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.label), X(c.x), Y(c.y));
    }
  }

  // 缺口区域：红色斜纹
  if ($('showGaps').checked && state.gaps.length) {
    const region = new Path2D();
    for (const g of state.gaps) {
      region.moveTo(X(g.vertices[0].x), Y(g.vertices[0].y));
      for (let i = 1; i < g.vertices.length; i++) region.lineTo(X(g.vertices[i].x), Y(g.vertices[i].y));
      region.closePath();
    }
    ctx.save();
    ctx.fillStyle = 'rgba(192, 57, 43, .14)';
    ctx.fill(region);
    ctx.strokeStyle = 'rgba(192, 57, 43, .8)';
    ctx.lineWidth = 1;
    ctx.stroke(region);
    // 斜纹线：裁剪到全部缺口的并集区域
    ctx.clip(region);
    ctx.strokeStyle = 'rgba(192,57,43,.35)';
    ctx.beginPath();
    const step = 8;
    const x0 = X(0), x1 = X(state.project.width);
    const y0 = Y(state.project.height), y1 = Y(0);
    for (let t = x0 - (y1 - y0); t < x1 + (y1 - y0); t += step) {
      ctx.moveTo(t, y1);
      ctx.lineTo(t + (y1 - y0), y0);
    }
    ctx.stroke();
    ctx.restore();
  }

  // 窗框外框（画在最上）
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(X(0), Y(state.project.height), state.project.width * state.scale, state.project.height * state.scale);

  // 正在绘制的多边形
  if ((state.mode === 'add' || state.mode === 'edit') && state.drawing.length) {
    const color = state.mode === 'edit' ? state.editingColor : $('pieceColor').value;
    if (state.drawing.length >= 3) {
      path(ctx, state.drawing);
      ctx.fillStyle = color + '55';
      ctx.fill();
    }
    ctx.beginPath();
    state.drawing.forEach((p, i) => {
      if (i === 0) ctx.moveTo(X(p.x), Y(p.y)); else ctx.lineTo(X(p.x), Y(p.y));
    });
    if (state.hover) ctx.lineTo(X(hoverPoint().x), Y(hoverPoint().y));
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
    state.drawing.forEach((p) => {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }
}

function path(ctx, verts) {
  ctx.beginPath();
  ctx.moveTo(X(verts[0].x), Y(verts[0].y));
  for (let i = 1; i < verts.length; i++) ctx.lineTo(X(verts[i].x), Y(verts[i].y));
  ctx.closePath();
}

function centroid(v) {
  let x = 0, y = 0;
  for (const p of v) { x += p.x; y += p.y; }
  return { x: x / v.length, y: y / v.length };
}

// ---------- 鼠标交互 ----------

const canvas = $('canvas');

function eventToMm(e) {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left - state.offsetX;
  const py = e.clientY - rect.top - state.offsetY;
  return {
    x: px / state.scale,
    y: state.project.height - py / state.scale,
  };
}

// 吸附：现有顶点优先，其次网格整数
function snapPoint(mm) {
  const pxTol = 9 / state.scale;
  let best = null, bestD = pxTol;
  for (const p of state.pieces) {
    if (state.mode === 'edit' && p.id === state.editingId) continue;
    for (const v of p.vertices) {
      const d = Math.hypot(v.x - mm.x, v.y - mm.y);
      if (d < bestD) { bestD = d; best = v; }
    }
  }
  if (best) return { ...best };
  if ($('snapGrid').checked) return { x: Math.round(mm.x), y: Math.round(mm.y) };
  return { x: Math.round(mm.x), y: Math.round(mm.y) };
}

const hoverPoint = () => state.hover;

canvas.addEventListener('mousemove', (e) => {
  if (!state.project) return;
  const mm = eventToMm(e);
  state.hover = mm;
  const sp = snapPoint(mm);
  $('coords').textContent =
    `指针 (${mm.x.toFixed(1)}, ${mm.y.toFixed(1)}) mm` +
    (state.mode !== 'idle' ? `　吸附 → (${sp.x}, ${sp.y}) mm　点击加点，双击/Enter 完成，Backspace 撤销，Esc 取消` : '');
  draw();
});

canvas.addEventListener('click', (e) => {
  if (state.view) return; // 发布只读视图
  if (!state.project) return;
  if (state.mode === 'idle') {
    // 点击某片进入编辑
    const mm = eventToMm(e);
    const hit = pieceAt(mm);
    if (hit) startEdit(hit);
    return;
  }
  const sp = snapPoint(eventToMm(e));
  state.drawing.push(sp);
  draw();
});

canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  if (state.mode !== 'idle') finishDrawing();
});

function pieceAt(pt) {
  for (let i = state.pieces.length - 1; i >= 0; i--) {
    if (pointInPoly(pt, state.pieces[i].vertices)) return state.pieces[i];
  }
  return null;
}

function pointInPoly(p, verts) {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const a = verts[i], b = verts[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

document.addEventListener('keydown', (e) => {
  if (state.mode === 'idle') return;
  if (e.key === 'Enter') { e.preventDefault(); finishDrawing(); }
  if (e.key === 'Backspace') { e.preventDefault(); state.drawing.pop(); draw(); }
  if (e.key === 'Escape') cancelDraw();
});

$('addModeBtn').addEventListener('click', () => {
  if (state.mode === 'add') return finishDrawing();
  startAdd();
});
$('finishBtn').addEventListener('click', finishDrawing);
$('undoBtn').addEventListener('click', () => { state.drawing.pop(); draw(); });
$('cancelBtn').addEventListener('click', cancelDraw);
$('pieceColor').addEventListener('change', () => {
  if (state.mode === 'add' || state.mode === 'edit') draw();
});
$('showGaps').addEventListener('change', draw);

function startAdd() {
  state.mode = 'add';
  state.drawing = [];
  state.editingId = null;
  setDrawButtons(true);
  hideBanner();
}

function startEdit(piece) {
  state.mode = 'edit';
  state.editingId = piece.id;
  state.editingColor = piece.color;
  state.drawing = piece.vertices.map((v) => ({ ...v }));
  $('pieceColor').value = piece.color;
  setDrawButtons(true);
  hideBanner();
  draw();
}

function cancelDraw() {
  state.mode = 'idle';
  state.drawing = [];
  state.editingId = null;
  setDrawButtons(false);
  if (state.project) draw();
}

function setDrawButtons(drawing) {
  $('finishBtn').classList.toggle('hidden', !drawing);
  $('undoBtn').classList.toggle('hidden', !drawing);
  $('cancelBtn').classList.toggle('hidden', !drawing);
  $('addModeBtn').classList.toggle('hidden', drawing);
}

async function finishDrawing() {
  if (state.drawing.length < 3) {
    showBanner('至少需要 3 个顶点才能构成一片玻璃。');
    return;
  }
  try {
    if (state.mode === 'add') {
      await api(`/api/projects/${state.project.id}/pieces`, {
        method: 'POST',
        body: { color: $('pieceColor').value, vertices: state.drawing },
      });
    } else if (state.mode === 'edit') {
      await api(`/api/projects/${state.project.id}/pieces/${state.editingId}`, {
        method: 'PUT',
        body: { color: $('pieceColor').value, vertices: state.drawing },
      });
    }
    cancelDraw();
    await reloadPieces();
  } catch (e) {
    showBanner(rejectMessage(e), e.payload);
  }
}

function rejectMessage(e) {
  const d = e.payload?.error;
  if (!d) return e.message;
  const where = d.labels ? `（涉及拼片 #${d.labels.join('、#')}）` :
                d.label ? `（拼片 #${d.label}）` : '';
  return `❌ 编辑被拒绝${where}：${d.message}`;
}

async function reloadPieces() {
  const data = await api(`/api/projects/${state.project.id}`);
  state.pieces = data.pieces;
  await Promise.all([renderSidebar(), refreshGaps()]);
}

async function refreshGaps() {
  try {
    state.gaps = (await api(`/api/projects/${state.project.id}/gaps`)).gaps;
  } catch { state.gaps = []; }
  const area = state.gaps.reduce((s, g) => s + g.area, 0);
  const stat = $('draftStats');
  if (state.gaps.length) {
    stat.innerHTML = `共 ${state.pieces.length} 片；<span style="color:#c0392b">未覆盖缺口 ${state.gaps.length} 块，约 ${area.toFixed(2)} mm²</span>`;
  } else if (state.pieces.length) {
    stat.innerHTML = `共 ${state.pieces.length} 片；<span style="color:#27ae60">已完整覆盖窗框，可以发布</span>`;
  } else {
    stat.textContent = '草稿为空';
  }
  draw();
}

function showBanner(html, payload) {
  const b = $('errorBanner');
  b.classList.remove('hidden', 'ok');
  b.innerHTML = html;
  // 错误位置标记：存下来，在画布上闪烁红点
  state.errorPoint = payload?.error?.point || null;
  drawErrorMarker();
}
function hideBanner() {
  $('errorBanner').classList.add('hidden');
  state.errorPoint = null;
  draw();
}

function drawErrorMarker() {
  if (!state.errorPoint) return;
  if (state._markerRAF) cancelAnimationFrame(state._markerRAF);
  const p = state.errorPoint;
  const ctx = canvas.getContext('2d');
  let t = 0;
  const pulse = () => {
    if (!state.errorPoint) { state._markerRAF = null; return; }
    draw();
    const r = 7 + Math.sin(t) * 2.5;
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), r, 0, Math.PI * 2);
    ctx.strokeStyle = '#e10600';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e10600';
    ctx.fillText(`(${Math.round(p.x)}, ${Math.round(p.y)})`, X(p.x) + 10, Y(p.y) - 8);
    t += 0.18;
    state._markerRAF = requestAnimationFrame(pulse);
  };
  pulse();
}

// ---------- 侧栏 ----------

async function renderSidebar() {
  const list = $('pieceList');
  if (!state.pieces.length) {
    list.innerHTML = '<p class="muted">尚无拼片。点击“绘制新片”，在画布上逐点点击。</p>';
  } else {
    list.innerHTML = state.pieces.map((p) => `
      <div class="piece-item">
        <input type="color" value="${p.color}" data-color="${p.id}">
        <div class="meta">#${p.label} <span class="muted">${p.vertices.length} 个顶点</span></div>
        <button data-edit="${p.id}">编辑</button>
        <button data-del="${p.id}">删除</button>
      </div>`).join('');
    list.querySelectorAll('[data-color]').forEach((inp) =>
      inp.addEventListener('change', async () => {
        await api(`/api/projects/${state.project.id}/pieces/${inp.dataset.color}`, {
          method: 'PUT',
          body: { color: inp.value },
        });
        await reloadPieces();
      }));
    list.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => startEdit(state.pieces.find((p) => p.id === Number(b.dataset.edit)))));
    list.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('删除该拼片？')) return;
        await api(`/api/projects/${state.project.id}/pieces/${b.dataset.del}`, { method: 'DELETE' });
        cancelDraw();
        await reloadPieces();
      }));
  }
  // 发布历史
  const pubs = await api(`/api/projects/${state.project.id}/publications`);
  $('pubList').innerHTML = pubs.length ? pubs.map((p) => `
    <div class="pub-item">
      <span>v${p.version} <span class="muted">${p.created_at}</span></span>
      <button data-view="${p.version}">查看</button>
    </div>`).join('')
    : '<p class="muted">尚未发布。完整覆盖窗框后才能发布。</p>';
  $('pubList').querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => viewPublication(Number(b.dataset.view))));
}

document.querySelectorAll('.tabs2 button').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

function switchTab(tab) {
  document.querySelectorAll('.tabs2 button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('draftPane').classList.toggle('hidden', tab !== 'draft');
  $('pubsPane').classList.toggle('hidden', tab !== 'pubs');
  $('pubView').classList.add('hidden');
}

$('publishBtn').addEventListener('click', async () => {
  hideBanner();
  try {
    const pub = await api(`/api/projects/${state.project.id}/publish`, { method: 'POST' });
    const b = $('errorBanner');
    b.className = 'banner ok';
    b.classList.remove('hidden');
    b.textContent = `✅ 已发布 v${pub.version}（铅条总长 ${pub.came.totals.total} mm）。历史版本不会随后续编辑改变。`;
    await Promise.all([renderSidebar(), refreshGaps(), refreshProjectList()]);
    setTimeout(() => viewPublication(pub.version), 600);
  } catch (e) {
    const payload = e.payload;
    if (payload?.gaps) state.gaps = payload.gaps;
    showBanner(
      payload?.error?.reason === 'gaps'
        ? `❌ 发布失败：${payload.error.message}（红色斜纹为缺口区域）`
        : rejectMessage(e),
      payload,
    );
    await refreshGaps();
  }
});

// ---------- 发布只读视图 ----------

async function viewPublication(version) {
  const pub = await api(`/api/projects/${state.project.id}/publications/${version}`);
  state.view = pub;
  // 用快照数据渲染画布（只读）：临时替换绘制数据
  state.pieces = pub.snapshot.pieces.map((p, i) => ({
    id: -1 - i, label: p.label, color: p.color, vertices: p.vertices,
  }));
  state.gaps = [];
  cancelDraw();
  $('draftPane').classList.add('hidden');
  $('pubsPane').classList.add('hidden');
  $('pubView').classList.remove('hidden');
  document.querySelectorAll('.tabs2 button').forEach((b) => b.classList.remove('active'));

  $('pubTitle').textContent = `发布版 v${pub.version} — ${pub.snapshot.project.name}（${pub.snapshot.project.width}×${pub.snapshot.project.height} mm，${pub.created_at}）`;
  $('pubPieces').innerHTML =
    '<tr><th>编号</th><th>颜色</th><th>面积 (mm²)</th></tr>' +
    pub.snapshot.pieces.map((p) => `<tr>
      <td>#${p.label}</td>
      <td><span class="swatch" style="display:inline-block;background:${p.color}"></span> ${p.color}</td>
      <td>${p.area.toFixed(2)}</td></tr>`).join('') +
    `<tr class="total-row"><td colspan="2">合计</td><td>${pub.snapshot.totalArea.toFixed(2)} / 窗框 ${pub.snapshot.frameArea}</td></tr>`;

  const c = pub.came;
  $('pubCame').innerHTML = `
    <table>
      <tr class="came-frame"><th colspan="4">外框（另列）</th></tr>
      <tr class="came-frame"><th>边</th><th>下料长度 (mm)</th><th>拼片实际贴合 (mm)</th><th>起 → 止 (mm)</th></tr>
      ${c.frame.map((f) => `<tr><td>${f.side}</td><td>${f.length.toFixed(2)}</td>
        <td>${f.used.toFixed(2)}</td>
        <td>(${f.from.x}, ${f.from.y}) → (${f.to.x}, ${f.to.y})</td></tr>`).join('')}
      <tr class="total-row"><td colspan="2">外框合计</td><td colspan="2">${c.totals.frame.toFixed(2)} mm（实际贴合 ${c.totals.frameUsed.toFixed(2)} mm）</td></tr>
      <tr><th colspan="3">内部铅条（公共边仅计一次，共线多段已合并）</th></tr>
      <tr><th>#</th><th>长度 (mm)</th><th>起 → 止 (mm)</th></tr>
      ${c.internal.map((r, i) => `<tr><td>${i + 1}</td><td>${r.length.toFixed(2)}</td>
        <td>(${r.from.x}, ${r.from.y}) → (${r.to.x}, ${r.to.y})</td></tr>`).join('') ||
        '<tr><td colspan="3" class="muted">无内部铅条</td></tr>'}
      <tr class="total-row"><td>内部合计</td><td colspan="2">${c.totals.internal.toFixed(2)} mm</td></tr>
      <tr class="total-row"><td>铅条总长</td><td colspan="2">${c.totals.total.toFixed(2)} mm（先求和再四舍五入至 0.01）</td></tr>
    </table>`;
}

$('pubViewBack').addEventListener('click', async () => {
  state.view = null;
  await openProject(state.project.id);
});

// ---------- 工具 ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 初始化
refreshProjectList();
