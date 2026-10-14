# Runtime history binding registry

Runtime history cleanup accepts only an immutable installation pointer whose runtime ID,
kind, platform and archive SHA-256 are present in the version-controlled registry exposed by
`runtime-manifest.ts`.

Managed runtimes are versioned per platform (`runtime-package/platform-versions.json`), so a
release can replace the runtime of one platform while the others keep their published version.
When a release replaces or removes an active runtime asset, the release change must copy that
asset's exact `id`, `kind`, `platform` and `sha256` into
`RUNTIME_HISTORY_BINDING_REGISTRY.retained`. Never reconstruct, guess, or relabel a fixture as a
published asset. Registry entries remain immutable so an older installation pointer can still be
recognized and safely moved to quarantine.

A retained binding has two effects:

1. Environment detection reports an installed runtime that matches it exactly (id, archive
   SHA-256 and versioned install path) as `upgradable` instead of `corrupt`, and onboarding shows a
   dedicated "upgrade the inference engine" consent with the download size.
2. After the upgrade reaches `ready`, the superseded version goes through the normal trusted
   history cleanup (quarantine, then system trash).

Retained bindings:

| Runtime ID | Platform | Superseded by | Reason |
|---|---|---|---|
| `embedding-runtime-node22-v1-win32-x64` | `win32-x64` | `node22-v2` | v2 bundles the Visual C++ runtime app-local and strips the delay-loaded DirectML files |

Release checklist:

1. Copy every superseded active binding into `retained` before changing the active manifest.
2. Keep existing retained bindings byte-for-byte unchanged.
3. Add tests using `createRuntimeHistoryAssetResolver` / `createRetainedRuntimeAssetResolver` that
   prove the superseded binding is accepted only on its original platform and only with its exact
   SHA-256.
4. Verify unknown IDs, conflicting duplicates, and changed SHA-256 values fail closed.

Cleanup first moves a validated runtime synchronously into the private quarantine. If moving the
quarantine item to the system trash fails, `listRuntimeCleanupRecoveries()` exposes a path-free
retained recovery inventory so the failure is visible without leaking device-local paths.
