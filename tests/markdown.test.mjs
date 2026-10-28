import assert from "node:assert/strict";
import test from "node:test";
import { deserializeDrafts, serializeDrafts, newDocument, safeImageUrl, isMarkdownPath } from "../src/pages/markdown/model.ts";
import { deserializeNavigationSettings, isNavigationSettings } from "../src/preferences/navigationSettings.ts";

/** 两代旧导航配置保留原排序和隐藏状态，缺失 Markdown 时只追加新入口。 */
test("legacy navigation gains Markdown without changing existing choices", () => {
  for (const old of [[{ id: "terminal", visible: false }, { id: "serial", visible: true }], [{ id: "vnc", visible: false }, { id: "terminal", visible: true }, { id: "serial", visible: false }]]) {
    const restored = deserializeNavigationSettings(JSON.stringify(old));
    assert.deepEqual(restored.slice(0, old.length), old);
    assert.deepEqual(restored.at(-1), { id: "markdown", visible: true });
    assert.equal(isNavigationSettings(restored), true);
  }
  assert.equal(isNavigationSettings([{ id: "markdown", visible: true }, { id: "markdown", visible: false }]), false);
});

/** 草稿恢复保留正文、版本和服务器身份，绝不复用已失效 SSH 会话；干净文档不落盘。 */
test("drafts retain edits and server identity but clear stale SSH sessions", () => {
  const document = { ...newDocument(), path: "/notes.md", content: "# 草稿", savedContent: "old", revision: "a".repeat(43), remote: { path: "/notes.md", connectionId: "server-1", sessionId: "session-1", sessionName: "Test server" } };
  const restored = deserializeDrafts(serializeDrafts([document, newDocument()]));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].content, "# 草稿");
  assert.equal(restored[0].remote.sessionId, "");
  assert.equal(restored[0].remote.connectionId, "server-1");
  assert.equal(restored[0].revision, document.revision);
  assert.equal(deserializeDrafts(serializeDrafts([newDocument()])).length, 0);
});

/** 不可信存储中的重复标识、过大正文、异常远程目标或非 Markdown 路径不得恢复。 */
test("malformed and oversized drafts fail explicitly", () => {
  const document = { ...newDocument(), content: "draft" };
  assert.throws(() => deserializeDrafts("{"));
  assert.throws(() => deserializeDrafts(JSON.stringify([document, document])));
  assert.throws(() => deserializeDrafts(JSON.stringify([{ ...document, path: "/notes.txt" }])));
  assert.throws(() => deserializeDrafts(JSON.stringify([{ ...document, remote: {} }])));
  assert.throws(() => serializeDrafts([{ ...document, content: "字".repeat(700000) }]));
});

/** 图片只放行 HTTP(S) 和有限的位图 data URL，禁止脚本、SVG 和本机协议。 */
test("Markdown paths and image URLs enforce explicit boundaries", () => {
  assert.equal(isMarkdownPath("/notes/README.MD"), true);
  assert.equal(isMarkdownPath("/notes.txt"), false);
  assert.equal(isMarkdownPath("/notes.md\0"), false);
  assert.equal(safeImageUrl("https://example.com/image.png"), "https://example.com/image.png");
  assert.equal(safeImageUrl("data:image/png;base64,YWJj"), "data:image/png;base64,YWJj");
  for (const url of ["javascript:alert(1)", "file:///private/a.png", "data:image/svg+xml;base64,YWJj", "asset://local", "//unknown/image.png"]) assert.equal(safeImageUrl(url), "");
});
