import assert from "node:assert/strict";
import { test } from "node:test";
import { extractNotionDiaryDate } from "../lib/notion-diary-date.ts";

const pageCreatedAt = "2026-09-30T16:30:45.000Z";
const page = (dateProperty) => ({
  created_time: pageCreatedAt,
  properties: dateProperty ? { Date: { id: "date", ...dateProperty } } : {},
});

test("created_time retains the actual time and the Shanghai calendar day", () => {
  assert.deepEqual(
    extractNotionDiaryDate(page({ type: "created_time", created_time: pageCreatedAt })),
    { date: "2026-10-01", publishedAt: pageCreatedAt },
  );
});

test("uses the configured Date property rather than another page timestamp", () => {
  assert.deepEqual(
    extractNotionDiaryDate(page({ type: "created_time", created_time: "2026-07-01T02:03:04.000Z" })),
    { date: "2026-07-01", publishedAt: "2026-07-01T02:03:04.000Z" },
  );
});

test("creation timestamps cross day, month, and year boundaries in Shanghai", () => {
  for (const [timestamp, expectedDate] of [
    ["2026-09-30T15:59:59.000Z", "2026-09-30"],
    ["2026-09-30T16:00:00.000Z", "2026-10-01"],
    ["2026-12-31T16:00:00.000Z", "2027-01-01"],
  ]) {
    const result = extractNotionDiaryDate(page({ type: "created_time", created_time: timestamp }));
    assert.equal(result.date, expectedDate);
    assert.equal(result.publishedAt, timestamp);
  }
});

test("manual date-only values keep their original day without an invented time", () => {
  assert.deepEqual(
    extractNotionDiaryDate(page({ type: "date", date: { start: "2021-10-01", end: null } })),
    { date: "2021-10-01" },
  );
});

test("manual timestamps keep their calendar day and normalize their instant to UTC", () => {
  assert.deepEqual(
    extractNotionDiaryDate(page({ type: "date", date: { start: "2026-10-01T00:30:45+08:00" } })),
    { date: "2026-10-01", publishedAt: pageCreatedAt },
  );
  assert.deepEqual(
    extractNotionDiaryDate(page({ type: "date", date: { start: "2026-09-30T23:30:00-07:00" } })),
    { date: "2026-09-30", publishedAt: "2026-10-01T06:30:00.000Z" },
  );
});

test("a date range continues to use its start", () => {
  assert.deepEqual(
    extractNotionDiaryDate(page({ type: "date", date: { start: "2021-10-01", end: "2021-10-03" } })),
    { date: "2021-10-01" },
  );
});

test("missing, empty, or unrelated Date properties fall back to actual creation time", () => {
  for (const property of [undefined, { type: "date", date: null }, { type: "rich_text", rich_text: [] }]) {
    assert.deepEqual(extractNotionDiaryDate(page(property)), {
      date: "2026-10-01", publishedAt: pageCreatedAt,
    });
  }
});
