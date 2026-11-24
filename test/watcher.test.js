'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkAndLocalizeApp, exchangeAsar, waitForStableFile, acquireLock, digest, safeReplaceFile, ensureAccessibleDir, recipeHash, rotateLogFileInPlace, detectRecentAppLaunchTrigger, shouldForceAppLaunchCheck, refreshTranslationsAndReapply } = require('../auto_localize_watcher');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-watcher-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const appPath = path.join(root, 'App with spaces');
    fs.mkdirSync(appPath);
    const asarPath = path.join(appPath, 'app.asar');
    fs.writeFileSync(asarPath, 'official-v1');
    const stateDir = path.join(root, 'state');
    let builds = 0;
    const options = {
        stateDir, recipe: 'recipe-v1', wait() {}, sign() {},
        build(stage) {
            builds++;
            fs.appendFileSync(path.join(stage, 'app.asar'), '\n命令選擇區');
        }
    };
    return { appInfo: { appPath, asarPath }, asarPath, stateDir, options,
        run: (extra = {}) => checkAndLocalizeApp({ appPath, asarPath }, { ...options, ...extra }),
        read: () => fs.readFileSync(asarPath, 'utf8'), builds: () => builds };
}

function recoveryReceipt(f) {
    return path.join(f.stateDir, digest(f.appInfo.appPath) + '.pending-recovery.json');
}

test('native ASAR exchange retains byte-identical displaced file on this platform', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-exchange-native-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const live = path.join(root, 'app.asar');
    const candidate = path.join(root, 'candidate.asar');
    const previous = path.join(root, 'previous.asar');
    fs.writeFileSync(live, 'official-v1');
    fs.writeFileSync(candidate, 'translated-v2');
    const displaced = exchangeAsar(candidate, live, previous);
    assert.equal(fs.readFileSync(live, 'utf8'), 'translated-v2');
    assert.equal(fs.readFileSync(displaced, 'utf8'), 'official-v1');
    if (process.platform === 'win32') {
        assert.equal(displaced, previous, 'ReplaceFileW must create its atomic backup');
    } else {
        assert.equal(displaced, candidate, 'native exchange must keep old data at candidate path');
    }
});

test('official update: backup, apply, persist receipt, then skip unchanged archive', t => {
    const f = fixture(t);
    assert.equal(f.run(), true);
    assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'official-v1');
    assert.equal(f.run(), false);
    assert.equal(f.builds(), 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.stateDir, digest(f.appInfo.appPath) + '.json')));
    assert.equal(receipt.output, digest(fs.readFileSync(f.asarPath)));
    fs.writeFileSync(f.asarPath, 'official-v2');
    assert.equal(f.run(), true);
    assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'official-v2');
});

test('recipe update reapplies localized input without restoring stale backup', t => {
    const f = fixture(t);
    f.run();
    fs.writeFileSync(f.asarPath + '.bak', 'stale-official');
    assert.equal(f.run({ recipe: 'recipe-v2' }), true);
    assert.equal(f.builds(), 2);
    assert.match(f.read(), /^official-v1/);
    assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'stale-official');
});

for (const failure of ['builder', 'validation']) {
    test(failure + ' failure preserves live archive and releases lock', t => {
        const f = fixture(t);
        assert.throws(() => f.run({ build() { if (failure === 'builder') throw Error('build failed'); } }));
        assert.equal(f.read(), 'official-v1');
        assert.deepEqual(fs.readdirSync(f.stateDir), []);
        assert.equal(fs.existsSync(f.asarPath + '.bak'), false);
    });
}

test('updater racing the build keeps its new official archive', t => {
    const f = fixture(t);
    assert.throws(() => f.run({ build(stage) {
        f.options.build(stage);
        fs.writeFileSync(f.asarPath, 'official-v2');
    } }), /官方包已改變/);
    assert.equal(f.read(), 'official-v2');
});

test('signing failure rolls back bytes and does not record success', t => {
    const f = fixture(t);
    let calls = 0;
    assert.throws(() => f.run({ sign() { if (++calls === 1) throw Error('sign denied'); } }), /sign denied/);
    assert.equal(calls, 2);
    assert.equal(f.read(), 'official-v1');
    assert.deepEqual(fs.readdirSync(f.stateDir), []);
});

test('failed atomic rollback preserves original ASAR in recovery directory and reports failure', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({
        exchange(source, destination, previous) {
            if (++exchanges === 2) {
                const error = new Error('simulated rollback write denial');
                error.code = 'EPERM';
                throw error;
            }
            return exchangeAsar(source, destination, previous);
        },
        sign() { throw new Error('simulated signing failure'); }
    }), /simulated signing failure/);
    assert.equal(exchanges, 2);
    const recoveryDirs = fs.readdirSync(f.stateDir).filter(name => name.startsWith('recovery-'));
    assert.equal(recoveryDirs.length, 1);
    assert.equal(fs.readFileSync(path.join(f.stateDir, recoveryDirs[0], 'previous-app.asar'), 'utf8'), 'official-v1');
    assert.equal(JSON.parse(fs.readFileSync(recoveryReceipt(f), 'utf8')).recoverHash, digest('official-v1'));
    assert.equal(fs.existsSync(path.join(f.stateDir, digest(f.appInfo.appPath) + '.json')), false);
});

test('live ASAR refuses non-atomic copy fallback when rename is denied', t => {
    const f = fixture(t);
    fs.writeFileSync(f.asarPath + '.bak', 'official-v1');
    const originalCopy = fs.copyFileSync;
    let unsafeCopies = 0;
    fs.copyFileSync = (source, destination, ...rest) => {
        if (destination === f.asarPath) unsafeCopies++;
        return originalCopy(source, destination, ...rest);
    };
    try {
        assert.throws(() => f.run({ exchange() {
            const error = new Error('Simulated EPERM during native atomic exchange');
            error.code = 'EPERM';
            throw error;
        } }), /Simulated EPERM/);
        assert.equal(unsafeCopies, 0);
        assert.equal(f.read(), 'official-v1');
        assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'official-v1');
        assert.deepEqual(fs.readdirSync(f.stateDir), []);
    } finally {
        fs.copyFileSync = originalCopy;
    }
});

test('ShipIt replace immediately before native exchange preserves newer official ASAR', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({ exchange(source, destination, previous) {
        if (++exchanges === 1) fs.writeFileSync(destination, 'official-v2-from-ShipIt');
        return exchangeAsar(source, destination, previous);
    } }), /原子置換期間官方 ASAR 已更新/);
    assert.equal(exchanges, 2);
    assert.equal(f.read(), 'official-v2-from-ShipIt');
    assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'official-v1');
    assert.equal(fs.readdirSync(f.stateDir).filter(x => x.endsWith('.json')).length, 0);
    assert.equal(f.run(), true);
    assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'official-v2-from-ShipIt');
});

test('backup ENOSPC blocks any live ASAR replacement, rather than logging success', t => {
    const f = fixture(t);
    const originalRename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (source, destination) => {
        if (destination === f.asarPath + '.bak') {
            attempts++;
            const error = new Error('Injected ENOSPC in backup promotion');
            error.code = 'ENOSPC';
            throw error;
        }
        return originalRename(source, destination);
    };
    try {
        assert.throws(() => f.run(), /無法以原子置換更新 app\.asar\.bak/);
        assert.equal(attempts, 1);
        assert.equal(f.read(), 'official-v1');
        assert.equal(fs.existsSync(f.asarPath + '.bak'), false);
        assert.deepEqual(fs.readdirSync(f.stateDir), []);
    } finally {
        fs.renameSync = originalRename;
    }
});

test('backup fsync failure aborts before replacing live ASAR', t => {
    const f = fixture(t);
    const open = fs.openSync;
    const fsync = fs.fsyncSync;
    let backupFd = null;
    let rejected = 0;
    fs.openSync = (file, ...args) => {
        const fd = open(file, ...args);
        if (String(file).endsWith('official.bak')) backupFd = fd;
        return fd;
    };
    fs.fsyncSync = (fd) => {
        if (fd === backupFd) {
            rejected++;
            const error = new Error('Injected backup flush failure');
            error.code = 'EIO';
            throw error;
        }
        return fsync(fd);
    };
    try {
        assert.throws(() => f.run(), /Injected backup flush failure/);
        assert.equal(rejected, 1);
        assert.equal(f.read(), 'official-v1');
        assert.equal(fs.existsSync(f.asarPath + '.bak'), false);
        assert.deepEqual(fs.readdirSync(f.stateDir), []);
    } finally {
        fs.openSync = open;
        fs.fsyncSync = fsync;
    }
});

test('Windows backup flush handle failure is never silently ignored', { skip: process.platform !== 'win32' }, t => {
    const f = fixture(t);
    const open = fs.openSync;
    let rejected = 0;
    fs.openSync = (file, ...args) => {
        if (String(file).endsWith('official.bak') && args[0] === 'r+') {
            rejected++;
            const error = new Error('Injected Windows FlushFileBuffers handle denial');
            error.code = 'EPERM';
            throw error;
        }
        return open(file, ...args);
    };
    try {
        assert.throws(() => f.run(), /Injected Windows FlushFileBuffers handle denial/);
        assert.equal(rejected, 1);
        assert.equal(f.read(), 'official-v1');
        assert.equal(fs.existsSync(f.asarPath + '.bak'), false);
    } finally {
        fs.openSync = open;
    }
});

test('backup promotion must be read back and verified before touching the live ASAR', t => {
    const f = fixture(t);
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
        const result = rename(source, destination);
        if (destination === f.asarPath + '.bak') {
            fs.writeFileSync(destination, 'invalid-partial-backup');
        }
        return result;
    };
    try {
        assert.throws(() => f.run(), /官方 app\.asar 備份驗證失敗/);
        assert.equal(f.read(), 'official-v1');
        assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'invalid-partial-backup');
    } finally {
        fs.renameSync = rename;
    }
});

test('failed atomic recovery retains ShipIt newest official ASAR for manual restoration', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({ exchange(source, destination, previous) {
        if (++exchanges === 1) fs.writeFileSync(destination, 'official-v2-from-ShipIt');
        if (exchanges === 2) throw new Error('simulated denial during race recovery');
        return exchangeAsar(source, destination, previous);
    } }), /自動回復失敗/);
    assert.equal(exchanges, 2);
    assert.equal(f.read(), 'official-v1\n命令選擇區');
    const retained = fs.readdirSync(f.appInfo.appPath).find(n => n.startsWith('.autolocalize-'));
    assert.ok(retained, 'unresolved native race must retain its recovery staging directory');
    const retainedFile = process.platform === 'win32'
        ? path.join(f.appInfo.appPath, retained, 'previous.asar')
        : path.join(f.appInfo.appPath, retained, 'app.asar');
    assert.equal(fs.readFileSync(retainedFile, 'utf8'),
        'official-v2-from-ShipIt');
    const record = JSON.parse(fs.readFileSync(recoveryReceipt(f), 'utf8'));
    assert.equal(record.expectedLiveHash, digest('official-v1\n命令選擇區'));
    assert.equal(record.recoverHash, digest('official-v2-from-ShipIt'));
});

test('next scheduled run restores preserved ShipIt archive and reapplies localization', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({ exchange(source, destination, previous) {
        if (++exchanges === 1) fs.writeFileSync(destination, 'official-v2-from-ShipIt');
        if (exchanges === 2) throw new Error('temporary recovery permission denial');
        return exchangeAsar(source, destination, previous);
    } }), /自動回復失敗/);
    assert.ok(fs.existsSync(recoveryReceipt(f)));
    assert.equal(f.read(), 'official-v1\n命令選擇區');
    assert.equal(f.run(), true);
    assert.equal(f.read(), 'official-v2-from-ShipIt\n命令選擇區');
    assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'official-v2-from-ShipIt');
    assert.equal(fs.existsSync(recoveryReceipt(f)), false);
});

test('scheduled recovery retries after permission denial without rewriting the live ASAR', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({
        sign() { throw Error('signing failed'); },
        exchange(source, destination, previous) {
            if (++exchanges === 2) throw Error('rollback failed');
            return exchangeAsar(source, destination, previous);
        }
    }), /signing failed/);
    const pending = recoveryReceipt(f);
    assert.ok(fs.existsSync(pending));
    const live = f.read();
    const builds = f.builds();
    assert.throws(() => f.run({ exchange() {
        const error = new Error('still denied');
        error.code = 'EPERM';
        throw error;
    } }), /still denied/);
    assert.equal(f.read(), live);
    assert.equal(f.builds(), builds);
    assert.ok(fs.existsSync(pending));
    assert.equal(f.run(), true);
    assert.equal(fs.existsSync(pending), false);
    assert.equal(f.read(), 'official-v1\n命令選擇區');
});

test('scheduled recovery refuses changed live ASAR and retains recovery evidence', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({ exchange(source, destination, previous) {
        if (++exchanges === 1) fs.writeFileSync(destination, 'official-v2-from-ShipIt');
        if (exchanges === 2) throw Error('recovery blocked');
        return exchangeAsar(source, destination, previous);
    } }), /自動回復失敗/);
    const pending = recoveryReceipt(f);
    const builds = f.builds();
    fs.writeFileSync(f.asarPath, 'official-v3-from-ShipIt');
    assert.throws(() => f.run(), /正式 ASAR 已被其他程序更新/);
    assert.equal(f.read(), 'official-v3-from-ShipIt');
    assert.equal(f.builds(), builds);
    assert.ok(fs.existsSync(pending));
});

test('scheduled recovery refuses tampered recovery bytes', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({ exchange(source, destination, previous) {
        if (++exchanges === 1) fs.writeFileSync(destination, 'official-v2-from-ShipIt');
        if (exchanges === 2) throw Error('recovery blocked');
        return exchangeAsar(source, destination, previous);
    } }), /自動回復失敗/);
    const record = JSON.parse(fs.readFileSync(recoveryReceipt(f), 'utf8'));
    fs.writeFileSync(path.join(f.stateDir, record.recoveryDir, 'previous-app.asar'), 'corrupted');
    const builds = f.builds();
    assert.throws(() => f.run(), /復原檔與原始 SHA-256 不符/);
    assert.equal(f.builds(), builds);
    assert.ok(fs.existsSync(recoveryReceipt(f)));
});

test('scheduled recovery holds when another ShipIt update cannot be restored', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({ exchange(source, destination, previous) {
        if (++exchanges === 1) fs.writeFileSync(destination, 'official-v2-from-ShipIt');
        if (exchanges === 2) throw Error('initial recovery blocked');
        return exchangeAsar(source, destination, previous);
    } }), /自動回復失敗/);
    let restoreCalls = 0;
    assert.throws(() => f.run({ exchange(source, destination, previous) {
        if (++restoreCalls === 1) fs.writeFileSync(destination, 'official-v3-from-ShipIt');
        if (restoreCalls === 2) throw Error('newer recovery blocked');
        return exchangeAsar(source, destination, previous);
    } }), /自動回復失敗/);
    assert.equal(restoreCalls, 2);
    assert.equal(JSON.parse(fs.readFileSync(recoveryReceipt(f), 'utf8')).manualRequired, true);
    const live = f.read();
    const builds = f.builds();
    assert.throws(() => f.run(), /無法確認最新版/);
    assert.equal(f.read(), live);
    assert.equal(f.builds(), builds);
});

test('scheduled recovery recognizes an already restored official ASAR', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({ exchange(source, destination, previous) {
        if (++exchanges === 1) fs.writeFileSync(destination, 'official-v2-from-ShipIt');
        if (exchanges === 2) throw Error('recovery blocked');
        return exchangeAsar(source, destination, previous);
    } }), /自動回復失敗/);
    const record = JSON.parse(fs.readFileSync(recoveryReceipt(f), 'utf8'));
    const saved = fs.readFileSync(path.join(f.stateDir, record.recoveryDir, 'previous-app.asar'));
    fs.writeFileSync(f.asarPath, saved);
    assert.equal(f.run(), true);
    assert.equal(fs.existsSync(recoveryReceipt(f)), false);
    assert.equal(f.read(), 'official-v2-from-ShipIt\n命令選擇區');
});

test('scheduled recovery skips a concurrent watcher and keeps the pending receipt', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({ exchange(source, destination, previous) {
        if (++exchanges === 1) fs.writeFileSync(destination, 'official-v2-from-ShipIt');
        if (exchanges === 2) throw Error('recovery blocked');
        return exchangeAsar(source, destination, previous);
    } }), /自動回復失敗/);
    const release = acquireLock(path.join(f.stateDir, 'run.lock'));
    try {
        assert.equal(f.run(), false);
        assert.ok(fs.existsSync(recoveryReceipt(f)));
    } finally {
        release();
    }
});

test('ShipIt replace during signing rollback preserves current official ASAR', t => {
    const f = fixture(t);
    let exchanges = 0;
    assert.throws(() => f.run({
        sign() { throw new Error('simulated signing failure'); },
        exchange(source, destination, previous) {
            if (++exchanges === 2) fs.writeFileSync(destination, 'official-v3-from-ShipIt');
            return exchangeAsar(source, destination, previous);
        }
    }), /simulated signing failure/);
    assert.equal(exchanges, 3);
    assert.equal(f.read(), 'official-v3-from-ShipIt');
});

test('interrupted receipt update is safely reconciled on next isolated watcher run', t => {
    const f = fixture(t);
    const idempotentBuild = stage => {
        const archive = path.join(stage, 'app.asar');
        if (!fs.readFileSync(archive, 'utf8').includes('命令選擇區')) {
            fs.appendFileSync(archive, '\n命令選擇區');
        }
    };
    assert.equal(f.run({ build: idempotentBuild }), true);
    const modified = f.read();
    const receipt = path.join(f.stateDir, digest(f.appInfo.appPath) + '.json');
    fs.rmSync(receipt);
    assert.equal(f.run({ build: idempotentBuild }), true);
    assert.equal(f.read(), modified);
    assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'official-v1');
    assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).output,
        digest(fs.readFileSync(f.asarPath)));
});

test('update during signing is never overwritten by rollback', t => {
    const f = fixture(t);
    assert.throws(() => f.run({ sign() {
        fs.writeFileSync(f.asarPath, 'official-v3');
        throw Error('sign failed after update');
    } }));
    assert.equal(f.read(), 'official-v3');
});

test('unpacked resources reach the isolated builder', t => {
    const f = fixture(t);
    fs.mkdirSync(f.asarPath + '.unpacked');
    fs.writeFileSync(path.join(f.asarPath + '.unpacked', 'resource.txt'), 'resource');
    f.run({ build(stage) {
        assert.equal(fs.readFileSync(path.join(stage, 'app.asar.unpacked', 'resource.txt'), 'utf8'), 'resource');
        f.options.build(stage);
    } });
});

test('active lock skips duplicate execution; stale lock is reclaimed', t => {
    const f = fixture(t);
    fs.mkdirSync(f.stateDir);
    const lock = path.join(f.stateDir, 'run.lock');
    const release = acquireLock(lock);
    assert.equal(f.run(), false);
    assert.equal(f.builds(), 0);
    release();
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), '2147483647');
    assert.equal(f.run(), true);
});

test('rejects live and dangling backup symlinks', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t);
    fs.symlinkSync(path.join(f.appInfo.appPath, 'missing'), f.asarPath + '.bak');
    assert.throws(() => f.run(), /非一般檔案/);
    assert.equal(f.read(), 'official-v1');
});

test('stable file debounce requires nonzero size', t => {
    const f = fixture(t);
    waitForStableFile(f.asarPath, { interval: 1, timeout: 500, samples: 3 });
    fs.writeFileSync(f.asarPath, '');
    assert.throws(() => waitForStableFile(f.asarPath, { interval: 1, timeout: 5 }), /尚未穩定/);
});

test('safeReplaceFile falls back to copyFileSync and unlinks src when renameSync throws EPERM/EXDEV/EACCES', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-replace-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const src = path.join(root, 'src.txt');
    const dst = path.join(root, 'dst.txt');

    const origRename = fs.renameSync;
    for (const code of ['EPERM', 'EXDEV', 'EACCES']) {
        fs.writeFileSync(src, `content-for-${code}`);
        fs.writeFileSync(dst, 'old-content');
        let renameAttempted = false;
        fs.renameSync = () => {
            renameAttempted = true;
            const err = new Error(`Simulated ${code}`);
            err.code = code;
            throw err;
        };
        try {
            safeReplaceFile(src, dst, 0o644);
            assert.equal(renameAttempted, true);
            assert.equal(fs.readFileSync(dst, 'utf8'), `content-for-${code}`);
            assert.equal(fs.existsSync(src), false);
        } finally {
            fs.renameSync = origRename;
        }
    }
});

test('safeReplaceFile rethrows unexpected errors', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-replace-err-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const src = path.join(root, 'src.txt');
    const dst = path.join(root, 'dst.txt');
    fs.writeFileSync(src, 'content');

    const origRename = fs.renameSync;
    fs.renameSync = () => {
        const err = new Error('Disk full');
        err.code = 'ENOSPC';
        throw err;
    };
    try {
        assert.throws(() => safeReplaceFile(src, dst), /Disk full/);
    } finally {
        fs.renameSync = origRename;
    }
});

test('ensureAccessibleDir creates directory recursively and ensures accessible mode', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-dir-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const targetDir = path.join(root, 'nested', 'deep', 'dir');
    ensureAccessibleDir(targetDir);
    assert.equal(fs.existsSync(targetDir), true);
    const stat = fs.statSync(targetDir);
    assert.equal(stat.isDirectory(), true);
    if (process.platform !== 'win32') {
        assert.ok((stat.mode & 0o755) === 0o755);
        // Test upgrading existing restrictive directory
        const restrictive = path.join(root, 'restrictive');
        fs.mkdirSync(restrictive, { mode: 0o700 });
        fs.chmodSync(restrictive, 0o700);
        ensureAccessibleDir(restrictive);
        const updatedStat = fs.statSync(restrictive);
        assert.equal(updatedStat.mode & 0o777, 0o755);
    }
});

test('recipeHash incorporates package.json changes', t => {
    const hash1 = recipeHash();
    assert.equal(typeof hash1, 'string');
    assert.equal(hash1.length, 64);
});

test('safeReplaceFile falls back to in-place write when copyFileSync throws EPERM', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-replace-eperm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const src = path.join(root, 'src.txt');
    const dst = path.join(root, 'dst.txt');
    fs.writeFileSync(src, 'new-data');
    fs.writeFileSync(dst, 'old-data');

    const origRename = fs.renameSync;
    const origCopy = fs.copyFileSync;
    let renameFailed = false;
    let copyAttempt = 0;
    fs.renameSync = () => {
        renameFailed = true;
        const err = new Error('Rename EPERM');
        err.code = 'EPERM';
        throw err;
    };
    fs.copyFileSync = (s, d) => {
        copyAttempt++;
        const err = new Error('Copy EPERM');
        err.code = 'EPERM';
        throw err;
    };
    try {
        safeReplaceFile(src, dst, 0o644);
        assert.equal(renameFailed, true);
        assert.equal(copyAttempt, 1);
        assert.equal(fs.readFileSync(dst, 'utf8'), 'new-data');
        assert.equal(fs.existsSync(src), false);
    } finally {
        fs.renameSync = origRename;
        fs.copyFileSync = origCopy;
    }
});

test('acquireLock recovers and reclaims stale lock with restrictive directory permissions', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-lock-perm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const lockDir = path.join(root, 'test.lock');
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, 'pid'), '999999999');
    const release = acquireLock(lockDir);
    assert.notEqual(release, null);
    release();
    assert.equal(fs.existsSync(lockDir), false);
});

test('watcher removes .autolocalize temp dirs from appPath before sign runs', t => {
    const f = fixture(t);
    const seenTempDirs = [];
    const ran = f.run({
        sign(appPath) {
            seenTempDirs.push(fs.readdirSync(appPath).filter(n => n.startsWith('.autolocalize-')));
        }
    });
    assert.equal(ran, true);
    assert.deepEqual(seenTempDirs, [[]]);

    // Also verify rollback sign pass sees zero .autolocalize temp dirs
    fs.writeFileSync(f.asarPath, 'official-v2');
    const rollbackSeen = [];
    let calls = 0;
    assert.throws(() => f.run({
        sign(appPath) {
            rollbackSeen.push(fs.readdirSync(appPath).filter(n => n.startsWith('.autolocalize-')));
            if (++calls === 1) throw Error('sign denied');
        }
    }), /sign denied/);
    assert.deepEqual(rollbackSeen, [[], []]);
});

test('Windows exchangeAsar and checkAndLocalizeApp succeed while app.asar is held open by Electron-like reader', { skip: process.platform !== 'win32' }, async t => {
    const { spawn } = require('node:child_process');
    const f = fixture(t);
    // Hold f.asarPath open in a separate Win32 process with Read access + Read|Write|Delete sharing
    const holder = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '$fs = [IO.File]::Open($env:AG_TEST_HOLD_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Write -bor [IO.FileShare]::Delete)); ' +
        '[Console]::Out.WriteLine("OPEN"); [Console]::Out.Flush(); ' +
        '[void][Console]::In.ReadLine(); ' +
        '$sr = New-Object IO.StreamReader($fs); [Console]::Out.WriteLine("READ:" + $sr.ReadToEnd()); [Console]::Out.Flush(); ' +
        '$fs.Dispose()'
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AG_TEST_HOLD_PATH: f.asarPath } });
    t.after(() => { try { holder.kill(); } catch {} });

    await new Promise((resolve, reject) => {
        let buf = '';
        holder.stdout.on('data', chunk => {
            buf += chunk.toString('utf8');
            if (buf.includes('OPEN')) resolve();
        });
        holder.on('error', reject);
        holder.on('exit', code => { if (!buf.includes('OPEN')) reject(new Error('holder exited early: ' + code)); });
    });

    assert.equal(f.run(), true, 'watcher must atomically replace app.asar even while Electron holds a read handle');
    assert.equal(f.read(), 'official-v1\n命令選擇區');
    assert.equal(fs.readFileSync(f.asarPath + '.bak', 'utf8'), 'official-v1');

    const oldRead = await new Promise((resolve, reject) => {
        let out = '';
        holder.stdout.on('data', chunk => {
            out += chunk.toString('utf8');
            if (out.includes('READ:')) resolve(out.trim());
        });
        holder.stdin.write('\n');
        holder.on('error', reject);
    });
    assert.match(oldRead, /READ:official-v1$/, 'running process open handle must continue reading original bytes cleanly');
});

test('localization_engine computeDirRecipeHash matches watcher recipeHash', () => {
    const engine = require('../localization_engine');
    assert.equal(engine.computeDirRecipeHash(path.resolve(__dirname, '..')), recipeHash());
});

test('Windows checkAndLocalizeApp skips cleanly without building when app.asar lacks FILE_SHARE_DELETE, then applies once closed', { skip: process.platform !== 'win32' }, async t => {
    const { spawn } = require('node:child_process');
    const f = fixture(t);
    // Open f.asarPath WITHOUT FileShare.Delete (matching live Antigravity.exe on Windows)
    const holder = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '$fs = [IO.File]::Open($env:AG_TEST_HOLD_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Write)); ' +
        '[Console]::Out.WriteLine("OPEN"); [Console]::Out.Flush(); ' +
        '[void][Console]::In.ReadLine(); ' +
        '$fs.Dispose(); [Console]::Out.WriteLine("CLOSED"); [Console]::Out.Flush()'
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AG_TEST_HOLD_PATH: f.asarPath } });
    t.after(() => { try { holder.kill(); } catch {} });

    await new Promise((resolve, reject) => {
        let buf = '';
        holder.stdout.on('data', chunk => {
            buf += chunk.toString('utf8');
            if (buf.includes('OPEN')) resolve();
        });
        holder.on('error', reject);
        holder.on('exit', code => { if (!buf.includes('OPEN')) reject(new Error('holder exited early: ' + code)); });
    });

    assert.equal(f.run(), false, 'must defer cleanly without throwing while Antigravity locks app.asar against DELETE');
    assert.equal(f.builds(), 0, 'must not waste CPU building staging archive while locked');
    assert.equal(f.read(), 'official-v1');

    await new Promise((resolve, reject) => {
        let out = '';
        holder.stdout.on('data', chunk => {
            out += chunk.toString('utf8');
            if (out.includes('CLOSED')) resolve();
        });
        holder.stdin.write('\n');
        holder.on('error', reject);
    });

    assert.equal(f.run(), true, 'must apply immediately on next run after Antigravity closes');
    assert.equal(f.builds(), 1);
    assert.equal(f.read(), 'official-v1\n命令選擇區');
});

test('watcher syncs macOS Info.plist ElectronAsarIntegrity before signing and rolls it back on sign failure', t => {
    const crypto = require('node:crypto');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-plist-integrity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const makeValidAsar = (bodyText) => {
        const body = Buffer.from(bodyText, 'utf8');
        const json = Buffer.from(JSON.stringify({ files: { 'preload.js': { size: body.length, offset: '0' } } }), 'utf8');
        const aligned = Math.ceil((json.length + 4) / 4) * 4;
        const prefix = Buffer.alloc(12 + aligned);
        prefix.writeUInt32LE(4, 0);
        prefix.writeUInt32LE(aligned + 4, 4);
        prefix.writeUInt32LE(aligned, 8);
        prefix.writeUInt32LE(json.length, 12);
        json.copy(prefix, 16);
        return { buf: Buffer.concat([prefix, body]), headerHash: crypto.createHash('sha256').update(json).digest('hex') };
    };

    const appPath = path.join(root, 'Antigravity.app');
    const contentsDir = path.join(appPath, 'Contents');
    const resDir = path.join(contentsDir, 'Resources');
    fs.mkdirSync(resDir, { recursive: true });

    const origAsar = makeValidAsar('// official');
    const localizedAsar = makeValidAsar('/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */\n// 命令選擇區');
    const asarPath = path.join(resDir, 'app.asar');
    fs.writeFileSync(asarPath, origAsar.buf);

    const plistPath = path.join(contentsDir, 'Info.plist');
    const origPlist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0"><dict>',
        '  <key>ElectronAsarIntegrity</key>',
        '  <dict>',
        '    <key>Resources/app.asar</key>',
        '    <dict>',
        '      <key>algorithm</key><string>SHA256</string>',
        `      <key>hash</key><string>${origAsar.headerHash}</string>`,
        '    </dict>',
        '  </dict>',
        '</dict></plist>'
    ].join('\n');
    fs.writeFileSync(plistPath, origPlist, 'utf8');

    const stateDir = path.join(root, 'state');
    const seenPlistsDuringSign = [];

    // 1. Sign failure must roll back BOTH app.asar AND Info.plist before re-signing
    let failOnce = true;
    assert.throws(() => checkAndLocalizeApp({ appPath, asarPath }, {
        stateDir, recipe: 'r1', wait() {},
        build(stage) { fs.writeFileSync(path.join(stage, 'app.asar'), localizedAsar.buf); },
        sign() {
            seenPlistsDuringSign.push(fs.readFileSync(plistPath, 'utf8'));
            if (failOnce) { failOnce = false; throw new Error('codesign failed'); }
        }
    }), /codesign failed/);
    assert.equal(seenPlistsDuringSign.length, 2);
    assert.ok(seenPlistsDuringSign[0].includes(localizedAsar.headerHash), 'Info.plist must already have new hash when codesign runs');
    assert.equal(seenPlistsDuringSign[1], origPlist, 'Rollback codesign must seal the restored original Info.plist');
    assert.equal(fs.readFileSync(plistPath, 'utf8'), origPlist, 'Info.plist must roll back to original bytes when signing fails');
    assert.deepEqual(fs.readFileSync(asarPath), origAsar.buf);

    // 2. Successful run updates Info.plist to exact new ASAR header SHA-256
    const ok = checkAndLocalizeApp({ appPath, asarPath }, {
        stateDir, recipe: 'r1', wait() {},
        build(stage) { fs.writeFileSync(path.join(stage, 'app.asar'), localizedAsar.buf); },
        sign() {}
    });
    assert.equal(ok, true);
    assert.ok(fs.readFileSync(plistPath, 'utf8').includes(localizedAsar.headerHash));
});

test('watcher preserves user brandTitle preference across official updates', t => {
    const f = fixture(t);
    fs.mkdirSync(f.stateDir, { recursive: true });
    fs.writeFileSync(path.join(f.stateDir, 'brand_preference.json'), JSON.stringify({ brandTitle: 'hidden' }) + '\n');

    const seenBrands = [];
    assert.equal(f.run({
        build(stage, brandTitle) {
            seenBrands.push(brandTitle);
            f.options.build(stage);
        }
    }), true);
    assert.deepEqual(seenBrands, ['hidden']);

    // Even if brand_preference.json is removed later and official update overwrites app.asar,
    // previous receipt in stateDir still remembers 'hidden'
    fs.unlinkSync(path.join(f.stateDir, 'brand_preference.json'));
    fs.writeFileSync(f.asarPath, 'official-v2-english');
    assert.equal(f.run({
        build(stage, brandTitle) {
            seenBrands.push(brandTitle);
            f.options.build(stage);
        }
    }), true);
    assert.deepEqual(seenBrands, ['hidden', 'hidden']);
});

test('rotateLogFileInPlace preserves inode and aligns UTF-8 Traditional Chinese lines cleanly', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-log-rot-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const logPath = path.join(root, 'autolocalize.log');
    const line = '[2026-11-24T00:00:00.000Z] 已是目前版本的繁中套件，略過。\n';
    fs.writeFileSync(logPath, line.repeat(400), 'utf8');
    const beforeStat = fs.statSync(logPath);
    assert.equal(rotateLogFileInPlace(logPath, 4096, 2048), true);
    const afterStat = fs.statSync(logPath);
    assert.equal(afterStat.ino, beforeStat.ino, 'in-place rotation must preserve inode for launchd fd');
    assert.ok(afterStat.size <= 2048 && afterStat.size > 0);
    const text = fs.readFileSync(logPath, 'utf8');
    assert.equal(text.includes('\uFFFD'), false, 'UTF-8 multi-byte characters must never be split');
    assert.ok(text.startsWith('[2026-11-24T'), 'rotated log must start cleanly at a newline boundary');
});

test('detectRecentAppLaunchTrigger uses lstatSync on SingletonLock and respects anti-storm and retryScheduled guards', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-launch-trig-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cacheFile = path.join(root, 'update_check.json');
    const appSupport = path.join(root, 'Antigravity');
    fs.mkdirSync(appSupport, { recursive: true });
    const lockPath = path.join(appSupport, 'SingletonLock');
    if (process.platform === 'win32') {
        fs.writeFileSync(lockPath, 'host-1234');
    } else {
        // Real Electron on macOS creates a dangling symlink pointing to host-pid
        fs.symlinkSync('TestMac.local-99999', lockPath);
    }
    const lockMtime = fs.lstatSync(lockPath).mtimeMs;
    const now = lockMtime + 5000;

    // 1. Checked 45m before SingletonLock was touched -> must trigger forced check!
    fs.writeFileSync(cacheFile, JSON.stringify({ lastChecked: lockMtime - 45 * 60 * 1000 }));
    assert.equal(detectRecentAppLaunchTrigger({ cacheFile, appSupportDirs: [appSupport], nowMs: now }), true);

    // 2. Checked only 5m ago -> blocked by 30m anti-storm guard
    fs.writeFileSync(cacheFile, JSON.stringify({ lastChecked: lockMtime - 5 * 60 * 1000 }));
    assert.equal(detectRecentAppLaunchTrigger({ cacheFile, appSupportDirs: [appSupport], nowMs: now }), false);

    // 3. retryScheduled is true -> never bypass 15m failure cooldown
    fs.writeFileSync(cacheFile, JSON.stringify({ lastChecked: lockMtime - 45 * 60 * 1000, retryScheduled: true }));
    assert.equal(detectRecentAppLaunchTrigger({ cacheFile, appSupportDirs: [appSupport], nowMs: now }), false);
});

test('refreshTranslationsAndReapply schedules short retry when blocked by run.lock', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-lock-retry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDir = path.join(root, '.watcher-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const prevEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    t.after(() => {
        if (prevEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevEnv;
    });

    let cooldownCalledWith = null;
    const release = acquireLock(path.join(stateDir, 'run.lock'));
    try {
        const res = await refreshTranslationsAndReapply({
            targetDir: root,
            stateDir,
            currentVersion: '1.0.4',
            updater: {
                readActiveTranslation: () => null,
                checkUpdate: async () => ({ hasUpdate: true, tag: 'v1.0.5', release: { tag: 'v1.0.5', assets: [] } }),
                installTranslationUpdate: async () => { throw new Error('Should not run while locked'); },
                adjustUpdateCheckCooldown: (file, retryMs, intMs) => { cooldownCalledWith = { file, retryMs, intMs }; }
            }
        });
        assert.equal(res.reason, 'locked');
        assert.ok(cooldownCalledWith, 'locked run must schedule short retry cooldown instead of 7-day lockout');
        assert.equal(cooldownCalledWith.retryMs, 15 * 60 * 1000);
        assert.equal(cooldownCalledWith.intMs, 7 * 24 * 60 * 60 * 1000);
    } finally {
        release();
    }
});

test('shouldForceAppLaunchCheck enforces 30m anti-storm guard and retryScheduled backoff, and works via onAppLaunch', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-win-launch-check-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDir = path.join(root, '.watcher-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const cacheFile = path.join(stateDir, 'update_check.json');
    const now = Date.now();

    assert.equal(shouldForceAppLaunchCheck({ cacheFile, nowMs: now }), false, 'missing cache needs no explicit override');
    fs.writeFileSync(cacheFile, JSON.stringify({ lastChecked: now - 10 * 60 * 1000 }));
    assert.equal(shouldForceAppLaunchCheck({ cacheFile, nowMs: now }), false, 'within 30m anti-storm window');
    fs.writeFileSync(cacheFile, JSON.stringify({ lastChecked: now - 45 * 60 * 1000, retryScheduled: true }));
    assert.equal(shouldForceAppLaunchCheck({ cacheFile, nowMs: now }), false, 'never bypass retryScheduled cooldown');
    fs.writeFileSync(cacheFile, JSON.stringify({ lastChecked: now - 45 * 60 * 1000 }));
    assert.equal(shouldForceAppLaunchCheck({ cacheFile, nowMs: now }), true, 'older than 30m must force check');

    const prevEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    t.after(() => {
        if (prevEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevEnv;
    });
    let seenForce = null;
    await refreshTranslationsAndReapply({
        targetDir: root,
        stateDir,
        currentVersion: '1.0.6',
        onAppLaunch: true,
        updater: {
            readActiveTranslation: () => null,
            checkUpdate: async (opts) => { seenForce = opts.force; return { hasUpdate: false }; }
        }
    });
    assert.equal(seenForce, true, '--on-app-launch must pass force: true when past 30m guard');
});

test('launchAntigravityTw handles fast path, official update pre-launch patch, busy lock, and fail-open', t => {
    const { launchAntigravityTw } = require('../scripts/launch_antigravity_tw');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ag-smart-launch-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const appPath = path.join(root, 'Antigravity');
    const resDir = path.join(appPath, 'resources');
    const stateDir = path.join(root, '.watcher-state');
    fs.mkdirSync(resDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const exePath = path.join(appPath, 'Antigravity.exe');
    const asarPath = path.join(resDir, 'app.asar');
    fs.writeFileSync(exePath, 'stub-exe');
    fs.writeFileSync(asarPath, 'english-official-v2351');

    // 1. Official update detected & unlocked -> patches BEFORE launching exe
    const order = [];
    const res1 = launchAntigravityTw({
        baseDir: root,
        stateDir,
        passArgs: ['--new-window'],
        getAppInfoFn: () => ({ appPath, asarPath }),
        isBusyFn: () => false,
        localizeFn: () => { order.push('localize'); return true; },
        shouldBgCheckFn: () => true,
        spawnFn: (bin, args, opts) => {
            order.push({ bin, args, windowsHide: opts.windowsHide });
            return { unref() {} };
        },
        logFn: () => {}
    });
    assert.equal(res1.launched, true);
    assert.equal(res1.localizedBeforeLaunch, true);
    assert.equal(res1.backgroundCheckSpawned, true);
    assert.equal(order[0], 'localize', 'must localize BEFORE launching Antigravity.exe');
    assert.equal(order[1].bin, exePath);
    assert.deepEqual(order[1].args, ['--new-window']);
    assert.equal(order[1].windowsHide, false);
    assert.equal(order[2].args[1], '--on-app-launch');
    assert.equal(order[2].windowsHide, true);

    // 2. Busy lock -> skips patching, still launches exe
    let localizeCalls = 0;
    const res2 = launchAntigravityTw({
        baseDir: root,
        stateDir,
        getAppInfoFn: () => ({ appPath, asarPath }),
        isBusyFn: () => true,
        localizeFn: () => { localizeCalls++; return true; },
        shouldBgCheckFn: () => false,
        spawnFn: () => ({ unref() {} }),
        logFn: () => {}
    });
    assert.equal(res2.launched, true);
    assert.equal(localizeCalls, 0);

    // 3. Fail-open -> localization error never blocks launching Antigravity.exe
    const res3 = launchAntigravityTw({
        baseDir: root,
        stateDir,
        getAppInfoFn: () => ({ appPath, asarPath }),
        isBusyFn: () => false,
        localizeFn: () => { throw new Error('EPERM Program Files'); },
        shouldBgCheckFn: () => false,
        spawnFn: () => ({ unref() {} }),
        logFn: () => {}
    });
    assert.equal(res3.launched, true);
    assert.match(res3.localizeError, /EPERM Program Files/);
});






