const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule(entry) {
  const source = path.join(__dirname, "..", "src", "diagnostics", entry);
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["obsidian"],
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

function collectButtons(node, buttons = []) {
  if (!node || typeof node !== "object") return buttons;
  if (node.type === "button") buttons.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) {
    children.forEach((child) => collectButtons(child, buttons));
  } else {
    collectButtons(children, buttons);
  }
  return buttons;
}

function childText(node) {
  const children = node.props?.children;
  if (Array.isArray(children)) return children.join("");
  return String(children || "");
}

(async () => {
  const { AnalogyErrorBoundary } = await loadModule("AnalogyErrorBoundary.tsx");
  const actions = {
    copy: 0,
    reload: 0,
    settings: 0,
    report: 0,
  };
  const boundary = new AnalogyErrorBoundary({
    children: null,
    recorder: { captureException() {} },
    viewName: "test",
    onCopyReport: () => {
      actions.copy += 1;
    },
    onReload: () => {
      actions.reload += 1;
    },
    onOpenSettings: () => {
      actions.settings += 1;
    },
    onSendReport: () => {
      actions.report += 1;
    },
  });
  boundary.state = { hasError: true, errorId: "error-1" };
  boundary.setState = (nextState) => {
    boundary.state = { ...boundary.state, ...nextState };
  };

  const buttons = collectButtons(boundary.render());
  assert.strictEqual(buttons.length, 4, "fallback must expose four recovery actions");

  const expectedActions = [
    ["复制诊断", "copy"],
    ["重新加载", "reload"],
    ["打开设置", "settings"],
    ["发送报告", "report"],
  ];
  for (const [label, action] of expectedActions) {
    const button = buttons.find((candidate) => childText(candidate).includes(label));
    assert(button, `missing ${label} action`);
    button.props.onClick();
    assert.strictEqual(actions[action], 1, `${label} action must invoke its callback`);
  }

  console.log("Error boundary action tests passed");
})();
