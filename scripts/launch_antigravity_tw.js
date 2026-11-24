#!/usr/bin/env node
'use strict';

// Silent smart launcher for Antigravity 2.0 on Windows.
// Invoked by the Desktop shortcut via wscript.exe + scripts/run_silent_watcher.js:
//   1. Fast path (~25ms): if app.asar is already localized with the latest local recipe,
//      immediately launch Antigravity.exe and optionally run a detached background
//      translation-pack check (--on-app-launch, rate-limited by 30m anti-storm guard).
//   2. Official-update path: if official update overwrote app.asar with English and
//      Antigravity is not currently locking app.asar, synchronously re-apply zh-TW
//      (~2-3s, completely unlocked) BEFORE launching Antigravity.exe so the user
//      immediately opens into Traditional Chinese.
//   3. Fail-open guarantee: unexpected localization errors are logged to autolocalize.log
//      but NEVER prevent Antigravity.exe from launching.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const watcher = require('../auto_localize_watcher');

const DIR = path.resolve(__dirname, '..');

function resolveAntigravityExe(appInfo) {
    if (!appInfo || !appInfo.appPath) return null;
    for (const exeName of ['Antigravity.exe', 'Antigravity IDE.exe']) {
        const candidate = path.join(appInfo.appPath, exeName);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function needsLocalizationCheck(appInfo, {
    stateDir = path.join(DIR, '.watcher-state'),
    recipe = watcher.recipeHash()
} = {}) {
    if (!appInfo || !appInfo.asarPath || !fs.existsSync(appInfo.asarPath)) {
        return { needed: false, reason: 'missing_asar' };
    }
    const buf = fs.readFileSync(appInfo.asarPath);
    if (!watcher.isLocalized(buf)) {
        return { needed: true, reason: 'official_update' };
    }
    const statePath = path.join(stateDir, watcher.digest(appInfo.appPath) + '.json');
    let previous = {};
    try {
        previous = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {}
    if (previous.recipe !== recipe || previous.output !== watcher.digest(buf)) {
        return { needed: true, reason: 'recipe_changed' };
    }
    return { needed: false, reason: 'up_to_date' };
}

function shouldSpawnBackgroundCheck({
    baseDir = DIR,
    stateDir = path.join(baseDir, '.watcher-state')
} = {}) {
    if (fs.existsSync(path.join(baseDir, '.disable_autowatcher'))) return false;
    const cacheFile = path.join(stateDir, 'update_check.json');
    if (!fs.existsSync(cacheFile)) return true;
    return watcher.shouldForceAppLaunchCheck({ cacheFile });
}

function launchAntigravityTw({
    baseDir = DIR,
    stateDir = path.join(baseDir, '.watcher-state'),
    passArgs = [],
    getAppInfoFn = watcher.getAppInfo,
    resolveExeFn = resolveAntigravityExe,
    needsCheckFn = needsLocalizationCheck,
    isBusyFn = watcher.isWindowsAsarBusyForAtomicSwap,
    localizeFn = watcher.checkAndLocalizeApp,
    shouldBgCheckFn = shouldSpawnBackgroundCheck,
    spawnFn = spawn,
    nodePath = process.execPath,
    logFn = (msg) => {
        try {
            const lp = path.join(baseDir, 'autolocalize.log');
            watcher.rotateLogFileInPlace(lp);
            fs.appendFileSync(lp, '[' + new Date().toISOString() + '] ' + msg + '\n');
        } catch {}
    }
} = {}) {
    const appInfo = getAppInfoFn();
    if (!appInfo) {
        logFn('繁中啟動器：找不到 Antigravity 安裝路徑，無法啟動。');
        return { launched: false, reason: 'app_not_found' };
    }
    const exePath = resolveExeFn(appInfo);
    if (!exePath) {
        logFn('繁中啟動器：找不到 Antigravity.exe：' + appInfo.appPath);
        return { launched: false, reason: 'exe_not_found' };
    }

    let localizedBeforeLaunch = false;
    let localizeError = null;
    try {
        const status = needsCheckFn(appInfo, { stateDir });
        if (status.needed) {
            if (isBusyFn(appInfo.asarPath)) {
                logFn('繁中啟動器：偵測到 Antigravity 已在執行中，略過覆寫並直接切換視窗。');
            } else {
                logFn(status.reason === 'official_update'
                    ? '繁中啟動器：偵測到官方更新覆蓋英文版，啟動前立即自動補套繁體中文...'
                    : '繁中啟動器：偵測到新版繁中詞庫，啟動前立即自動更新...');
                localizedBeforeLaunch = Boolean(localizeFn(appInfo, { stateDir }));
            }
        }
    } catch (err) {
        localizeError = err;
        logFn('繁中啟動器：啟動前自動繁中化未完成（仍照常啟動程式）：' + (err && err.message ? err.message : err));
    }

    const appChild = spawnFn(exePath, passArgs, {
        cwd: appInfo.appPath,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
    });
    if (appChild && typeof appChild.unref === 'function') {
        appChild.unref();
    }

    let backgroundCheckSpawned = false;
    try {
        if (shouldBgCheckFn({ baseDir, stateDir })) {
            const bgChild = spawnFn(nodePath, [path.join(baseDir, 'auto_localize_watcher.js'), '--on-app-launch'], {
                cwd: baseDir,
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            if (bgChild && typeof bgChild.unref === 'function') {
                bgChild.unref();
            }
            backgroundCheckSpawned = true;
        }
    } catch {}

    return {
        launched: true,
        exePath,
        localizedBeforeLaunch,
        backgroundCheckSpawned,
        localizeError: localizeError ? (localizeError.message || String(localizeError)) : null
    };
}

if (require.main === module) {
    const res = launchAntigravityTw({ passArgs: process.argv.slice(2) });
    if (!res.launched) {
        process.exitCode = 1;
    }
}

module.exports = {
    resolveAntigravityExe,
    needsLocalizationCheck,
    shouldSpawnBackgroundCheck,
    launchAntigravityTw
};
