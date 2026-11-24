'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'repo.config.json');

const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ASSET_PREFIX_RE = /^[A-Za-z0-9_.-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const DEFAULT_CONFIG = Object.freeze({
    repo: 'YOUR_GITHUB_USERNAME/antigravity-tw',
    assetPrefix: 'antigravity-tw-translations',
    engineVersion: '1.0.0',
    minEngineVersion: '1.0.0',
    maxEngineVersion: '1.0.0',
    autoPublishDictRelease: true,
    upstreams: {
        qqxpee: { repo: 'qqxpee/antigravity2-cn', branch: 'main' },
        atonnyshen: { repo: 'atonnyshen/antigravity2-TW', branch: 'main' }
    }
});

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadRepoConfig(configPath = CONFIG_PATH) {
    let raw = {};
    if (fs.existsSync(configPath)) {
        const stat = fs.lstatSync(configPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Unsafe repo config path: ${configPath}`);
        }
        raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    const repo = typeof raw.repo === 'string' && REPO_SLUG_RE.test(raw.repo.trim())
        ? raw.repo.trim()
        : DEFAULT_CONFIG.repo;
    const assetPrefix = typeof raw.assetPrefix === 'string' && ASSET_PREFIX_RE.test(raw.assetPrefix.trim())
        ? raw.assetPrefix.trim()
        : DEFAULT_CONFIG.assetPrefix;
    const engineVersion = typeof raw.engineVersion === 'string' && SEMVER_RE.test(raw.engineVersion.trim())
        ? raw.engineVersion.trim()
        : DEFAULT_CONFIG.engineVersion;
    const minEngineVersion = typeof raw.minEngineVersion === 'string' && SEMVER_RE.test(raw.minEngineVersion.trim())
        ? raw.minEngineVersion.trim()
        : engineVersion;
    const maxEngineVersion = typeof raw.maxEngineVersion === 'string' && SEMVER_RE.test(raw.maxEngineVersion.trim())
        ? raw.maxEngineVersion.trim()
        : engineVersion;

    return {
        repo,
        assetPrefix,
        engineVersion,
        minEngineVersion,
        maxEngineVersion,
        autoPublishDictRelease: raw.autoPublishDictRelease !== false,
        upstreams: raw.upstreams && typeof raw.upstreams === 'object'
            ? raw.upstreams
            : DEFAULT_CONFIG.upstreams
    };
}

function getTranslationAssetName(releaseTag, configPath = CONFIG_PATH) {
    const { assetPrefix } = loadRepoConfig(configPath);
    return `${assetPrefix}-${releaseTag}.zip`;
}

module.exports = {
    CONFIG_PATH,
    REPO_SLUG_RE,
    ASSET_PREFIX_RE,
    SEMVER_RE,
    escapeRegExp,
    loadRepoConfig,
    getTranslationAssetName
};
