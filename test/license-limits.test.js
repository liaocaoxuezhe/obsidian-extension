const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadModule() {
  const source = path.join(__dirname, "..", "src", "license", "license-limits.ts");
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(module, module.exports, require);
  return module.exports;
}

(async () => {
	  const {
	    FREE_PAGE_LIMIT,
	    countSelectedMarkdownPages,
	    countSelectedMarkdownPagesFromMap,
	    getPageLimitUpgradePrompt,
	    getCurrentPageLimit,
	    getPageLimitViolation,
	    getIndexCapacityPlan,
	  } = await loadModule();

  assert.strictEqual(FREE_PAGE_LIMIT, 2500);

  const items = [
    {
      id: "root",
      type: "folder",
      isChecked: true,
      children: [
        { id: "a", type: "file", path: "A.md", isChecked: true, children: [] },
        { id: "b", type: "file", path: "B.canvas", isChecked: true, children: [] },
        { id: "c", type: "file", path: "C.md", isChecked: false, children: [] },
      ],
    },
    { id: "a", type: "file", path: "A.md", isChecked: true, children: [] },
    { id: "d", type: "file", path: "nested/D.MD", isChecked: true, children: [] },
  ];

  assert.strictEqual(countSelectedMarkdownPages(items), 2);

  const staleChild = { id: "stale", type: "file", path: "stale.md", isChecked: true, children: [] };
  const currentMap = new Map([
    ["folder", { id: "folder", type: "folder", isChecked: false, children: [staleChild] }],
    ["stale", { ...staleChild, isChecked: false }],
  ]);
  assert.strictEqual(countSelectedMarkdownPagesFromMap(currentMap), 0);

  assert.strictEqual(getCurrentPageLimit({ status: "inactive" }), FREE_PAGE_LIMIT);
  assert.strictEqual(getCurrentPageLimit({ status: "active", maxPages: 500000 }), 500000);
  assert.strictEqual(getCurrentPageLimit({
    status: "active",
    maxPages: 500000,
    graceUntil: "2026-06-15T00:00:00.000Z",
  }, new Date("2026-06-14T00:00:00.000Z")), 500000);
  assert.strictEqual(getCurrentPageLimit({
    status: "active",
    maxPages: 500000,
    graceUntil: "2026-06-15T00:00:00.000Z",
  }, new Date("2026-06-16T00:00:00.000Z")), FREE_PAGE_LIMIT);
  assert.strictEqual(getCurrentPageLimit({
    status: "active",
    maxPages: 500000,
    expiresAt: "2026-06-15T00:00:00.000Z",
  }, new Date("2026-06-16T00:00:00.000Z")), FREE_PAGE_LIMIT);
  assert.deepStrictEqual(getPageLimitViolation(2501, FREE_PAGE_LIMIT), {
    selectedCount: 2501,
    limit: FREE_PAGE_LIMIT,
  });
  assert.deepStrictEqual(getPageLimitUpgradePrompt(2501, FREE_PAGE_LIMIT, "https://buy.example.com"), {
    selectedCount: 2501,
    limit: FREE_PAGE_LIMIT,
    message: "Free plan supports indexing up to 2500 Markdown pages.\nYou selected 2501 pages. Upgrade Analogy Personal to index larger vaults.",
    buyUrl: "https://buy.example.com",
    canOpenBuyUrl: true,
  });
  assert.deepStrictEqual(getPageLimitUpgradePrompt(2501, FREE_PAGE_LIMIT, "ftp://invalid.example.com"), {
    selectedCount: 2501,
    limit: FREE_PAGE_LIMIT,
    message: "Free plan supports indexing up to 2500 Markdown pages.\nYou selected 2501 pages. Upgrade Analogy Personal to index larger vaults.",
    buyUrl: "",
    canOpenBuyUrl: false,
  });
	  assert.strictEqual(getPageLimitViolation(2500, FREE_PAGE_LIMIT), null);

	  assert.deepStrictEqual(getIndexCapacityPlan({
	    indexedCount: 2495,
	    limit: 2500,
	    candidates: [
	      { id: "already-indexed.md", countsTowardLimit: false },
	      { id: "new-1.md", countsTowardLimit: true },
	      { id: "new-2.md", countsTowardLimit: true },
	      { id: "new-3.md", countsTowardLimit: true },
	      { id: "new-4.md", countsTowardLimit: true },
	      { id: "new-5.md", countsTowardLimit: true },
	      { id: "new-6.md", countsTowardLimit: true },
	    ],
	  }), {
	    allowedIds: [
	      "already-indexed.md",
	      "new-1.md",
	      "new-2.md",
	      "new-3.md",
	      "new-4.md",
	      "new-5.md",
	    ],
	    blockedIds: ["new-6.md"],
	    indexedCount: 2495,
	    limit: 2500,
	    remainingSlots: 0,
	    allowedNewCount: 5,
	    blockedNewCount: 1,
	    isLimited: true,
	  });

	  assert.deepStrictEqual(getIndexCapacityPlan({
	    indexedCount: 2500,
	    limit: 2500,
	    candidates: [
	      { id: "outdated.md", countsTowardLimit: false },
	      { id: "fresh.md", countsTowardLimit: true },
	    ],
	  }), {
	    allowedIds: ["outdated.md"],
	    blockedIds: ["fresh.md"],
	    indexedCount: 2500,
	    limit: 2500,
	    remainingSlots: 0,
	    allowedNewCount: 0,
	    blockedNewCount: 1,
	    isLimited: true,
	  });

	  console.log("License limit tests passed");
	})();
