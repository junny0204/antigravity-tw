# Third-Party Notices & Upstream Attribution

This project is a derivative localization suite built under the MIT License, combining work from the following open-source upstream projects:

1. **qqxpee/antigravity2-cn** (`https://github.com/qqxpee/antigravity2-cn`)
   - License: MIT License (Copyright (c) 2026 qqxpee)
   - Contribution: Core zero-dependency Electron ASAR patcher, main-process patches, frontend preload DOM isolation engine, and base Simplified/Traditional Chinese dictionaries.

2. **atonnyshen/antigravity2-TW** (`https://github.com/atonnyshen/antigravity2-TW`)
   - License: MIT License (Copyright (c) 2026 atonnyshen)
   - Contribution: Taiwan Traditional Chinese (zh-TW) IT terminology alignment, declarative `rules/runtime_rules.json` schema, atomic ASAR replacement (`ReplaceFileW` / `renamex_np`), cross-platform Windows/macOS background auto-watcher, SHA-256 verified translation-pack updater, and regression test suites.

This repository adds automated upstream synchronization (`scripts/sync_upstream.js`), configurable repository targeting (`config/repo.config.json`), declarative Taiwan glossary normalization (`config/tw_glossary.json`), personal override layering (`config/tw_overrides.json`), and GitHub Actions automation (`.github/workflows/sync-upstream.yml`).
