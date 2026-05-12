<!--
Thanks for the PR! A few quick things to set expectations:
- Smaller, focused PRs land faster than large ones.
- Link any related issue with `Fixes #123` or `Refs #123`.
- Drop a line into CHANGELOG.md under `## [Unreleased]` for user-visible changes.
-->

## Summary

<!-- One or two sentences: what does this PR do, and why? -->

## Related issue

<!-- `Fixes #123`, `Refs #123`, or `N/A`. -->

## Changes

<!-- Bulleted list of the meaningful changes. Skip plumbing detail; reviewers will read the diff. -->

-

## Testing notes

<!-- How did you verify this? Manual repro steps, screenshots, before/after, output of `cargo check` / `npm run build`, etc. -->

-

## Checklist

- [ ] I built the app locally (`npm run tauri dev` or `npm run tauri build`) and verified the change works.
- [ ] Frontend typecheck passes (`npx tsc --noEmit`).
- [ ] Rust build passes (`cargo check --manifest-path src-tauri/Cargo.toml`).
- [ ] If I added a new `#[tauri::command]`, I registered it in `src-tauri/src/lib.rs`'s `generate_handler!`.
- [ ] If user-visible: I added a line to `CHANGELOG.md` under `## [Unreleased]`.
- [ ] If this touches `storage.rs`, `updater.rs`, `capabilities/`, or the AI assistant code path, I flagged it in the summary above.
