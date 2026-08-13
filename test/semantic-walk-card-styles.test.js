"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const extensionRoot = process.cwd();
const sourceStyles = fs.readFileSync(path.join(extensionRoot, "tailwind.css"), "utf8");
const builtStyles = fs.readFileSync(path.join(extensionRoot, "styles.css"), "utf8");

function ruleBody(styles, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

test("选中语义漫游卡片只保留四周边框", () => {
  assert.doesNotMatch(sourceStyles, /\.semantic-walk-node\.is-focus::before\s*\{/);
  assert.doesNotMatch(builtStyles, /\.semantic-walk-node\.is-focus:before\{/);
});

test("语义漫游卡片标题与圆点在标题栏内垂直居中", () => {
  for (const styles of [sourceStyles, builtStyles]) {
    assert.match(ruleBody(styles, ".semantic-walk-node__source"), /align-items\s*:\s*center/);
    assert.doesNotMatch(ruleBody(styles, ".semantic-walk-node__source-mark"), /margin-top\s*:/);
  }
});

test("语义漫游入口卡片文本在卡片宽度内换行", () => {
  for (const styles of [sourceStyles, builtStyles]) {
    const card = ruleBody(styles, ".semantic-walk-empty__entries button");
    const text = ruleBody(styles, ".semantic-walk-empty__entries span");

    assert.match(card, /min-width\s*:\s*0/);
    assert.match(text, /max-width\s*:\s*100%/);
    assert.match(text, /white-space\s*:\s*normal/);
    assert.match(text, /overflow-wrap\s*:\s*anywhere/);
  }
});

test("语义搜索弹窗在宽屏扩展且在窄屏不溢出", () => {
  for (const styles of [sourceStyles, builtStyles]) {
    const picker = ruleBody(styles, ".semantic-walk-picker");
    const tabs = ruleBody(styles, ".semantic-walk-picker__tabs");
    const tabButton = ruleBody(styles, ".semantic-walk-picker__tabs button");

    assert.match(picker, /width\s*:\s*min\(520px\s*,\s*calc\(100%\s*-\s*20px\)\)/);
    assert.match(tabs, /grid-template-columns\s*:\s*repeat\(3\s*,\s*minmax\(0\s*,\s*1fr\)\)/);
    assert.match(tabButton, /min-width\s*:\s*0/);
    assert.match(tabButton, /white-space\s*:\s*normal/);
  }
});

test("语义搜索说明文案左对齐", () => {
  for (const styles of [sourceStyles, builtStyles]) {
    assert.match(ruleBody(styles, ".semantic-walk-picker__hint"), /text-align\s*:\s*left/);
  }
});

test("语义搜索输入框沿用侧边栏的边框、圆角和聚焦样式", () => {
  for (const styles of [sourceStyles, builtStyles]) {
    const input = ruleBody(styles, ".semantic-walk-picker .semantic-walk-picker__search-input");

    assert.match(input, /border\s*:\s*1px solid var\(--background-modifier-border\)/);
    assert.match(input, /border-radius\s*:\s*var\(--radius\)/);
    assert.match(input, /padding\s*:\s*8px 56px 8px 12px/);
  }
});
