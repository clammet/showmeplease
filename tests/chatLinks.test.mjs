import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { linkifyChatText } from "../lib/chatLinks.ts";
import ChatMessageText from "../app/ChatMessageText.tsx";

const links = (text) => linkifyChatText(text).filter((part) => part.href);

test("recognizes web URLs and preserves the full original message", () => {
  const text = "Read https://example.com/a?x=1&y=2#here, HTTP://example.org then www.example.net/docs.\nDone.";
  const parts = linkifyChatText(text);
  assert.equal(parts.map((part) => part.text).join(""), text);
  assert.deepEqual(links(text), [
    { text: "https://example.com/a?x=1&y=2#here", href: "https://example.com/a?x=1&y=2#here" },
    { text: "HTTP://example.org", href: "http://example.org/" },
    { text: "www.example.net/docs", href: "https://www.example.net/docs" },
  ]);
});

test("keeps balanced URL brackets while excluding surrounding punctuation", () => {
  const text = "(https://example.com/wiki/Test_(thing)). [https://[::1]:8080/a]";
  assert.deepEqual(links(text).map((part) => part.text), [
    "https://example.com/wiki/Test_(thing)", "https://[::1]:8080/a",
  ]);
  assert.equal(linkifyChatText(text).map((part) => part.text).join(""), text);
});

test("executable, local, obfuscated, and malformed URLs remain plain text", () => {
  for (const text of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\nscript:alert(1)",
    "javascript&#58;alert(1)", "javascript%3Aalert(1)",
    "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)",
    "file:///etc/passwd", "blob:https://example.com/id", "//example.com",
    "https://", "https://%", "https://example.com:invalid",
    "https://example.com\u0000.evil.test", "https://example.com\u202Eevil.test",
    "https://trusted.test\\@evil.test", "https://trusted.test@evil.test",
    "https://user:password@example.com", "name@www.example.com",
  ]) {
    assert.deepEqual(linkifyChatText(text), [{ text }], JSON.stringify(text));
  }
});

test("hostile HTML is escaped and cannot add elements or event handlers", () => {
  const text = '<img src=x onerror=alert(1)> https://example.com/" onclick="alert(1) <script>alert(1)</script>';
  const html = renderToStaticMarkup(createElement(ChatMessageText, { text }));
  assert.doesNotMatch(html, /<(?:img|script)\b/);
  assert.match(html, /&lt;img/);
  const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map(([tag]) => tag);
  assert.equal(anchors.length, 1);
  assert.doesNotMatch(anchors[0], /\son(?:click|error)=/);
  assert.match(anchors[0], /href="https:\/\/example.com\/"/);
});

test("encoded payloads remain inert URL data and query strings are escaped", () => {
  const text = "https://example.com/?a=1&payload=%22%3E%3Cscript%3Ealert(1)%3C/script%3E";
  const html = renderToStaticMarkup(createElement(ChatMessageText, { text }));
  assert.match(html, /a=1&amp;payload=/);
  assert.doesNotMatch(html, /<script\b/);
  assert.equal(links(text)[0].href, text);
});

test("every link opens a separate tab without opener access or referrer leakage", () => {
  const html = renderToStaticMarkup(createElement(ChatMessageText, {
    text: "http://example.com https://example.org www.example.net",
    tabIndex: -1,
  }));
  const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map(([tag]) => tag);
  assert.equal(anchors.length, 3);
  for (const tag of anchors) {
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
    assert.match(tag, /tabindex="-1"/);
  }
});
