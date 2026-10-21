import { describe, expect, it } from "vitest";
import { parseBlocks } from "./markdown-parse";

describe("markdown 解析", () => {
  it("整行图片语法解析为 image block", () => {
    const blocks = parseBlocks("看一下：\n\n![Image](file:///tmp/a.png)\n\n好的");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "看一下：" },
      { kind: "image", alt: "Image", url: "file:///tmp/a.png" },
      { kind: "paragraph", text: "好的" },
    ]);
  });

  it("含空格的 file URL 同样解析", () => {
    const blocks = parseBlocks("![Image](file:///Users/x/Mobile Documents/a b.png)");
    expect(blocks[0]).toEqual({
      kind: "image",
      alt: "Image",
      url: "file:///Users/x/Mobile Documents/a b.png",
    });
  });

  it("标题与代码块", () => {
    const blocks = parseBlocks("# 标题\n\n```ts\nconst a = 1;\n```");
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, text: "标题" });
    expect(blocks[1]).toEqual({ kind: "code", lang: "ts", code: "const a = 1;" });
  });
});
