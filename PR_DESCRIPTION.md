**Title:** fix: use correct Argon2 default params (m=19456,t=2,p=1) for existing vault compatibility

## Summary

Fixes a regression from PR #198 where the explicit Argon2 params didn't match what `Argon2::default()` actually produces, breaking decryption of all existing vault credentials.

## Related issue

Refs #15, #198.

## Changes

**Root cause**: `Argon2::default()` in the argon2 0.5.3 crate produces `m=19456 KiB, t=2, p=1`, but PR #198 replaced it with `Params::new(65536, 3, 4, None)`. The mismatched parameters generate a completely different encryption key, so all vault data encrypted before the PR merged fails to decrypt — credentials appear as encrypted ciphertext instead of plaintext.

**Fix**: Changed to `Params::new(19456, 2, 1, None)` which exactly matches the actual argon2 0.5.3 defaults. The parameters remain explicitly locked (per #15's original intent) — just with the correct values.

## Testing notes

- Verified `cargo check` passes.
- Verified `npx tsc --noEmit` passes.
- Manually tested:
  - Existing vault credentials (created before PR #198 merge) decrypt correctly after fix.
  - New vault credentials encrypt and decrypt correctly.
  - Both vault-password and no-password vaults work.

## Checklist

- [x] Frontend typecheck passes (`npx tsc --noEmit`).
- [x] Rust build passes (`cargo check --manifest-path src-tauri/Cargo.toml`).
- [x] If I added a new `#[tauri::command]`, I registered it in `src-tauri/src/lib.rs`'s `generate_handler!`. *(None added)*
- [x] If user-visible: I added a line to `CHANGELOG.md` under `## [Unreleased]`.
- [x] If this touches `storage.rs`, `updater.rs`, `capabilities/`, or the AI assistant code path, I flagged it in the summary above.
