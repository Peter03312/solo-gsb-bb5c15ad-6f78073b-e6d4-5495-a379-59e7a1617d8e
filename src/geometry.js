// 几何核心：多边形校验（自交/越界/面积重叠）、缺口区域、铅条清单
// 全部坐标为整数毫米；浮点比较使用 EPS 容差。

const EPS = 1e-9;
const GAP_EPS = 1e-7; // 判定两块“刚好接触”的容差
const NUDGE = 1e-6; // 向多边形内部探针偏移（毫米）

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (u, v) => u.x * v.y - u.y * v.x;
const dot = (u, v) => u.x * v.x + u.y * v.y;
const len = (u) => Math.hypot(u.x, u.y);

export function polygonArea(verts) {
  let s = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function signedArea(verts) {
  let s = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * 把输入转成规范顶点：必须为 >=3 个非负整数点，去除重复闭合点，
 * 统一为逆时针（CCW）。失败返回 {error}。
 */
export function canonicalize(raw) {
  if (!Array.isArray(raw) || raw.length < 3) {
    return { error: '多边形至少需要 3 个顶点' };
  }
  let pts = raw.map((p) => {
    if (!Array.isArray(p) && (typeof p !== 'object' || p === null)) return null;
    const x = p[0] ?? p.x;
    const y = p[1] ?? p.y;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    return { x, y };
  });
  if (pts.some((p) => p === null)) {
    return { error: '所有顶点坐标必须是整数' };
  }
  // 负坐标即越界，交由 validatePolygon 报告具体位置
  // 去掉与首点重复的闭合点
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first.x === last.x && first.y === last.y) pts = pts.slice(0, -1);
  // 去掉连续重复点
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q.x !== p.x || q.y !== p.y) out.push(p);
  }
  if (out.length < 3) return { error: '多边形至少需要 3 个不同顶点' };
  const area = signedArea(out);
  // 允许零面积进入下一步，由 validatePolygon 统一报告具体问题
  if (area < 0) out.reverse();
  return { vertices: out };
}

/** 线段关系：none / crossing / endpoint / collinear */
function segmentRelation(p1, p2, q1, q2) {
  const d1 = sub(p2, p1);
  const d2 = sub(q2, q1);
  const r = sub(q1, p1);
  const d = cross(d1, d2);
  if (Math.abs(d) > EPS) {
    const t = cross(r, d2) / d;
    const u = cross(r, d1) / d;
    const inT = t >= -EPS && t <= 1 + EPS;
    const inU = u >= -EPS && u <= 1 + EPS;
    if (!inT || !inU) return { type: 'none' };
    const tc = Math.min(1, Math.max(0, t));
    const point = { x: p1.x + d1.x * tc, y: p1.y + d1.y * tc };
    const tEnd = t <= EPS || t >= 1 - EPS;
    const uEnd = u <= EPS || u >= 1 - EPS;
    if (tEnd && uEnd) return { type: 'endpoint', point, kind: 'vertex-vertex' };
    if (tEnd || uEnd) return { type: 'endpoint', point, kind: 't-junction' };
    return { type: 'crossing', point };
  }
  // 平行
  if (Math.abs(cross(r, d1)) > EPS) return { type: 'none' };
  // 共线：求参数区间重叠
  const l2 = dot(d1, d1);
  const t1 = dot(sub(q1, p1), d1) / l2;
  const t2 = dot(sub(q2, p1), d1) / l2;
  const lo = Math.max(0, Math.min(t1, t2));
  const hi = Math.min(1, Math.max(t1, t2));
  if (hi - lo > EPS) {
    return {
      type: 'collinear',
      overlap: hi - lo,
      a: { x: p1.x + d1.x * lo, y: p1.y + d1.y * lo },
      b: { x: p1.x + d1.x * hi, y: p1.y + d1.y * hi },
    };
  }
  return { type: 'none' };
}

/**
 * 单片校验：越界 + 自交。verts 为 canonicalize 后的 CCW 顶点。
 * 返回 null 表示通过，否则 {reason, point, message}。
 */
export function validatePolygon(verts, width, height) {
  for (const p of verts) {
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) {
      return { reason: 'out_of_bounds', point: p, message: `顶点 (${p.x}, ${p.y}) 超出窗框 ${width}×${height} mm` };
    }
  }
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const rel = segmentRelation(verts[i], verts[(i + 1) % n], verts[j], verts[(j + 1) % n]);
      if (adjacent) {
        // 相邻边仅当沿来路折回（共线正重叠）才非法
        if (rel.type === 'collinear' && rel.overlap > EPS) {
          return { reason: 'self_intersection', point: rel.a, message: '多边形自交：相邻边折返重叠' };
        }
        continue;
      }
      if (rel.type === 'crossing') {
        return { reason: 'self_intersection', point: rel.point, message: `多边形自交于约 (${fmt(rel.point.x)}, ${fmt(rel.point.y)})` };
      }
      if (rel.type === 'endpoint') {
        return { reason: 'self_intersection', point: rel.point, message: '多边形边界自相接触，不是简单多边形' };
      }
      if (rel.type === 'collinear') {
        return { reason: 'self_intersection', point: rel.a, message: '多边形的非相邻边重叠，存在自交' };
      }
    }
  }
  if (Math.abs(signedArea(verts)) <= EPS) {
    return { reason: 'self_intersection', point: verts[0], message: '多边形面积为 0，所有顶点共线或图形退化' };
  }
  return null;
}

const fmt = (v) => Math.round(v * 100) / 100;

/** 点在多边形内：1 内部 / 0 边界 / -1 外部（射线法） */
export function pointInPolygon(p, verts) {
  let onBoundary = false;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    if (Math.abs(cross(sub(b, a), sub(p, a))) <= EPS &&
        Math.min(a.x, b.x) - EPS <= p.x && p.x <= Math.max(a.x, b.x) + EPS &&
        Math.min(a.y, b.y) - EPS <= p.y && p.y <= Math.max(a.y, b.y) + EPS) {
      onBoundary = true;
    }
  }
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const a = verts[i];
    const b = verts[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  if (inside) return onBoundary ? 0 : 1;
  return onBoundary ? 0 : -1;
}

function allVerticesOnBoundary(a, b) {
  return a.every((p) => pointInPolygon(p, b) === 0);
}

/**
 * 两片之间的冲突检查。允许：T 形接头、顶点相接、共线公共边（含一边整、
 * 另一边分多段）。拒绝：穿越相交、顶点落在对方内部（面积重叠）。
 * 返回 null 表示可相邻，否则返回冲突描述。
 */
export function pairConflict(a, b) {
  const n = a.length;
  const m = b.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const rel = segmentRelation(a[i], a[(i + 1) % n], b[j], b[(j + 1) % m]);
      if (rel.type === 'crossing') {
        return { reason: 'overlap', point: rel.point, message: `与现有拼片的边在 (${fmt(rel.point.x)}, ${fmt(rel.point.y)}) 穿越相交` };
      }
      // endpoint（T 形/顶点接触）与 collinear（公共边）均合法
    }
  }
  // 顶点严格落在对方内部
  for (const p of a) {
    if (pointInPolygon(p, b) === 1) {
      return { reason: 'overlap', point: p, message: `顶点 (${p.x}, ${p.y}) 位于现有拼片内部，构成面积重叠` };
    }
  }
  for (const p of b) {
    if (pointInPolygon(p, a) === 1) {
      return { reason: 'overlap', point: p, message: `现有拼片顶点 (${p.x}, ${p.y}) 位于新片内部，构成面积重叠` };
    }
  }
  // 边中点向各自内部（CCW 左侧）微偏移，探针落入对方内部 => 面积重叠。
  // 可捕获无穿越、无内点的凹多边形覆盖情形。
  for (const [poly, other] of [[a, b], [b, a]]) {
    for (let i = 0; i < poly.length; i++) {
      const v1 = poly[i];
      const v2 = poly[(i + 1) % poly.length];
      const d = sub(v2, v1);
      const l = len(d);
      if (l < EPS) continue;
      const mid = { x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 };
      const nx = -d.y / l;
      const ny = d.x / l;
      const probe = { x: mid.x + nx * NUDGE, y: mid.y + ny * NUDGE };
      if (pointInPolygon(probe, other) === 1 && pointInPolygon(probe, poly) === 1) {
        return { reason: 'overlap', point: mid, message: `拼片在 (${fmt(mid.x)}, ${fmt(mid.y)}) 附近与现有拼片面积重叠` };
      }
    }
  }
  // 完全相同（允许顶点中含多余共线点）：顶点全在对方边界上且面积相等
  const aa = polygonArea(a);
  const ab = polygonArea(b);
  if (Math.abs(aa - ab) <= 1e-6 && (allVerticesOnBoundary(a, b) || allVerticesOnBoundary(b, a))) {
    return { reason: 'overlap', point: a[0], message: '与现有拼片完全重合' };
  }
  return null;
}

// ---------- 缺口区域：按所有顶点 x 坐标做垂直条带分解 ----------

function edgeRefs(pieces) {
  const refs = [];
  pieces.forEach((piece, pi) => {
    const v = piece.vertices;
    for (let i = 0; i < v.length; i++) {
      refs.push({ a: v[i], b: v[(i + 1) % v.length], piece: pi });
    }
  });
  return refs;
}

/** 求草稿未覆盖的缺口多边形列表（CCW 四边形，可能含三角形退化边） */
export function computeGaps(pieces, width, height) {
  const xs = new Set([0, width]);
  for (const p of pieces) for (const v of p.vertices) xs.add(v.x);
  const xsSorted = [...xs].filter((x) => x >= 0 && x <= width).sort((a, b) => a - b);

  const refs = edgeRefs(pieces);
  const gaps = [];

  for (let k = 0; k < xsSorted.length - 1; k++) {
    const x0 = xsSorted[k];
    const x1 = xsSorted[k + 1];
    if (x1 - x0 <= EPS) continue;
    const xm = (x0 + x1) / 2;

    // 每个拼片在中线 x=xm 上的覆盖区间
    const intervals = [];
    pieces.forEach((piece, pi) => {
      const hits = [];
      const v = piece.vertices;
      for (let i = 0; i < v.length; i++) {
        const a = v[i];
        const b = v[(i + 1) % v.length];
        if ((a.x < xm && b.x > xm) || (a.x > xm && b.x < xm)) {
          const y = a.y + ((b.y - a.y) * (xm - a.x)) / (b.x - a.x);
          hits.push({ y, edge: refs.find((r) => r.a === a && r.b === b && r.piece === pi) });
        }
      }
      hits.sort((p, q) => p.y - q.y);
      for (let h = 0; h + 1 < hits.length; h += 2) {
        intervals.push({ lo: hits[h].y, hi: hits[h + 1].y, loEdge: hits[h].edge, hiEdge: hits[h + 1].edge });
      }
    });

    // 跨拼片求并集（简单多边形之间面积不重叠，区间至多端点相接）
    intervals.sort((p, q) => p.lo - q.lo);
    const merged = [];
    for (const it of intervals) {
      const top = merged[merged.length - 1];
      if (top && it.lo <= top.hi + GAP_EPS) {
        if (it.hi > top.hi) {
          top.hi = it.hi;
          top.hiEdge = it.hiEdge;
        }
      } else {
        merged.push({ ...it });
      }
    }

    const yAt = (edge, x) =>
      edge === null ? null : edge.a.y + ((edge.b.y - edge.a.y) * (x - edge.a.x)) / (edge.b.x - edge.a.x);

    const pushGap = (loEdge, hiEdge) => {
      // null 边代表窗框 y=0（底）或 y=height（顶）
      const lo0 = loEdge ? Math.min(height, Math.max(0, yAt(loEdge, x0))) : 0;
      const lo1 = loEdge ? Math.min(height, Math.max(0, yAt(loEdge, x1))) : 0;
      const hi0 = hiEdge ? Math.min(height, Math.max(0, yAt(hiEdge, x0))) : height;
      const hi1 = hiEdge ? Math.min(height, Math.max(0, yAt(hiEdge, x1))) : height;
      const quad = [
        { x: x0, y: lo0 },
        { x: x1, y: lo1 },
        { x: x1, y: hi1 },
        { x: x0, y: hi0 },
      ];
      const area = polygonArea(quad);
      if (area > 1e-7) {
        gaps.push({
          vertices: quad.map((p) => ({ x: round4(p.x), y: round4(p.y) })),
          area: round4(area),
        });
      }
    };

    let cursor = 0;
    let prevHiEdge = null;
    for (const it of merged) {
      const lo = Math.max(0, it.lo);
      const hi = Math.min(height, it.hi);
      if (lo > cursor + GAP_EPS) pushGap(prevHiEdge, it.loEdge);
      if (hi > cursor) {
        cursor = hi;
        prevHiEdge = it.hiEdge;
      }
    }
    if (height > cursor + GAP_EPS) pushGap(prevHiEdge, null);
  }
  return gaps;
}

const round4 = (v) => Math.round(v * 10000) / 10000;
const round2 = (v) => Math.round(v * 100) / 100;

function gcd3(a, b, c) {
  const g = (x, y) => {
    x = Math.abs(x);
    y = Math.abs(y);
    while (y) [x, y] = [y, x % y];
    return x;
  };
  return g(g(a, b), c) || 1;
}

/**
 * 铅条下料清单：
 * - 每条边按所在“支撑线”归一化分组，同一直线上共线的多段（无论来自几片、
 *   怎样分段）先做区间并集，公共边因此只计一次；
 * - 落在窗框四条线上的并入外框，单独列出；
 * - 长度先逐条精确求和，最后统一四舍五入到 0.01 mm。
 */
export function computeCame(pieces, width, height) {
  const lines = new Map(); // key -> {A,B,C, intervals:[[s0,s1]...]}

  const frameKeys = new Set([
    '1,0,0',          // x = 0
    `1,0,${-width}`,  // x = width
    '0,1,0',          // y = 0
    `0,1,${-height}`, // y = height
  ]);

  const addInterval = (key, A, B, C, d, p1, p2) => {
    const s1 = d.x * p1.x + d.y * p1.y;
    const s2 = d.x * p2.x + d.y * p2.y;
    let rec = lines.get(key);
    if (!rec) {
      rec = { A, B, C, d, intervals: [] };
      lines.set(key, rec);
    }
    rec.intervals.push([Math.min(s1, s2), Math.max(s1, s2)]);
  };

  for (const piece of pieces) {
    const v = piece.vertices;
    for (let i = 0; i < v.length; i++) {
      const p1 = v[i];
      const p2 = v[(i + 1) % v.length];
      let A = p1.y - p2.y;
      let B = p2.x - p1.x;
      let C = p1.x * p2.y - p2.x * p1.y;
      const g = gcd3(A, B, C);
      A /= g; B /= g; C /= g;
      // 符号归一：(A,B) 首个非零分量为正
      if (A < 0 || (A === 0 && B < 0)) { A = -A; B = -B; C = -C; }
      const L = Math.hypot(A, B);
      const d = { x: -B / L, y: A / L };
      addInterval(`${A},${B},${C}`, A, B, C, d, p1, p2);
    }
  }

  const internal = [];
  let internalSum = 0;
  for (const [key, rec] of lines) {
    if (frameKeys.has(key)) continue;
    const runs = unionRuns(rec.intervals);
    const L2 = rec.A * rec.A + rec.B * rec.B;
    const foot = { x: (-rec.C * rec.A) / L2, y: (-rec.C * rec.B) / L2 };
    for (const [s0, s1] of runs) {
      if (s1 - s0 <= EPS) continue;
      const a = { x: foot.x + rec.d.x * s0, y: foot.y + rec.d.y * s0 };
      const b = { x: foot.x + rec.d.x * s1, y: foot.y + rec.d.y * s1 };
      internalSum += s1 - s0;
      internal.push({
        from: { x: round2(a.x), y: round2(a.y) },
        to: { x: round2(b.x), y: round2(b.y) },
        length: round2(s1 - s0),
      });
    }
  }
  internal.sort((a, b) => b.length - a.length);

  // 外框：四条整根另列；used 为片边在该框线上的并集长度（完整覆盖时等于整根）
  const frameSpecs = [
    { side: '上', key: '0,1,-' + height, p0: { x: 0, y: height }, p1: { x: width, y: height } },
    { side: '下', key: '0,1,0', p0: { x: 0, y: 0 }, p1: { x: width, y: 0 } },
    { side: '左', key: '1,0,0', p0: { x: 0, y: 0 }, p1: { x: 0, y: height } },
    { side: '右', key: '1,0,-' + width, p0: { x: width, y: 0 }, p1: { x: width, y: height } },
  ];
  let frameUsedSum = 0;
  const frame = frameSpecs.map((f) => {
    const from = { ...f.p0 };
    const to = { ...f.p1 };
    const length = f.p0.x === f.p1.x ? height : width;
    let used = length;
    const rec = lines.get(f.key);
    if (rec) {
      const s0 = rec.d.x * f.p0.x + rec.d.y * f.p0.y;
      const s1 = rec.d.x * f.p1.x + rec.d.y * f.p1.y;
      const lo = Math.min(s0, s1);
      const hi = Math.max(s0, s1);
      used = unionRuns(rec.intervals)
        .reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, hi) - Math.max(a, lo)), 0);
    }
    frameUsedSum += used;
    return { side: f.side, from, to, length, used: round2(used) };
  });
  const frameSum = 2 * width + 2 * height;

  return {
    frame,
    internal,
    totals: {
      frame: round2(frameSum),
      frameUsed: round2(frameUsedSum),
      internal: round2(internalSum),
      total: round2(frameSum + internalSum),
    },
  };
}

function unionRuns(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  const runs = [];
  for (const [lo, hi] of intervals) {
    const top = runs[runs.length - 1];
    if (top && lo <= top[1] + GAP_EPS) {
      if (hi > top[1]) top[1] = hi;
    } else {
      runs.push([lo, hi]);
    }
  }
  return runs;
}
