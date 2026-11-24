#!/usr/bin/env node
'use strict';

// Zero-dependency upstream synchronization & Taiwan Traditional Chinese (zh-TW)
// terminology normalization engine.
//
// Merge priority (highest wins):
//   1. Personal overrides (config/tw_overrides.json)
//   2. Curated Taiwan localization (atonnyshen/antigravity2-TW)
//   3. Upstream base + automatic Taiwan glossary normalization (qqxpee/antigravity2-cn)
//
// Safety rule:
//   Executable JS files (localization_engine.js, src/*.js) are NEVER automatically
//   overwritten. Changes to upstream engine files are detected via SHA-256 hashes
//   and surfaced in the report so GitHub Actions opens a PR for human review.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { loadRepoConfig } = require('./repo_config');
const {
    compareDicts,
    validateTraditionalText,
    normalizeText
} = require('./compare_dicts');
const { validateRuntimeRulesObject } = require('../src/rules_schema');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENGINE_WATCH_FILES = [
    'localization_engine.js',
    'src/asar_patcher.js',
    'src/main_patches.js',
    'src/preload_runtime.js'
];
const DICT_FILES = [
    'common.json',
    'menu_nav.json',
    'page_agents.json',
    'page_main.json',
    'page_mcp_knowledge.json',
    'page_settings.json'
];
const RESERVED_SLASH_COMMANDS = new Set([
    'goal', 'swarm', 'boost', 'egm-boost', 'learn', 'compact', 'btw', 'grill-me', 'teamwork',
    'schedule', 'plan', 'browser', 'automation', 'plugin', 'clear', 'help', 'init', 'review',
    'split', 'commit', 'reset', 'stop', 'status', 'filter', 'teamwork-preview',
    'antigravity-guide', 'agy-customizations', 'generative_ui', 'migrate-workflows',
    'permissioned-github', 'ui-extension', 'ui-plugin-navigation'
]);
const PROTECTED_MODEL_EFFORT_KEYS = new Set([
    'Low', 'Medium', 'High', 'Extra', 'Max', 'Thinking Effort', 'Thinking effort'
]);

function sha256Text(text) {
    return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function bumpPatchSemver(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
    if (!m) return '1.0.1';
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function loadJsonIfExists(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function applyTwGlossary(text, glossary) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    if (glossary && Array.isArray(glossary.exactReplacements)) {
        for (const pair of glossary.exactReplacements) {
            if (!Array.isArray(pair) || pair.length !== 2) continue;
            const [from, to] = pair;
            if (from && out.includes(from)) {
                out = out.split(from).join(to);
            }
        }
    }
    if (glossary && Array.isArray(glossary.regexReplacements)) {
        for (const item of glossary.regexReplacements) {
            if (!item || typeof item.pattern !== 'string' || typeof item.replacement !== 'string') continue;
            const re = new RegExp(item.pattern, item.flags || 'g');
            out = out.replace(re, item.replacement);
        }
    }
    return out;
}

function compilePersonalOverrides(overrides) {
    const termReplacements = overrides && overrides.termReplacements && typeof overrides.termReplacements === 'object'
        ? Object.entries(overrides.termReplacements)
            .filter(([k, v]) => typeof k === 'string' && k.length > 0 && typeof v === 'string')
            .sort((a, b) => b[0].length - a[0].length)
        : [];
    const exactOverrides = overrides && overrides.exactOverrides && typeof overrides.exactOverrides === 'object'
        ? overrides.exactOverrides
        : {};
    const allowedTerms = overrides && Array.isArray(overrides.allowForbiddenTerms)
        ? new Set(overrides.allowForbiddenTerms.filter(t => typeof t === 'string' && t.length > 0))
        : null;
    return { termReplacements, exactOverrides, allowedTerms };
}

function applyPersonalOverrideToValue(key, val, compiled) {
    if (typeof compiled.exactOverrides[key] === 'string' && compiled.exactOverrides[key].trim() !== '') {
        return compiled.exactOverrides[key];
    }
    let out = val;
    for (const [from, to] of compiled.termReplacements) {
        if (typeof out === 'string' && out.includes(from)) {
            out = out.split(from).join(to);
        }
    }
    return out;
}

function applyPersonalOverrides(dictsTwByFile, overrides) {
    if (!overrides || typeof overrides !== 'object') return;
    const compiled = compilePersonalOverrides(overrides);
    for (const file of Object.keys(dictsTwByFile)) {
        const obj = dictsTwByFile[file];
        for (const key of Object.keys(obj)) {
            obj[key] = applyPersonalOverrideToValue(key, obj[key], compiled);
        }
    }
}

function isProtectedKey(key) {
    if (/^\/[a-zA-Z0-9_.:-]+$/.test(key)) return true;
    if (RESERVED_SLASH_COMMANDS.has(key)) return true;
    if (PROTECTED_MODEL_EFFORT_KEYS.has(key)) return true;
    return false;
}

function githubHeaders() {
    const headers = {
        'User-Agent': 'antigravity-tw-upstream-sync',
        'Accept': 'application/vnd.github.v3+json'
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function fetchJson(url) {
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return res.json();
}

async function fetchText(url) {
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return res.text();
}

async function loadUpstreamFromLocal(dir, { includeEngineHashes = false, includeRules = false } = {}) {
    const dicts = {};
    const dictsTw = {};
    for (const file of DICT_FILES) {
        const scPath = path.join(dir, 'dicts', file);
        const twPath = path.join(dir, 'dicts_tw', file);
        dicts[file] = fs.existsSync(scPath) ? JSON.parse(fs.readFileSync(scPath, 'utf8')) : {};
        dictsTw[file] = fs.existsSync(twPath) ? JSON.parse(fs.readFileSync(twPath, 'utf8')) : {};
    }
    const engineHashes = {};
    if (includeEngineHashes) {
        for (const rel of ENGINE_WATCH_FILES) {
            const fp = path.join(dir, rel);
            if (fs.existsSync(fp)) {
                engineHashes[rel] = sha256Text(fs.readFileSync(fp, 'utf8'));
            }
        }
    }
    let runtimeRules = null;
    if (includeRules) {
        const rp = path.join(dir, 'rules', 'runtime_rules.json');
        if (fs.existsSync(rp)) {
            runtimeRules = JSON.parse(fs.readFileSync(rp, 'utf8'));
        }
    }
    let sha = 'local';
    try {
        const { execFileSync } = require('node:child_process');
        sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {}
    return { sha, dicts, dictsTw, engineHashes, runtimeRules };
}

async function loadUpstreamFromGitHub(repoSlug, branch = 'main', { includeEngineHashes = false, includeRules = false } = {}) {
    const commitInfo = await fetchJson(`https://api.github.com/repos/${repoSlug}/commits/${encodeURIComponent(branch)}`);
    const sha = commitInfo.sha;
    const rawBase = `https://raw.githubusercontent.com/${repoSlug}/${sha}`;

    const dicts = {};
    const dictsTw = {};
    await Promise.all(DICT_FILES.map(async (file) => {
        const [scText, twText] = await Promise.all([
            fetchText(`${rawBase}/dicts/${file}`),
            fetchText(`${rawBase}/dicts_tw/${file}`)
        ]);
        dicts[file] = JSON.parse(scText);
        dictsTw[file] = JSON.parse(twText);
    }));

    const engineHashes = {};
    if (includeEngineHashes) {
        await Promise.all(ENGINE_WATCH_FILES.map(async (rel) => {
            const text = await fetchText(`${rawBase}/${rel}`);
            engineHashes[rel] = sha256Text(text);
        }));
    }

    let runtimeRules = null;
    if (includeRules) {
        try {
            const text = await fetchText(`${rawBase}/rules/runtime_rules.json`);
            runtimeRules = JSON.parse(text);
        } catch {}
    }

    return { sha, dicts, dictsTw, engineHashes, runtimeRules };
}

function applyPersonalOverridesToRules(rulesObj, overrides) {
    if (!rulesObj || typeof rulesObj !== 'object' || !overrides || typeof overrides !== 'object') return;
    const termReplacements = overrides.termReplacements && typeof overrides.termReplacements === 'object'
        ? Object.entries(overrides.termReplacements)
            .filter(([k, v]) => typeof k === 'string' && k.length > 0 && typeof v === 'string')
            .sort((a, b) => b[0].length - a[0].length)
        : [];
    if (termReplacements.length === 0) return;

    const replaceTw = (text) => {
        if (typeof text !== 'string') return text;
        let out = text;
        for (const [from, to] of termReplacements) {
            if (out.includes(from)) out = out.split(from).join(to);
        }
        return out;
    };

    if (rulesObj.scopedMaps && typeof rulesObj.scopedMaps === 'object') {
        for (const scope of Object.values(rulesObj.scopedMaps)) {
            if (!scope || typeof scope !== 'object') continue;
            for (const pair of Object.values(scope)) {
                if (pair && typeof pair.tw === 'string') pair.tw = replaceTw(pair.tw);
            }
        }
    }
    for (const section of ['dynamicRules', 'attrDynamicRules']) {
        if (Array.isArray(rulesObj[section])) {
            for (const rule of rulesObj[section]) {
                if (rule && typeof rule.tw === 'string') rule.tw = replaceTw(rule.tw);
            }
        }
    }
}

function mergeRuntimeRules(currentRules, upstreamRules, overrides = null) {
    const base = upstreamRules
        ? JSON.parse(JSON.stringify(upstreamRules))
        : JSON.parse(JSON.stringify(currentRules || {}));

    // Preserve any local dynamicRules ids not yet in upstream (e.g. available-for-project)
    if (currentRules && Array.isArray(currentRules.dynamicRules)) {
        if (!Array.isArray(base.dynamicRules)) base.dynamicRules = [];
        const existingIds = new Set(base.dynamicRules.map(r => r.id));
        for (const rule of currentRules.dynamicRules) {
            if (rule && rule.id && !existingIds.has(rule.id)) {
                base.dynamicRules.push(rule);
                existingIds.add(rule.id);
            }
        }
    }
    applyPersonalOverridesToRules(base, overrides);
    validateRuntimeRulesObject(base);
    return base;
}

function mergeDictionaries({ qqxpee, atonnyshen, glossary, overrides }) {
    const mergedSc = {};
    const mergedTw = {};
    const seenRaw = new Set();
    const seenNorm = new Set();
    const addedFromQqxpee = [];
    const skippedNeedsReview = [];

    for (const file of DICT_FILES) {
        mergedSc[file] = {};
        mergedTw[file] = {};
    }

    // Pass 1: Curated Taiwan localization from atonnyshen (preserves all 318+ Taiwan fixes & extra entries)
    for (const file of DICT_FILES) {
        const aSc = (atonnyshen && atonnyshen.dicts && atonnyshen.dicts[file]) || {};
        const aTw = (atonnyshen && atonnyshen.dictsTw && atonnyshen.dictsTw[file]) || {};
        for (const key of Object.keys(aTw)) {
            if (isProtectedKey(key)) continue;
            if (seenRaw.has(key)) continue;
            const norm = normalizeText(key);
            if (norm && seenNorm.has(norm)) continue;
            const scVal = typeof aSc[key] === 'string' && aSc[key].trim() ? aSc[key] : aTw[key];
            const twVal = aTw[key];
            if (typeof twVal !== 'string' || !twVal.trim()) continue;
            mergedSc[file][key] = scVal;
            mergedTw[file][key] = twVal;
            seenRaw.add(key);
            if (norm) seenNorm.add(norm);
        }
    }

    const compiledOverrides = compilePersonalOverrides(overrides);

    // Pass 2: Net-new entries from qqxpee/antigravity2-cn, normalized with Taiwan glossary + personal overrides
    for (const file of DICT_FILES) {
        const qSc = (qqxpee && qqxpee.dicts && qqxpee.dicts[file]) || {};
        const qTw = (qqxpee && qqxpee.dictsTw && qqxpee.dictsTw[file]) || {};
        for (const key of Object.keys(qSc)) {
            if (isProtectedKey(key)) continue;
            if (seenRaw.has(key)) continue;
            const norm = normalizeText(key);
            if (norm && seenNorm.has(norm)) continue;
            const scVal = qSc[key];
            if (typeof scVal !== 'string' || !scVal.trim()) continue;
            const rawTw = typeof qTw[key] === 'string' && qTw[key].trim() ? qTw[key] : scVal;
            const glossaryTw = applyTwGlossary(rawTw, glossary);
            const candidateTw = applyPersonalOverrideToValue(key, glossaryTw, compiledOverrides);

            // Validate before admitting automatically; capture anything that still needs human review
            const ok = validateTraditionalText(
                candidateTw,
                `sync-candidate ${file}["${key}"]`,
                compiledOverrides.allowedTerms
            );
            if (!ok) {
                skippedNeedsReview.push({ file, key, sc: scVal, candidateTw });
                continue;
            }

            mergedSc[file][key] = scVal;
            mergedTw[file][key] = candidateTw;
            seenRaw.add(key);
            if (norm) seenNorm.add(norm);
            addedFromQqxpee.push({ file, key, tw: candidateTw });
        }
    }

    // Pass 3: User's personal terminology overrides (always win across Pass 1 & Pass 2)
    applyPersonalOverrides(mergedTw, overrides);

    return { mergedSc, mergedTw, addedFromQqxpee, skippedNeedsReview };
}

function stringifyStableJson(obj) {
    return JSON.stringify(obj, null, 2) + '\n';
}

function diffEngineHashes(prevHashes = {}, nextHashes = {}) {
    const changedFiles = [];
    for (const rel of ENGINE_WATCH_FILES) {
        if (prevHashes[rel] && nextHashes[rel] && prevHashes[rel] !== nextHashes[rel]) {
            changedFiles.push(rel);
        }
    }
    return changedFiles;
}

async function runSync({
    repoRoot = REPO_ROOT,
    write = false,
    bumpTranslationVersion = false,
    qqxpeeDir = null,
    atonnyshenDir = null,
    reportPath = null
} = {}) {
    const configPath = path.join(repoRoot, 'config', 'repo.config.json');
    const glossaryPath = path.join(repoRoot, 'config', 'tw_glossary.json');
    const overridesPath = path.join(repoRoot, 'config', 'tw_overrides.json');
    const statePath = path.join(repoRoot, 'config', 'upstream_state.json');

    const repoConfig = loadRepoConfig(configPath);
    const glossary = loadJsonIfExists(glossaryPath, {});
    const overrides = loadJsonIfExists(overridesPath, {});
    const prevState = loadJsonIfExists(statePath, null);
    const pkg = loadJsonIfExists(path.join(repoRoot, 'package.json'), { version: '1.0.0' });

    const qqxpee = qqxpeeDir
        ? await loadUpstreamFromLocal(qqxpeeDir, { includeEngineHashes: true })
        : await loadUpstreamFromGitHub(
            repoConfig.upstreams.qqxpee.repo,
            repoConfig.upstreams.qqxpee.branch || 'main',
            { includeEngineHashes: true }
        );

    const atonnyshen = atonnyshenDir
        ? await loadUpstreamFromLocal(atonnyshenDir, { includeRules: true })
        : await loadUpstreamFromGitHub(
            repoConfig.upstreams.atonnyshen.repo,
            repoConfig.upstreams.atonnyshen.branch || 'main',
            { includeRules: true }
        );

    const { mergedSc, mergedTw, addedFromQqxpee, skippedNeedsReview } = mergeDictionaries({
        qqxpee,
        atonnyshen,
        glossary,
        overrides
    });

    const currentRulesPath = path.join(repoRoot, 'rules', 'runtime_rules.json');
    const currentRules = loadJsonIfExists(currentRulesPath, null);
    const mergedRules = mergeRuntimeRules(currentRules, atonnyshen.runtimeRules, overrides);

    // Validate complete candidate in temp dir before touching real repo files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtw-sync-verify-'));
    let validationOk = false;
    try {
        fs.mkdirSync(path.join(tmpDir, 'dicts'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'dicts_tw'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'rules'), { recursive: true });
        for (const file of DICT_FILES) {
            fs.writeFileSync(path.join(tmpDir, 'dicts', file), stringifyStableJson(mergedSc[file]));
            fs.writeFileSync(path.join(tmpDir, 'dicts_tw', file), stringifyStableJson(mergedTw[file]));
        }
        fs.writeFileSync(path.join(tmpDir, 'rules', 'runtime_rules.json'), stringifyStableJson(mergedRules));
        const compiledOverridesForCheck = compilePersonalOverrides(overrides);
        validationOk = compareDicts(
            path.join(tmpDir, 'dicts'),
            path.join(tmpDir, 'dicts_tw'),
            path.join(tmpDir, 'rules'),
            { allowedTerms: compiledOverridesForCheck.allowedTerms }
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    if (!validationOk) {
        throw new Error('Merged dictionaries failed Taiwan terminology validation; aborting sync write.');
    }

    // Detect actual content changes vs current repo files
    const changedDictFiles = [];
    for (const file of DICT_FILES) {
        const scPath = path.join(repoRoot, 'dicts', file);
        const twPath = path.join(repoRoot, 'dicts_tw', file);
        const nextSc = stringifyStableJson(mergedSc[file]);
        const nextTw = stringifyStableJson(mergedTw[file]);
        const curSc = fs.existsSync(scPath) ? fs.readFileSync(scPath, 'utf8') : '';
        const curTw = fs.existsSync(twPath) ? fs.readFileSync(twPath, 'utf8') : '';
        if (curSc !== nextSc || curTw !== nextTw) {
            changedDictFiles.push(file);
        }
    }
    const nextRulesText = stringifyStableJson(mergedRules);
    const curRulesText = fs.existsSync(currentRulesPath) ? fs.readFileSync(currentRulesPath, 'utf8') : '';
    const rulesChanged = curRulesText !== nextRulesText;

    const changedEngineFiles = prevState && prevState.qqxpee && prevState.qqxpee.engineHashes
        ? diffEngineHashes(prevState.qqxpee.engineHashes, qqxpee.engineHashes)
        : [];
    const engineChanged = changedEngineFiles.length > 0;
    const dictChanged = changedDictFiles.length > 0 || rulesChanged;
    const needsReview = engineChanged || skippedNeedsReview.length > 0;

    const currentTranslationVersion = (prevState && prevState.translationVersion) || pkg.version || '1.0.0';
    const nextTranslationVersion = (bumpTranslationVersion && dictChanged && !needsReview)
        ? bumpPatchSemver(currentTranslationVersion)
        : currentTranslationVersion;

    const nextState = {
        translationVersion: nextTranslationVersion,
        lastSyncedAt: new Date().toISOString(),
        qqxpee: {
            repo: repoConfig.upstreams.qqxpee.repo,
            sha: qqxpee.sha,
            engineHashes: qqxpee.engineHashes
        },
        atonnyshen: {
            repo: repoConfig.upstreams.atonnyshen.repo,
            sha: atonnyshen.sha
        }
    };

    if (write) {
        for (const file of DICT_FILES) {
            fs.writeFileSync(path.join(repoRoot, 'dicts', file), stringifyStableJson(mergedSc[file]));
            fs.writeFileSync(path.join(repoRoot, 'dicts_tw', file), stringifyStableJson(mergedTw[file]));
        }
        fs.writeFileSync(currentRulesPath, nextRulesText);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, stringifyStableJson(nextState));
    }

    const totalEntries = DICT_FILES.reduce((sum, f) => sum + Object.keys(mergedTw[f]).length, 0);
    const report = {
        ok: true,
        written: write,
        totalEntries,
        dictChanged,
        rulesChanged,
        changedDictFiles,
        addedFromQqxpeeCount: addedFromQqxpee.length,
        addedFromQqxpee,
        skippedNeedsReviewCount: skippedNeedsReview.length,
        skippedNeedsReview,
        engineChanged,
        changedEngineFiles,
        needsReview,
        autoPublishAllowed: Boolean(repoConfig.autoPublishDictRelease && dictChanged && !needsReview),
        previousTranslationVersion: currentTranslationVersion,
        nextTranslationVersion,
        qqxpeeSha: qqxpee.sha,
        atonnyshenSha: atonnyshen.sha
    };

    if (reportPath) {
        fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
        fs.writeFileSync(path.resolve(reportPath), stringifyStableJson(report));
    }

    return report;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const getArg = (name) => {
        const idx = args.indexOf(name);
        return idx >= 0 ? args[idx + 1] : null;
    };
    runSync({
        write: args.includes('--write'),
        bumpTranslationVersion: args.includes('--bump-translation-version'),
        qqxpeeDir: getArg('--qqxpee-dir'),
        atonnyshenDir: getArg('--atonnyshen-dir'),
        reportPath: getArg('--report')
    }).then((report) => {
        console.log(JSON.stringify(report, null, 2));
    }).catch((err) => {
        console.error('[sync_upstream] Failed:', err.message);
        process.exit(1);
    });
}

module.exports = {
    applyTwGlossary,
    applyPersonalOverrides,
    mergeDictionaries,
    mergeRuntimeRules,
    diffEngineHashes,
    bumpPatchSemver,
    runSync
};
