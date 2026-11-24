#!/usr/bin/env node
'use strict';

// One-command repository configurator: updates config/repo.config.json,
// install_macos_autowatcher.sh, and README.md to point to your own GitHub repo.

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_PATH, REPO_SLUG_RE, ASSET_PREFIX_RE, loadRepoConfig } = require('./repo_config');

const REPO_ROOT = path.resolve(__dirname, '..');

function configureRepository({
    repo,
    assetPrefix = null,
    autoPublishDictRelease = null,
    repoRoot = REPO_ROOT
}) {
    if (!repo || !REPO_SLUG_RE.test(repo.trim())) {
        throw new Error(`Invalid GitHub repository slug "${repo}". Expected format: owner/repo`);
    }
    const cleanRepo = repo.trim();
    const repoName = cleanRepo.split('/')[1];
    const cfgPath = path.join(repoRoot, 'config', 'repo.config.json');
    const current = loadRepoConfig(cfgPath);
    const prevRepo = current.repo;

    const nextAssetPrefix = assetPrefix
        ? assetPrefix.trim()
        : `${repoName}-translations`;
    if (!ASSET_PREFIX_RE.test(nextAssetPrefix)) {
        throw new Error(`Invalid assetPrefix "${nextAssetPrefix}".`);
    }

    const updated = {
        ...current,
        repo: cleanRepo,
        assetPrefix: nextAssetPrefix,
        autoPublishDictRelease: typeof autoPublishDictRelease === 'boolean'
            ? autoPublishDictRelease
            : current.autoPublishDictRelease
    };
    fs.writeFileSync(cfgPath, JSON.stringify(updated, null, 2) + '\n');

    // Update macOS installer clone and tarball fallback URLs
    const macInstallerPath = path.join(repoRoot, 'install_macos_autowatcher.sh');
    if (fs.existsSync(macInstallerPath)) {
        const raw = fs.readFileSync(macInstallerPath, 'utf8');
        let next = raw.replace(
            /git clone https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git "\$DIR"/g,
            `git clone https://github.com/${cleanRepo}.git "$DIR"`
        );
        next = next.replace(
            /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/archive\/refs\/heads\/main\.tar\.gz/g,
            `https://github.com/${cleanRepo}/archive/refs/heads/main.tar.gz`
        );
        if (next !== raw) fs.writeFileSync(macInstallerPath, next);
    }

    // Update README.md, README_TW.md & docs/RELEASING.md placeholders/links if present
    for (const docName of ['README.md', 'README_TW.md', path.join('docs', 'RELEASING.md')]) {
        const docPath = path.join(repoRoot, docName);
        if (!fs.existsSync(docPath)) continue;
        let text = fs.readFileSync(docPath, 'utf8');
        text = text.split(prevRepo).join(cleanRepo);
        text = text.split('YOUR_GITHUB_USERNAME/antigravity-tw').join(cleanRepo);
        text = text.split(current.assetPrefix).join(nextAssetPrefix);
        fs.writeFileSync(docPath, text);
    }

    return updated;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const repo = args.find(a => !a.startsWith('--'));
    const prefixIdx = args.indexOf('--asset-prefix');
    const assetPrefix = prefixIdx >= 0 ? args[prefixIdx + 1] : null;
    let autoPublishDictRelease = null;
    if (args.includes('--auto-publish')) autoPublishDictRelease = true;
    if (args.includes('--pr-only')) autoPublishDictRelease = false;

    if (!repo) {
        console.error('Usage: node scripts/configure_repo.js <owner>/<repo> [--asset-prefix <prefix>] [--auto-publish|--pr-only]');
        process.exit(1);
    }
    try {
        const result = configureRepository({ repo, assetPrefix, autoPublishDictRelease });
        console.log('Configured repository successfully:');
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('[configure_repo] Error:', err.message);
        process.exit(1);
    }
}

module.exports = { configureRepository };
