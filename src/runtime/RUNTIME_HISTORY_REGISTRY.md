# Runtime history binding registry

Runtime history cleanup accepts only an immutable installation pointer whose runtime ID,
kind, platform and archive SHA-256 are present in the version-controlled registry exposed by
`runtime-manifest.ts`.

The first managed-runtime release has no earlier released managed assets, so the retained
registry starts empty. When a release replaces or removes an active runtime asset, the release
change must copy that asset's exact `id`, `kind`, `platform` and `sha256` into
`RUNTIME_HISTORY_BINDING_REGISTRY.retained`. Never reconstruct, guess, or relabel a fixture as a
published asset. Registry entries remain immutable so an older installation pointer can still be
recognized and safely moved to quarantine.

Release checklist:

1. Copy every superseded active binding into `retained` before changing the active manifest.
2. Keep existing retained bindings byte-for-byte unchanged.
3. Add tests using `createRuntimeHistoryAssetResolver` that prove the superseded binding is
   accepted only on its original platform and only with its exact SHA-256.
4. Verify unknown IDs, conflicting duplicates, and changed SHA-256 values fail closed.

Cleanup first moves a validated runtime synchronously into the private quarantine. If moving the
quarantine item to the system trash fails, `listRuntimeCleanupRecoveries()` exposes a path-free
retained recovery inventory so the failure is visible without leaking device-local paths.
