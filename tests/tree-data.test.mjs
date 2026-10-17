import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const tree = JSON.parse(fs.readFileSync("public/tree/tree.json", "utf8"));

test("树数据是公开文章的完整映射", () => {
  assert.equal(tree.schema, "dr.tree/1");
  const entries = tree.families.flatMap((family) =>
    family.topics.flatMap((topic) => topic.entries)
  );
  assert.equal(entries.length, tree.source.public);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.ok(tree.families.length >= 8);
  assert.ok(tree.families.every((family) => family.topics.length > 0));
});

test("树数据不携带正文、标签与私密字段", () => {
  const serialized = JSON.stringify(tree);
  for (const forbidden of ["summary", "tags", "content", "body", "isPublic"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
  }
  for (const family of tree.families) {
    for (const topic of family.topics) {
      for (const entry of topic.entries) {
        assert.deepEqual(Object.keys(entry).sort(), ["date", "id", "sub", "t"]);
      }
    }
  }
});

test("树上每个叶子都能回指一篇文章", () => {
  const entries = tree.families.flatMap((family) =>
    family.topics.flatMap((topic) => topic.entries)
  );
  assert.ok(entries.every((entry) => typeof entry.id === "string" && entry.id.length > 8));
  assert.ok(entries.every((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date)));
});
