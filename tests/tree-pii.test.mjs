import assert from "node:assert/strict";
import test from "node:test";
import { redactPII } from "../scripts/tree/redact.mjs";

test("出站摘要会遮掉手机号、邮箱、身份证、银行卡与地址", () => {
  const input = "联系我 138 0013 8000，邮箱 a.b@example.com，身份证 110101199001011234，卡号 6222021234567890123，地址：朝阳区某小区 3 号楼 201 室。";
  const output = redactPII(input);
  for (const forbidden of ["138", "a.b@example.com", "110101199001011234", "6222021234567890123", "3 号楼 201 室"]) {
    assert.equal(output.includes(forbidden), false, forbidden);
  }
  assert.match(output, /\[手机号\]/);
  assert.match(output, /\[邮箱\]/);
});

test("普通日期和文章编号不会被当成手机号", () => {
  const input = "2026-10-18 的文章，编号 20261018，读起来很好。";
  assert.equal(redactPII(input), input);
});
