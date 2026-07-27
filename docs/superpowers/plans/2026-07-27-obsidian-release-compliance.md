# Obsidian Release Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish version 1.1.8 with an embedded, runtime-materialized embedding worker, official Obsidian preflight checks, Pull Request CI, and attested GitHub Release assets.

**Architecture:** esbuild builds the worker in memory and injects its CommonJS source into `main.js`; the runtime writes and verifies a build-specific `.cjs` worker before spawning it. The public repository runs the official Obsidian ESLint plugin, TypeScript, regression tests, and production build in CI, while a tag workflow builds and attests all Release assets.

**Tech Stack:** TypeScript 5.4+, esbuild, Node.js 20, ESLint 9, `eslint-plugin-obsidianmd` 0.4.1, GitHub Actions, `actions/attest@v4`.

## Global Constraints

- Keep all dedicated tests under each project's `test/` directory.
- Preserve UTF-8 encoding for Chinese text.
- Do not expose private service implementations, environment files, internal deployment material, or payment logic.
- Do not rewrite the existing `1.1.7` tag; release these changes as `1.1.8`.
- The plugin must work when Obsidian downloads only `main.js`, `manifest.json`, and `styles.css`.
- Do not enable in-process embedding fallback by default.
- Preserve unrelated uncommitted changes in the development repository.

---

### Task 1: Embed and materialize the worker

**Files:**
- Create: `test/embedding-worker-materialization.test.js`
- Create: `test/embedding-service-safety.test.js`
- Create: `test/embedding-worker-lifecycle.test.js`
- Create: `test/fixtures/embedding-worker-fixture.cjs`
- Modify: `src/local-vector/embedding-worker-client.ts`
- Modify: `src/local-vector/embedding-service.ts`
- Modify: `main.ts`

**Interfaces:**
- Consumes: `EmbeddingWorkerClientOptions.pluginDir`, `buildId`, `execPath`.
- Produces: `EmbeddingWorkerClientOptions.workerBundleSource: string` and `UnifiedEmbeddingServiceOptions.workerBundleSource: string`.
- Produces: `EmbeddingWorkerClient.ensureMaterialized(): Promise<string>` that writes embedded source atomically.

- [ ] **Step 1: Write the failing materialization test**

Create a Node test that bundles `embedding-worker-client.ts`, constructs the real client with:

```js
const workerSource = "'use strict';\\nprocess.stdin.resume();\\n";
const client = new EmbeddingWorkerClient({
  pluginDir: tmpDir,
  buildId: "1.1.8+materialization-test",
  workerBundleSource: workerSource,
  execPath: process.execPath,
});
```

Assert `ensureMaterialized()` creates `worker/embedding-worker-1.1.8+materialization-test.cjs`, its UTF-8 contents equal the literal source, a second call reuses the same path, and cleanup leaves at most the current and previous `.cjs` worker.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node test/embedding-worker-materialization.test.js
```

Expected: FAIL because `workerBundleSource` is not consumed and the old implementation requires `workerBundlePath`.

- [ ] **Step 3: Implement source materialization**

Replace `workerBundlePath?: string` with:

```ts
workerBundleSource: string;
```

In `ensureMaterialized()`:

```ts
const source = this.options.workerBundleSource;
if (!source.trim()) {
  throw new Error("Embedded worker bundle is unavailable");
}
fs.mkdirSync(workerDir, { recursive: true });
const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
const expectedHash = this.computeSha256(Buffer.from(source, "utf8"));
fs.writeFileSync(tempPath, source, { encoding: "utf8" });
const actualHash = this.computeSha256(fs.readFileSync(tempPath));
if (actualHash !== expectedHash) {
  fs.unlinkSync(tempPath);
  throw new Error("Worker bundle SHA-256 mismatch after materialization");
}
fs.renameSync(tempPath, targetPath);
```

Change `computeSha256` to accept `string | Buffer`. Preserve cleanup and ensure temporary cleanup does not mask the original exception.

- [ ] **Step 4: Pass embedded source through the service**

Add `workerBundleSource: string` to `UnifiedEmbeddingServiceOptions`. Change `shouldTryWorker()` to test that source rather than a filesystem path, and pass it to `EmbeddingWorkerClient`.

Declare and inject the build constant from `main.ts`:

```ts
declare const __ANALOGY_EMBEDDING_WORKER_SOURCE__: string;
```

Pass:

```ts
workerBundleSource: __ANALOGY_EMBEDDING_WORKER_SOURCE__,
```

- [ ] **Step 5: Run worker tests and verify GREEN**

Run:

```bash
node test/embedding-worker-materialization.test.js
node test/embedding-service-safety.test.js
node test/embedding-worker-lifecycle.test.js
```

Expected: all pass with no leaked worker processes.

### Task 2: Build a community-installable main bundle

**Files:**
- Create: `test/community-worker-bundle.test.js`
- Modify: `esbuild.config.mjs`
- Modify: `scripts/prepare-release.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `versions.json`
- Delete: `embedding-worker.js`

**Interfaces:**
- Consumes: `src/local-vector/embedding-worker.ts`.
- Produces: esbuild define `__ANALOGY_EMBEDDING_WORKER_SOURCE__`.
- Produces: `main.js` containing worker source without an external worker Release asset.

- [ ] **Step 1: Write the failing community bundle test**

The test runs the production build and asserts:

```js
assert.ok(mainBundle.includes("[AnalogyWorker]"));
assert.ok(!fs.existsSync(path.join(root, "embedding-worker.js")));
```

It also executes the materialization test against the built-in source contract.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node test/community-worker-bundle.test.js
```

Expected: FAIL because the current build creates `embedding-worker.js`.

- [ ] **Step 3: Build the worker in memory**

Use `esbuild.build()` with `write: false`, `platform: "node"`, `format: "cjs"`, the same external runtime modules, and `src/local-vector/embedding-worker.ts` as the single entry point. Reject an empty output.

Change the main context to a single `main.ts` entry and inject:

```js
define: {
  __ANALOGY_BUILD_ID__: JSON.stringify(buildId),
  __ANALOGY_EMBEDDING_WORKER_SOURCE__: JSON.stringify(workerSource),
}
```

Delete stale root worker output at build startup. Record `embeddedWorkerSha256` in build metadata instead of worker file hashes. Stop copying a worker file into build archives and local plugin directories.

- [ ] **Step 4: Bump metadata and remove the worker from release preparation**

Update `package.json`, `package-lock.json`, `manifest.json`, and `versions.json` to 1.1.8 while preserving `minAppVersion` 1.12.7. Remove `embedding-worker.js` from the runtime file list and archive copy operations. Ensure `release/1.1.8` is complete without it and leave the historical `release/1.1.7` directory unchanged.

- [ ] **Step 5: Run bundle and release tests**

Run:

```bash
node test/community-worker-bundle.test.js
npm run release:prepare
node test/release-integrity.test.js
```

Expected: `main.js` contains the worker marker, no standalone worker is generated, and release integrity passes.

### Task 3: Add official Obsidian lint and TypeScript checks

**Files:**
- Create: `eslint.config.mjs`
- Delete: `.eslintrc`
- Modify: `.eslintignore` or remove it after moving ignores into flat config
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `src/SettingView.tsx`
- Modify: `src/diagnostics/diagnostic-recorder.ts`
- Modify: `src/diagnostics/diagnostic-storage.ts`
- Modify: additional source files only when required by blocking lint or type errors

**Interfaces:**
- Produces: `npm run lint`, `npm run typecheck`, and `npm run check`.

- [ ] **Step 1: Install the official checker toolchain**

Install exact compatible development dependencies:

```bash
npm install --save-dev eslint@^9.19.0 eslint-plugin-obsidianmd@0.4.1 typescript@^5.4.5 typescript-eslint@^8.35.1 @typescript-eslint/parser@^8.35.1
```

- [ ] **Step 2: Add flat ESLint configuration**

Use `obsidianmd.configs.recommended`, the TypeScript parser with `project: "./tsconfig.json"`, project globals for build constants, and ignores for generated bundles, release archives, dependencies, artifacts, caches, and test fixtures.

Keep warnings as warnings. Do not disable official error rules or `no-console` through directive comments.

- [ ] **Step 3: Remove all seven blocking directives**

Delete the two `no-undef` directives in `SettingView.tsx` and five `no-console` directives in diagnostics. Keep non-blocking fallback behavior without recursive diagnostic logging.

- [ ] **Step 4: Add scripts and run lint**

Add:

```json
"lint": "eslint main.ts src manifest.json LICENSE",
"typecheck": "tsc --noEmit",
"test:public": "node test/embedding-worker-materialization.test.js && node test/embedding-service-safety.test.js && node test/embedding-worker-lifecycle.test.js && node test/community-worker-bundle.test.js && node test/release-integrity.test.js",
"check": "npm run lint && npm run typecheck && npm run test:public && npm run build"
```

Run:

```bash
npm run lint
```

Expected: exit 0 with no error-level findings. Warning-level Obsidian recommendations may remain.

- [ ] **Step 5: Run typecheck and fix real errors**

Include both `**/*.ts` and `**/*.tsx`, exclude generated/release/test directories, then run:

```bash
npm run typecheck
```

Expected: exit 0. Fix type errors without weakening strictness further or adding blanket suppressions.

### Task 4: Add Pull Request CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm run lint`, `npm run typecheck`, `npm run test:public`, `npm run build`.
- Produces: required CI result named `validate`.

- [ ] **Step 1: Add the validation workflow**

Trigger on Pull Requests and pushes to `main`. Use `actions/checkout@v7`, `actions/setup-node@v7`, Node 20, npm cache, and:

```yaml
- run: npm ci
- run: npm run lint
- run: npm run typecheck
- run: npm run test:public
- run: npm run build
```

Set default permissions to `contents: read`.

- [ ] **Step 2: Validate workflow syntax**

Parse the YAML locally and run `actionlint` when available. Check that `npm ci` uses the committed lockfile and every referenced script exists.

### Task 5: Add attested Release automation

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `scripts/verify-release-version.mjs`
- Modify: `scripts/prepare-release.mjs`
- Create: `release/1.1.8/**`

**Interfaces:**
- Produces: `node scripts/verify-release-version.mjs <tag>`.
- Produces: tag-triggered and manually dispatchable Release build.

- [ ] **Step 1: Write the failing version verification test**

Create `test/release-version.test.js` that runs the verifier against matching `1.1.8` metadata and asserts success, then runs `1.1.9` and asserts a non-zero exit with a clear mismatch message.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node test/release-version.test.js
```

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement version verification**

Implement the verifier with JSON parsing and exact equality across tag, package, manifest, and `versions.json`. It must reject a leading `v` because Obsidian release tags are exact bare versions such as `1.1.8`.

- [ ] **Step 4: Add Release workflow**

Trigger on tags matching `*.*.*` and `workflow_dispatch` with a required `tag` input. Checkout the requested tag, run the complete validation, prepare `release/1.1.8`, create the full runtime zip, and generate provenance:

```yaml
- uses: actions/attest@v4
  with:
    subject-path: |
      release-assets/main.js
      release-assets/manifest.json
      release-assets/styles.css
      release-assets/analogy-${{ steps.version.outputs.tag }}-full-runtime.zip
```

Use job permissions:

```yaml
contents: write
id-token: write
attestations: write
artifact-metadata: write
```

Use `gh release view` to choose between `gh release create` and `gh release upload --clobber`. Never upload standalone `embedding-worker.js`.

- [ ] **Step 5: Run release verification**

Run:

```bash
node test/release-version.test.js
npm run release:prepare
node scripts/verify-release-version.mjs 1.1.8
```

Expected: all pass and `release/1.1.8` contains no standalone worker.

### Task 6: Synchronize, scan, verify, and review

**Files:**
- Modify matching worker source and build files in the local development source repository
- Preserve all unrelated development-repository changes

**Interfaces:**
- Consumes: verified public implementation.
- Produces: identical worker behavior in both source trees.

- [ ] **Step 1: Apply matching source changes to the development repository**

Patch only the agreed worker, build, version, and directive locations. Do not overwrite the development repository's `package.json`, lockfile, README, private modules, or unrelated modified hunks.

- [ ] **Step 2: Run development repository worker regressions**

Run the three worker tests and production build from the development repository. Confirm existing unrelated modifications remain present.

- [ ] **Step 3: Run the full public verification**

Run:

```bash
npm run check
node scripts/verify-release-version.mjs 1.1.8
git diff --check
```

- [ ] **Step 4: Scan public tracked content**

Run the sync-notes sensitive-content scan over tracked files, exclude the local sync note itself, and inspect every hit before committing.

- [ ] **Step 5: Commit implementation**

Stage only reviewed public files and commit with a message describing embedded worker distribution, official preflight CI, and attested releases.

- [ ] **Step 6: Request code review**

Review the diff from the design commit through the implementation commit for security, worker lifecycle correctness, GitHub Actions permissions, Release asset provenance, and accidental sensitive-content inclusion. Fix all critical and important findings, then rerun `npm run check`.
