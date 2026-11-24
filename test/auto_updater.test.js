const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { compareVersions, checkUpdate, adjustUpdateCheckCooldown, pruneOldTranslationPacks } = require('../scripts/auto_updater.js');

test('compareVersions accurately compares semantic version strings', () => {
    assert.equal(compareVersions('3.3.5', '3.3.4'), 1);
    assert.equal(compareVersions('v3.3.5', '3.3.5'), 0);
    assert.equal(compareVersions('3.3.4', '3.3.5'), -1);
    assert.equal(compareVersions('3.4.0', '3.3.9'), 1);
    assert.equal(compareVersions('4.0.0', '3.99.99'), 1);
    assert.equal(compareVersions('3.3.5.1', '3.3.5'), 1);
    assert.equal(compareVersions('3.3', '3.3.0'), 0);
});

test('checkUpdate throttles within interval window', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-'));
    const cacheFile = path.join(tmpDir, 'cache.json');

    // Seed recent cache
    fs.writeFileSync(cacheFile, JSON.stringify({
        lastChecked: Date.now() - 10000,
        remoteVersion: '3.3.5'
    }));

    const res = await checkUpdate({
        currentVersion: '3.3.4',
        cacheFilePath: cacheFile,
        intervalMs: 60000 // 1 min window
    });

    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'within_interval');

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('adjustUpdateCheckCooldown shortens 24h lockout to 15m retry window and pruneOldTranslationPacks cleans old dirs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-cooldown-'));
    try {
        const cacheFile = path.join(tmpDir, '.watcher-state', 'update_check.json');
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const intervalMs = 24 * 60 * 60 * 1000;
        fs.writeFileSync(cacheFile, JSON.stringify({ hasUpdate: true, tag: 'v1.0.5', lastChecked: Date.now() }));

        assert.equal(adjustUpdateCheckCooldown(cacheFile, 15 * 60 * 1000, intervalMs), true);
        const rewound = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        assert.equal(rewound.retryScheduled, true);
        // Should still skip immediately (< 15m), but NOT skip once 16m have elapsed!
        const stillWithin15m = await checkUpdate({ currentVersion: '1.0.4', cacheFilePath: cacheFile, intervalMs });
        assert.equal(stillWithin15m.skipped, true);

        rewound.lastChecked -= 16 * 60 * 1000;
        fs.writeFileSync(cacheFile, JSON.stringify(rewound));
        const after16m = await checkUpdate({
            currentVersion: '1.0.4',
            cacheFilePath: cacheFile,
            intervalMs,
            apiUrl: 'http://blocked.invalid/test'
        });
        assert.equal(Boolean(after16m.skipped), false, 'must retry once 15m retry window has elapsed');

        const packsRoot = path.join(tmpDir, '.translation-packs');
        for (const v of ['1.0.1', '1.0.2', '1.0.3', '1.0.4']) {
            fs.mkdirSync(path.join(packsRoot, v), { recursive: true });
            fs.writeFileSync(path.join(packsRoot, v, 'marker.json'), '{}');
        }
        const removed = pruneOldTranslationPacks(tmpDir, ['1.0.4', '1.0.3']);
        assert.deepEqual(removed.sort(), ['1.0.1', '1.0.2']);
        assert.deepEqual(fs.readdirSync(packsRoot).sort(), ['1.0.3', '1.0.4']);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
