/**
 * 出本机的模型调用前必须经过这里。
 * 规则刻意保守：宁可把普通数字/短句误伤成占位符，也不让手机号、邮箱、
 * 身份证、银行卡和门牌地址进入云端请求。
 */
const PATTERNS = [
  [/(?<!\d)1[3-9]\d(?:[\s-]?\d{4}){2}(?!\d)/g, "[手机号]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[邮箱]"],
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, "[身份证]"],
  [/(?<!\d)\d{16,19}(?!\d)/g, "[银行卡]"],
  [/(?:地址|住址|家住|住在|小区|门牌|街道|号楼|号院|单元|室)[^\n。；]{0,40}/g, "[地址]"],
];

export function redactPII(input) {
  let text = String(input ?? "");
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}
