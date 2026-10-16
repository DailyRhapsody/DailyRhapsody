// node --test tests/visitor-map.test.mjs
//
// 访客地图底图的三件事各自钉住：
//   1. 掩码本身没被改坏（陆地格数与核验过的成品一致）；
//   2. 经纬度落格与「格子中心」换算正确（拿内陆 / 开阔水域的真实坐标断点）；
//   3. 对外发布的点位只有格子粒度：没有 IP、没有城市名、没有精确坐标。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORLD_LAT_BOTTOM,
  WORLD_LAT_TOP,
  WORLD_MASK_BASE64,
  WORLD_MASK_H,
  WORLD_MASK_W,
  VISITOR_MAP_MAX_CELLS,
  aggregateVisitorPoints,
  decodeWorldMask,
  worldCellCenter,
  worldCellFor,
} from "../lib/visitor-map.ts";

const bits = decodeWorldMask();
const isLand = (lat, lon) => {
  const { row, col } = worldCellFor(lat, lon);
  return bits[row * WORLD_MASK_W + col] === 1;
};

// ---------------------------------------------------------------------------
// 掩码：联合国 Map No.4651 Rev.4（2026-07）重采样成品，陆地 4344 格
// ---------------------------------------------------------------------------
test("掩码尺寸与陆地格数与核验过的成品一致", () => {
  assert.equal(WORLD_MASK_W, 188);
  assert.equal(WORLD_MASK_H, 76);
  assert.equal(bits.length, 188 * 76);
  const land = bits.reduce((acc, v) => acc + v, 0);
  assert.equal(land, 4344, "陆地格数变了，说明内嵌掩码被改动过");
  assert.equal(WORLD_MASK_BASE64.length, 2384);
});

test("掩码在 ±180 与极区边界上不越界", () => {
  for (const lon of [-180, -179.99, 179.99, 180]) {
    for (const lat of [WORLD_LAT_TOP, WORLD_LAT_BOTTOM, 0]) {
      const c = worldCellFor(lat, lon);
      assert.ok(c.row >= 0 && c.row < WORLD_MASK_H, `row 越界: ${c.row}`);
      assert.ok(c.col >= 0 && c.col < WORLD_MASK_W, `col 越界: ${c.col}`);
    }
  }
  assert.deepEqual(worldCellFor(120, 200), worldCellFor(120, -160));
});

// ---------------------------------------------------------------------------
// 落格断点：只放内陆与开阔水域
// ---------------------------------------------------------------------------
test("内陆落格为陆地", () => {
  const cases = [
    ["巴黎", 48.86, 2.35],
    ["莫斯科", 55.75, 37.62],
    ["北京", 39.9, 116.41],
    ["开罗", 30, 31.2],
    ["约翰内斯堡", -26.2, 28],
    ["芝加哥", 41.9, -87.6],
    ["亚马逊", -3, -60],
    ["西伯利亚", 65, 100],
    ["澳洲内陆", -25, 135],
    ["格陵兰中部", 72, -40],
  ];
  for (const [name, lat, lon] of cases) assert.equal(isLand(lat, lon), true, `${name} 应为陆地`);
});

test("开阔水域落格为海洋", () => {
  const cases = [
    ["挪威海 68N/0E", 68, 0],
    ["北大西洋", 55, -30],
    ["太平洋赤道", 0, -150],
    ["印度洋", -20, 80],
    ["几内亚湾", 0, 0],
    ["哈得孙湾", 58, -88],
    ["塔斯曼海", -40, 160],
  ];
  for (const [name, lat, lon] of cases) assert.equal(isLand(lat, lon), false, `${name} 应为海洋`);
});

test("格子中心落在该格范围内", () => {
  for (const [lat, lon] of [[39.9, 116.41], [-33.87, 151.21], [68, 0], [-55.9, -67.2]]) {
    const cell = worldCellFor(lat, lon);
    const center = worldCellCenter(cell);
    assert.deepEqual(worldCellFor(center.lat, center.lon), cell);
  }
});

// ---------------------------------------------------------------------------
// 发布点位的粒度与隐私护栏
// ---------------------------------------------------------------------------
test("聚合：同格合并、坐标替换为格中心、按次数降序", () => {
  const out = aggregateVisitorPoints([
    { lat: 39.9, lng: 116.41, count: 3 },
    { lat: 39.91, lng: 116.4, count: 2 },
    { lat: 31.2, lng: 121.5, count: 7 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].count, 7);
  assert.equal(out[1].count, 5);
  const center = worldCellCenter(worldCellFor(39.9, 116.41));
  assert.deepEqual(out[1], { lat: center.lat, lon: center.lon, count: 5 });
  assert.notEqual(out[1].lat, 39.9);
  assert.notEqual(out[1].lon, 116.41);
});

test("聚合：精确坐标与城市名不会出现在发布结果里", () => {
  const out = aggregateVisitorPoints([{ lat: 39.9042, lng: 116.4074, count: 4 }]);
  const json = JSON.stringify(out);
  assert.ok(!json.includes("39.9042"), "精确纬度泄漏到发布结果");
  assert.ok(!json.includes("116.4074"), "精确经度泄漏到发布结果");
  for (const banned of ["ip", "city", "country", "userAgent", "visitorId", "referrer"]) {
    assert.ok(!json.includes(banned), `发布结果里出现了 ${banned}`);
  }
  assert.deepEqual(Object.keys(out[0]).sort(), ["count", "lat", "lon"]);
});

test("聚合：越界点被夹到边缘格，非法值被丢弃，结果有上限", () => {
  const out = aggregateVisitorPoints([
    { lat: 200, lng: 999, count: 1 },
    { lat: Number.NaN, lng: 0, count: 1 },
    { lat: 0, lng: 0, count: 0 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 1);

  const many = Array.from({ length: VISITOR_MAP_MAX_CELLS + 50 }, (_, i) => ({
    lat: -50 + (i % 100),
    lng: -170 + (i % 340),
    count: 1,
  }));
  assert.ok(aggregateVisitorPoints(many).length <= VISITOR_MAP_MAX_CELLS);
});
