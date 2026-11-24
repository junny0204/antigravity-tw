'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadRepoConfig, getTranslationAssetName } = require('../scripts/repo_config');
const { configureRepository } = require('../scripts/configure_repo');
const {
    applyTwGlossary,
    mergeDictionaries,
    mergeRuntimeRules,
    diffEngineHashes,
    bumpPatchSemver,
    runSync
} = require('../scripts/sync_upstream');
const { fetchLatestRelease } = require('../scripts/auto_updater');

const REPO_ROOT = path.resolve(__dirname, '..');

function makeTempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtw-sync-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('repo_config loads valid slug and builds matching asset filename', () => {
    const cfg = loadRepoConfig();
    assert.match(cfg.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.equal(getTranslationAssetName('v1.2.3'), `${cfg.assetPrefix}-v1.2.3.zip`);
});

test('fetchLatestRelease blocks any repository other than configured repo', async () => {
    await assert.rejects(
        fetchLatestRelease('untrusted/other-repo'),
        /Blocked untrusted release metadata URL/
    );
});

test('applyTwGlossary normalizes Mainland/non-TW software terms to zh-TW', () => {
    const glossary = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'tw_glossary.json'), 'utf8'));
    assert.equal(applyTwGlossary('管理許可證與書簽', glossary), '管理授權與書籤');
    assert.equal(applyTwGlossary('捕獲主控台網頁端更改', glossary), '擷取主控台網頁版變更');
    assert.equal(applyTwGlossary('透過協議遷移儲存庫，無需配置插件', glossary), '透過協定移轉存放庫，無須設定外掛程式');
});

test('mergeDictionaries preserves atonnyshen TW fixes, normalizes new qqxpee keys, and applies personal overrides last', () => {
    const glossary = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'tw_glossary.json'), 'utf8'));
    const qqxpee = {
        dicts: {
            'common.json': {
                'Choose a license': '选择许可证',
                'Capture browser bookmark': '捕获浏览器书签',
                'goal': '目标'
            }
        },
        dictsTw: {
            'common.json': {
                'Choose a license': '選擇許可證',
                'Capture browser bookmark': '捕獲瀏覽器書簽',
                'goal': '目標'
            }
        }
    };
    const atonnyshen = {
        dicts: {
            'common.json': {
                'Choose a license': '选择许可证'
            }
        },
        dictsTw: {
            'common.json': {
                'Choose a license': '選擇授權'
            }
        }
    };
    const overrides = {
        termReplacements: {},
        exactOverrides: {
            'Capture browser bookmark': '擷取瀏覽器書籤（自訂）'
        }
    };

    const result = mergeDictionaries({ qqxpee, atonnyshen, glossary, overrides });
    assert.equal(result.mergedTw['common.json']['Choose a license'], '選擇授權');
    assert.equal(result.mergedTw['common.json']['Capture browser bookmark'], '擷取瀏覽器書籤（自訂）');
    assert.equal(Object.hasOwn(result.mergedTw['common.json'], 'goal'), false, 'Reserved slash command must be skipped');
    assert.equal(result.skippedNeedsReview.length, 0);
});

test('runSync detects dict-only auto-publish vs engine-change PR review', async (t) => {
    const root = makeTempDir(t);
    const qDir = path.join(root, 'qqxpee');
    const aDir = path.join(root, 'atonnyshen');
    const projDir = path.join(root, 'project');

    const dictFiles = ['common.json', 'menu_nav.json', 'page_agents.json', 'page_main.json', 'page_mcp_knowledge.json', 'page_settings.json'];
    for (const base of [qDir, aDir, projDir]) {
        fs.mkdirSync(path.join(base, 'dicts'), { recursive: true });
        fs.mkdirSync(path.join(base, 'dicts_tw'), { recursive: true });
        for (const f of dictFiles) {
            fs.writeFileSync(path.join(base, 'dicts', f), JSON.stringify({ [`Init ${f}`]: `初始 ${f}` }, null, 2));
            fs.writeFileSync(path.join(base, 'dicts_tw', f), JSON.stringify({ [`Init ${f}`]: `初始 ${f}` }, null, 2));
        }
    }
    fs.mkdirSync(path.join(qDir, 'src'), { recursive: true });
    for (const rel of ['localization_engine.js', 'src/asar_patcher.js', 'src/main_patches.js', 'src/preload_runtime.js']) {
        fs.writeFileSync(path.join(qDir, rel), `// ${rel} v1`);
    }
    fs.mkdirSync(path.join(aDir, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'rules'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'rules', 'runtime_rules.json'), path.join(aDir, 'rules', 'runtime_rules.json'));
    fs.copyFileSync(path.join(REPO_ROOT, 'rules', 'runtime_rules.json'), path.join(projDir, 'rules', 'runtime_rules.json'));
    fs.mkdirSync(path.join(projDir, 'config'), { recursive: true });
    for (const cfgFile of ['repo.config.json', 'tw_glossary.json', 'tw_overrides.json']) {
        fs.copyFileSync(path.join(REPO_ROOT, 'config', cfgFile), path.join(projDir, 'config', cfgFile));
    }
    fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));

    // Baseline sync
    const first = await runSync({ repoRoot: projDir, write: true, qqxpeeDir: qDir, atonnyshenDir: aDir });
    assert.equal(first.engineChanged, false);

    // Add a new string in qqxpee only (dict-only update)
    const nextCommonSc = { 'Init common.json': '初始 common.json', 'Manage License': '管理许可证' };
    const nextCommonTw = { 'Init common.json': '初始 common.json', 'Manage License': '管理許可證' };
    fs.writeFileSync(path.join(qDir, 'dicts', 'common.json'), JSON.stringify(nextCommonSc, null, 2));
    fs.writeFileSync(path.join(qDir, 'dicts_tw', 'common.json'), JSON.stringify(nextCommonTw, null, 2));

    const second = await runSync({
        repoRoot: projDir,
        write: true,
        bumpTranslationVersion: true,
        qqxpeeDir: qDir,
        atonnyshenDir: aDir
    });
    assert.equal(second.dictChanged, true);
    assert.equal(second.engineChanged, false);
    assert.equal(second.autoPublishAllowed, true);
    assert.equal(second.nextTranslationVersion, '1.0.1');
    const writtenTw = JSON.parse(fs.readFileSync(path.join(projDir, 'dicts_tw', 'common.json'), 'utf8'));
    assert.equal(writtenTw['Manage License'], '管理授權');

    // Modify upstream engine JS -> must block auto-publish and require PR review,
    // and once written into the PR branch state, subsequent runs at the same commit do not loop
    fs.writeFileSync(path.join(qDir, 'src/preload_runtime.js'), '// preload_runtime.js v2');
    const third = await runSync({
        repoRoot: projDir,
        write: true,
        bumpTranslationVersion: true,
        qqxpeeDir: qDir,
        atonnyshenDir: aDir
    });
    assert.equal(third.engineChanged, true);
    assert.deepEqual(third.changedEngineFiles, ['src/preload_runtime.js']);
    assert.equal(third.needsReview, true);
    assert.equal(third.autoPublishAllowed, false);

    const fourth = await runSync({
        repoRoot: projDir,
        write: false,
        qqxpeeDir: qDir,
        atonnyshenDir: aDir
    });
    assert.equal(fourth.engineChanged, false, 'Recorded engineHashes in merged PR must prevent infinite PR re-opening');
});

test('mergeRuntimeRules applies personal termReplacements to dynamic rules', () => {
    const sample = {
        schemaVersion: 1,
        protected: { lowerWordsExclude: [], modelEffortLabels: [], slashCommands: [] },
        scopedMaps: { swarm: { Render: { sc: '渲染', tw: '算繪' } } },
        dynamicRules: [{ id: 'r1', pattern: '^Render\\s+(.+)$', flags: 'i', sc: '渲染 {1}', tw: '算繪 {1}' }],
        attrDynamicRules: []
    };
    const merged = mergeRuntimeRules(sample, sample, { termReplacements: { '算繪': '渲染' } });
    assert.equal(merged.scopedMaps.swarm.Render.tw, '渲染');
    assert.equal(merged.dynamicRules[0].tw, '渲染 {1}');
});

test('configureRepository updates config, macOS installer, and README atomically', (t) => {
    const dir = makeTempDir(t);
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'config', 'repo.config.json'), path.join(dir, 'config', 'repo.config.json'));
    fs.copyFileSync(path.join(REPO_ROOT, 'install_macos_autowatcher.sh'), path.join(dir, 'install_macos_autowatcher.sh'));
    fs.copyFileSync(path.join(REPO_ROOT, 'README.md'), path.join(dir, 'README.md'));

    const updated = configureRepository({ repo: 'demo-user/my-ag-tw', repoRoot: dir });
    assert.equal(updated.repo, 'demo-user/my-ag-tw');
    assert.equal(updated.assetPrefix, 'my-ag-tw-translations');
    assert.match(
        fs.readFileSync(path.join(dir, 'install_macos_autowatcher.sh'), 'utf8'),
        /https:\/\/github\.com\/demo-user\/my-ag-tw\.git/
    );
    assert.match(
        fs.readFileSync(path.join(dir, 'README.md'), 'utf8'),
        /demo-user\/my-ag-tw/
    );
});

test('bumpPatchSemver and diffEngineHashes work cleanly', () => {
    assert.equal(bumpPatchSemver('1.0.0'), '1.0.1');
    assert.equal(bumpPatchSemver('2.3.9'), '2.3.10');
    assert.deepEqual(
        diffEngineHashes({ 'src/main_patches.js': 'aaa' }, { 'src/main_patches.js': 'bbb' }),
        ['src/main_patches.js']
    );
});
