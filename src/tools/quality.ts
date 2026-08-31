/** Lightweight deterministic quality checks. Warnings degrade a run but do not discard its draft. */
export function inspectArticleQuality(markdown: string, html: string): string[] {
  const issues: string[] = [];

  if (process.env.REQUIRE_SUMMARY === "1" && !/(摘要|导语|本文要点)[:：]/.test(markdown)) {
    issues.push("缺少摘要/导语");
  }

  const sensitiveWords = (process.env.SENSITIVE_WORDS ?? "")
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);
  const foundSensitive = sensitiveWords.filter((word) => markdown.includes(word));
  if (foundSensitive.length > 0) issues.push(`命中敏感词：${foundSensitive.join("、")}`);

  if (process.env.REQUIRE_CITATIONS === "1" && /(据|数据显示|研究表明|报告指出)/.test(markdown)) {
    const hasCitation = /https?:\/\/|\[[^\]]*(来源|参考|引用)[^\]]*\]/.test(markdown);
    if (!hasCitation) issues.push("存在事实性表述但没有链接或来源标记");
  }

  const localImages = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1]!.trim())
    .filter((src) => !/^(https?:)?\/\//.test(src) && !src.startsWith("data:"));
  if (localImages.some((src) => !src)) issues.push("存在空的本地图片链接");
  if (localImages.length > 0 && !/<img\b/i.test(html))
    issues.push("Markdown 有图片引用，但 HTML 没有图片节点");
  return issues;
}
