// Reference 模糊搜索与多字段排序的纯函数守卫。
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  matchesQuery,
  normalizeText,
  parseSortKeys,
  serializeSortKeys,
  sortReferenceItems,
} = await import("../lib/reference-sort.ts");

function item(over = {}) {
  return {
    id: "a",
    name: "iRobot Roomba",
    titleZh: null,
    summary: "扫地机器人",
    source: "官网",
    tags: ["清洁"],
    clippedAt: "2026-01-01T00:00:00.000Z",
    kind: "external",
    domains: ["消费"],
    robotTypes: ["扫地机器人"],
    year: 2024,
    ...over,
  };
}

test("分词后每个词都要命中，顺序无关", () => {
  const it = item();
  assert.equal(matchesQuery(it, "Roomba irobot"), true);
  assert.equal(matchesQuery(it, "清洁 官网"), true);
  assert.equal(matchesQuery(it, "Roomba 不存在的词"), false);
  assert.equal(matchesQuery(it, "   "), true);
});

test("全角与大小写不影响匹配", () => {
  assert.equal(matchesQuery(item({ name: "ＲＯＯＭＢＡ" }), "roomba"), true);
  assert.equal(normalizeText("  a　b  "), "a b");
});

test("公司档案字段可被搜到", () => {
  const it = item({ company: { companyName: "石头科技", productForms: ["扫地机器人"] } });
  assert.equal(matchesQuery(it, "石头"), true);
  assert.equal(matchesQuery(it, "石头 割草机"), false);
});

test("多键排序：主键相等再看次键", () => {
  const list = [
    item({ id: "1", year: 2024, name: "B" }),
    item({ id: "2", year: 2024, name: "A" }),
    item({ id: "3", year: 2025, name: "C" }),
  ];
  const sorted = sortReferenceItems(list, [
    { field: "year", dir: "desc" },
    { field: "name", dir: "asc" },
  ]);
  assert.deepEqual(sorted.map((x) => x.id), ["3", "2", "1"]);
});

test("缺失年份排在最后，方向反转也不提前", () => {
  const list = [item({ id: "1", year: null }), item({ id: "2", year: 2020 })];
  assert.deepEqual(
    sortReferenceItems(list, [{ field: "year", dir: "asc" }]).map((x) => x.id),
    ["2", "1"],
  );
  assert.deepEqual(
    sortReferenceItems(list, [{ field: "year", dir: "desc" }]).map((x) => x.id),
    ["2", "1"],
  );
});

test("URL 排序参数解析与回写，非法值被忽略且最多两键", () => {
  assert.deepEqual(parseSortKeys("year:desc,name:asc"), [
    { field: "year", dir: "desc" },
    { field: "name", dir: "asc" },
  ]);
  assert.deepEqual(parseSortKeys("bogus:asc,year:up"), []);
  assert.deepEqual(parseSortKeys("year:asc,year:desc"), [{ field: "year", dir: "asc" }]);
  assert.deepEqual(
    parseSortKeys("year:asc,name:desc,kind:asc"),
    [
      { field: "year", dir: "asc" },
      { field: "name", dir: "desc" },
    ],
  );
  assert.equal(serializeSortKeys([{ field: "year", dir: "desc" }]), "year:desc");
  assert.equal(serializeSortKeys([]), "");
});
