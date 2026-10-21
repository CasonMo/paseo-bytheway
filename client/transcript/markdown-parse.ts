/** Markdown 块解析（纯函数，无运行时依赖：渲染器与单测共用）。 */

export type Block =
  | { kind: "image"; alt: string; url: string }
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "table"; header: string[]; rows: string[][] };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split("\n");
  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const lang = fence[1] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过闭合 fence
      blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", text: quoteLines.join("\n") });
      continue;
    }

    // 图片（整行 ![alt](url)）
    const imageLine = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imageLine) {
      flushParagraph();
      blocks.push({ kind: "image", alt: imageLine[1], url: imageLine[2] });
      i += 1;
      continue;
    }

    // 列表（简单收集连续项；暂不支持嵌套）
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i];
        const b = current.match(/^\s*[-*+]\s+(.*)$/);
        const o = current.match(/^\s*\d+[.)]\s+(.*)$/);
        if (isOrdered ? o : b || (isOrdered ? null : o)) {
          items.push((o ?? b)![1]);
          i += 1;
        } else if (/^\s{2,}\S/.test(current) && items.length > 0) {
          // 续行
          items[items.length - 1] += `\n${current.trim()}`;
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    // 表格
    const isTableRow = (value: string) => /^\s*\|.*\|\s*$/.test(value);
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushParagraph();
      const splitRow = (value: string) =>
        value
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim());
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
}
