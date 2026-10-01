import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  validatePolygon,
  pairConflict,
  computeGaps,
  computeCame,
  polygonArea,
  pointInPolygon,
} from '../src/geometry.js';

const rect = (x1, y1, x2, y2) => [
  { x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 },
];
const P = (verts, w = 100, h = 100) => {
  const c = canonicalize(verts);
  assert.ok(c.vertices, c.error);
  const err = validatePolygon(c.vertices, w, h);
  assert.equal(err, null, err?.message);
  return c.vertices;
};

test('canonicalize: 拒绝少于3点、非整数、零面积，去闭合点并统一 CCW', () => {
  assert.equal(canonicalize([{ x: 0, y: 0 }, { x: 1, y: 0 }]).error, '多边形至少需要 3 个顶点');
  assert.ok(canonicalize([{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]).error);
  const cz = canonicalize([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
  assert.ok(cz.vertices);
  assert.equal(validatePolygon(cz.vertices, 10, 10).reason, 'self_intersection');
  const c = canonicalize([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }]);
  assert.equal(c.vertices.length, 4);
  // CCW: 首两条边叉积为正
  assert.ok((c.vertices[1].x - c.vertices[0].x) * (c.vertices[2].y - c.vertices[0].y) -
            (c.vertices[1].y - c.vertices[0].y) * (c.vertices[2].x - c.vertices[0].x) > 0);
});

test('validatePolygon: 越界与自交被拒', () => {
  assert.equal(validatePolygon(P(rect(0, 0, 50, 50)), 100, 100), null);
  const ob = P(rect(0, 0, 50, 50));
  assert.equal(validatePolygon(ob, 40, 40)?.reason, 'out_of_bounds');
  // 蝴蝶结（四边形自交）
  const bow = [
    { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 },
  ];
  const cb = canonicalize(bow);
  assert.ok(cb.vertices, cb.error);
  assert.equal(validatePolygon(cb.vertices, 100, 100)?.reason, 'self_intersection');
});

test('相邻片: 整边对多段(T形)合法；穿越/内含/相同拒绝', () => {
  const left = P(rect(0, 0, 50, 100));
  const rightTop = P(rect(50, 0, 100, 40));
  const rightBottom = P(rect(50, 40, 100, 100));
  assert.equal(pairConflict(left, rightTop), null);
  assert.equal(pairConflict(left, rightBottom), null);
  assert.equal(pairConflict(rightTop, rightBottom), null);

  // 左侧整边 x=50 被右侧两段分割 —— 合法
  // 而一块跨越分界的片 => 与既有片重叠
  const overlapping = P(rect(40, 30, 90, 70));
  assert.equal(pairConflict(left, overlapping)?.reason, 'overlap');

  // 完全相同
  assert.equal(pairConflict(left, P(rect(0, 0, 50, 100)))?.reason, 'overlap');

  // 斜穿（含越界顶点）
  const cd = canonicalize([{ x: -1, y: -1 }, { x: 101, y: -1 }, { x: 101, y: 30 }]);
  assert.ok(cd.vertices, cd.error);
  const diag = cd.vertices;
  assert.equal(pairConflict(left, diag)?.reason, 'overlap');

  // 仅顶点相接，合法
  const corner = P(rect(50, 100, 80, 130), 200, 200);
  assert.equal(pairConflict(P(rect(0, 0, 50, 100), 200, 200), corner), null);
});

test('凹多边形：内贴子区域（无穿越、无顶点在内部）由内部探针检出', () => {
  // L 形：底条 + 左柱
  const lShape = P([
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 },
    { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 },
  ], 200, 200);
  // 底条内贴的矩形：三个顶点都在 L 的边上/与 L 顶点重合，无穿越，
  // L 的顶点也都不在其内部，但它整体位于 L 内部 —— 只能靠边中点探针发现。
  const sub = P([
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 },
  ], 200, 200);
  assert.equal(pairConflict(lShape, sub)?.reason, 'overlap');

  // C 形凹槽恰好填满（共边 + 贴框），合法
  const cShape = P([
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
    { x: 60, y: 100 }, { x: 60, y: 40 }, { x: 40, y: 40 },
    { x: 40, y: 100 }, { x: 0, y: 100 },
  ], 200, 200);
  const fill = P(rect(40, 40, 60, 100), 200, 200);
  assert.equal(pairConflict(cShape, fill), null);
});

test('pointInPolygon 边界/内部/外部', () => {
  const tri = P([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]);
  assert.equal(pointInPolygon({ x: 1, y: 1 }, tri), 1);
  assert.equal(pointInPolygon({ x: 0, y: 5 }, tri), 0);
  assert.equal(pointInPolygon({ x: 9, y: 9 }, tri), -1);
});

test('computeGaps: 未铺满给出缺口；铺满返回空', () => {
  const W = 100, H = 60;
  const pieces = [
    { vertices: P(rect(0, 0, 40, H), W, H) },
    { vertices: P(rect(40, 0, W, 30), W, H) },
  ];
  const gaps = computeGaps(pieces, W, H);
  assert.ok(gaps.length > 0);
  // 缺口总面积 = 100*60 - 40*60 - 60*30 = 1800
  const gapArea = gaps.reduce((s, g) => s + g.area, 0);
  assert.ok(Math.abs(gapArea - 1800) < 1e-6, `gap area ${gapArea}`);

  pieces.push({ vertices: P(rect(40, 30, W, H), W, H) });
  assert.deepEqual(computeGaps(pieces, W, H), []);
});

test('computeGaps: 斜切对三角铺满无缺口，三角形+矩形留斜缺口', () => {
  const W = 10, H = 10;
  const t1 = P([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], W, H);
  const t2 = P([{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], W, H);
  assert.deepEqual(computeGaps([{ vertices: t1 }, { vertices: t2 }], W, H), []);

  // 只放左下三角，缺口为右上三角，面积 50
  const gaps = computeGaps([{ vertices: t1 }], W, H);
  const area = gaps.reduce((s, g) => s + g.area, 0);
  assert.ok(Math.abs(area - 50) < 1e-6, `diag gap area ${area}`);
});

test('computeCame: 公共边只计一次；外框固定；T 形多段合并为一根', () => {
  const W = 100, H = 100;
  const pieces = [
    { vertices: P(rect(0, 0, 50, 100), W, H) },
    { vertices: P(rect(50, 0, 100, 40), W, H) },
    { vertices: P(rect(50, 40, 100, 100), W, H) },
  ];
  const came = computeCame(pieces, W, H);
  // 内部铅条：x=50 整根 100（两段并成一条）+ y=40 上的 50
  assert.equal(came.internal.length, 2);
  assert.ok(Math.abs(came.totals.internal - 150) < 1e-9);
  assert.equal(came.totals.frame, 400);
  assert.equal(came.totals.total, 550);
  assert.equal(came.frame.length, 4);
});

test('computeCame: 斜边公共部分去重，长度先求和再四舍五入', () => {
  const W = 10, H = 10;
  const t1 = P([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], W, H);
  const t2 = P([{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], W, H);
  const came = computeCame([{ vertices: t1 }, { vertices: t2 }], W, H);
  // 内部只有对角线 10√2
  assert.equal(came.internal.length, 1);
  const expected = Math.round(10 * Math.SQRT2 * 100) / 100;
  assert.equal(came.internal[0].length, expected);
  assert.equal(came.totals.internal, expected);
  // 外框 40
  assert.equal(came.totals.frame, 40);
  assert.equal(came.totals.total, round(40 + 10 * Math.SQRT2));
});

test('面积以 0.5 mm² 为最小单位（整数坐标）', () => {
  const tri = P([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 1, y: 2 }]);
  assert.equal(polygonArea(tri), 3);
});

test('computeCame: 框线 T 分段合并为整根，实际贴合长度正确', () => {
  const W = 100, H = 100;
  // 顶边和左边各整；底边由两片分段；右边由两片分段；一条内部竖缝
  const pieces = [
    { vertices: P(rect(0, 0, 50, 60), W, H) },
    { vertices: P(rect(50, 0, 100, 40), W, H) },
    { vertices: P(rect(0, 60, 50, 100), W, H) },
    { vertices: P(rect(50, 40, 100, 100), W, H) },
  ];
  const came = computeCame(pieces, W, H);
  // 铺满：四条框线均整根贴合
  for (const f of came.frame) assert.equal(f.used, f.length, f.side);
  assert.equal(came.totals.frameUsed, 400);
  // 内部：x=50 整根 100 + y=60 段 50 + y=40 段 50 = 200
  assert.ok(Math.abs(came.totals.internal - 200) < 1e-9,
    `internal ${came.totals.internal}, runs ${JSON.stringify(came.internal.map((r) => r.length))}`);
  assert.equal(came.totals.total, 600);
});

function round(v) { return Math.round(v * 100) / 100; }
