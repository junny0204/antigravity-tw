#!/usr/bin/env node
'use strict';

// Zero-CPU OS-kernel event-driven watcher daemon for Windows (ReadDirectoryChangesW).
// Gives Windows the same effortless experience as macOS launchd WatchPaths:
//   - No extra Desktop shortcut required: users keep opening the normal Antigravity icon.
//   - Watch #1: watches the PARENT folder of Antigravity (e.g. %LOCALAPPDATA%\Programs)
//     recursively so we NEVER hold a directory handle on Antigravity\ or resources\,
//     ensuring official NSIS updates are never blocked while immediately detecting
//     when resources\app.asar is overwritten.
//   - Watch #2: watches %APPDATA%\Antigravity for Electron's `lockfile`:
//     * lockfile created -> user opened normal Antigravity -> runs --on-app-launch
//       translation check (30m anti-storm guard).
//     * lockfile deleted -> user closed Antigravity -> if an official update or new
//       translation pack was deferred due to lock (exit 75), immediately applies zh-TW
//       within ~2s so the very next normal launch is Traditional Chinese.
//   - Failsafe weekly check + single-instance PID file (.watcher-state/win-daemon.pid).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const watcher = require('../auto_localize_watcher');

const DIR = path.resolve(__dirname, '..');
const DEFAULT_DEBOUNCE_MS = 3000;
const DEFAULT_UNLOCK_POLL_MS = 5000;
const DEFAULT_FAST_UNLOCK_RETRY_MS = 500;
const DEFAULT_FAST_UNLOCK_MAX_ATTEMPTS = 24; // up to ~12s after lockfile disappears
const DEFAULT_SUPPRESS_SELF_MS = 6000;
const DEFAULT_PERIODIC_TICK_MS = 6 * 60 * 60 * 1000; // 6h wall-clock check (Sleep/Hibernate safe)

function normalizeRelPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return Boolean(err && err.code === 'EPERM');
    }
}

function readDaemonPid(pidFile) {
    try {
        if (!fs.existsSync(pidFile)) return null;
        const raw = fs.readFileSync(pidFile, 'utf8').trim();
        if (!raw) return null;
        if (raw.startsWith('{')) {
            const parsed = JSON.parse(raw);
            return Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
        }
        const n = Number(raw);
        return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
        return null;
    }
}

function acquireDaemonPid(pidFile, { currentPid = process.pid, isAliveFn = isProcessAlive } = {}) {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const existingPid = readDaemonPid(pidFile);
    if (existingPid && existingPid !== currentPid && isAliveFn(existingPid)) {
        return null;
    }
    const payload = JSON.stringify({
        pid: currentPid,
        startedAt: new Date().toISOString()
    }) + '\n';
    const tmp = `${pidFile}.${currentPid}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    try {
        fs.renameSync(tmp, pidFile);
    } catch {
        fs.copyFileSync(tmp, pidFile);
        try { fs.rmSync(tmp, { force: true }); } catch {}
    }
    return () => {
        try {
            if (readDaemonPid(pidFile) === currentPid) {
                fs.rmSync(pidFile, { force: true });
            }
        } catch {}
    };
}

function getWindowsProfileDirs(env = process.env) {
    const dirs = [];
    const appData = env && env.APPDATA ? String(env.APPDATA).trim() : '';
    if (appData) {
        dirs.push(
            path.join(appData, 'Antigravity'),
            path.join(appData, 'Antigravity IDE')
        );
    }
    return dirs;
}

function needsLocalLocalization(appInfo, {
    stateDir = path.join(DIR, '.watcher-state'),
    recipeFn = watcher.recipeHash
} = {}) {
    if (!appInfo || !appInfo.asarPath || !fs.existsSync(appInfo.asarPath)) return false;
    try {
        const buf = fs.readFileSync(appInfo.asarPath);
        if (!watcher.isLocalized(buf)) return true;
        const statePath = path.join(stateDir, watcher.digest(appInfo.appPath) + '.json');
        let prev = {};
        try { prev = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
        return prev.recipe !== recipeFn() || prev.output !== watcher.digest(buf);
    } catch {
        return false;
    }
}

function isWeeklyCheckDue(cacheFile, { intervalMs = watcher.WEEKLY_INTERVAL_MS, nowMs = Date.now() } = {}) {
    try {
        if (!fs.existsSync(cacheFile)) return true;
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (!cache || !Number.isFinite(cache.lastChecked)) return true;
        return (nowMs - cache.lastChecked) >= intervalMs;
    } catch {
        return true;
    }
}

function createEventWatcher({
    baseDir = DIR,
    stateDir = path.join(baseDir, '.watcher-state'),
    nodePath = process.execPath,
    watcherScript = path.join(baseDir, 'auto_localize_watcher.js'),
    getAppInfoFn = watcher.getAppInfo,
    isBusyFn = watcher.isWindowsAsarBusyForAtomicSwap,
    needsLocalFn = (info) => needsLocalLocalization(info, { stateDir }),
    shouldLaunchCheckFn = (cacheFile) => !fs.existsSync(cacheFile) || watcher.shouldForceAppLaunchCheck({ cacheFile }),
    profileDirs = getWindowsProfileDirs(),
    watchFn = fs.watch,
    spawnOnceFn = null,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    unlockPollMs = DEFAULT_UNLOCK_POLL_MS,
    fastUnlockRetryMs = DEFAULT_FAST_UNLOCK_RETRY_MS,
    fastUnlockMaxAttempts = DEFAULT_FAST_UNLOCK_MAX_ATTEMPTS,
    suppressSelfMs = DEFAULT_SUPPRESS_SELF_MS,
    periodicTickMs = DEFAULT_PERIODIC_TICK_MS,
    logFn = null
} = {}) {
    const logPath = path.join(baseDir, 'autolocalize.log');
    const cacheFile = path.join(stateDir, 'update_check.json');
    const disableFlag = path.join(baseDir, '.disable_autowatcher');
    const log = logFn || ((msg) => {
        try {
            watcher.rotateLogFileInPlace(logPath);
            fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + msg + '\n');
        } catch {}
    });

    const runChild = spawnOnceFn || (({ onAppLaunch = false, applyPending = false } = {}) => new Promise((resolve) => {
        const args = [watcherScript];
        if (onAppLaunch) args.push('--on-app-launch');
        if (applyPending) args.push('--apply-pending');
        const child = spawn(nodePath, args, {
            cwd: baseDir,
            stdio: 'ignore',
            windowsHide: true
        });
        child.on('error', (err) => resolve({ code: 1, error: err }));
        child.on('close', (code) => resolve({ code: code == null ? 1 : code }));
    }));

    const watchers = [];
    let stopped = false;
    let running = false;
    let pendingApply = false;
    let queuedRun = null;
    let suppressAsarUntil = 0;
    let asarDebounceTimer = null;
    let launchDebounceTimer = null;
    let unlockPollTimer = null;
    let fastUnlockTimer = null;
    let periodicTimer = null;
    let loggedPendingLock = false;
    let consecutiveErrors = 0;
    let currentAppInfo = getAppInfoFn();

    function clearTimer(t) {
        if (t) clearTimeout(t);
        return null;
    }

    function stopUnlockPoll() {
        if (unlockPollTimer) {
            clearInterval(unlockPollTimer);
            unlockPollTimer = null;
        }
        fastUnlockTimer = clearTimer(fastUnlockTimer);
    }

    function ensureUnlockPoll() {
        if (stopped || unlockPollTimer) return;
        unlockPollTimer = setInterval(() => {
            if (stopped) { stopUnlockPoll(); return; }
            if (fs.existsSync(disableFlag)) { stop(); return; }
            if (!pendingApply) { stopUnlockPoll(); return; }
            if (running) return;
            const info = currentAppInfo || getAppInfoFn();
            if (!info || !fs.existsSync(info.asarPath)) return;
            if (!isBusyFn(info.asarPath)) {
                stopUnlockPoll();
                triggerRun({ onAppLaunch: false, applyPending: true, reason: 'unlock_watchdog' });
            }
        }, unlockPollMs);
    }

    function scheduleFastUnlockApply(attempt = 0) {
        if (stopped) return;
        fastUnlockTimer = clearTimer(fastUnlockTimer);
        if (running) return;
        const info = currentAppInfo || getAppInfoFn();
        if (!info || !fs.existsSync(info.asarPath)) return;
        if (!pendingApply && !needsLocalFn(info)) return;
        if (!isBusyFn(info.asarPath)) {
            stopUnlockPoll();
            triggerRun({ onAppLaunch: false, applyPending: true, reason: 'app_closed' });
            return;
        }
        if (attempt < fastUnlockMaxAttempts) {
            fastUnlockTimer = setTimeout(() => scheduleFastUnlockApply(attempt + 1), fastUnlockRetryMs);
        } else {
            pendingApply = true;
            ensureUnlockPoll();
        }
    }

    async function triggerRun({ onAppLaunch = false, applyPending = false, reason = 'event' } = {}) {
        if (stopped) return null;
        if (fs.existsSync(disableFlag)) {
            stop();
            return null;
        }
        if (running) {
            // Coalesce concurrent requests, preserving onAppLaunch/applyPending flags
            queuedRun = {
                onAppLaunch: Boolean((queuedRun && queuedRun.onAppLaunch) || onAppLaunch),
                applyPending: Boolean((queuedRun && queuedRun.applyPending) || applyPending),
                reason
            };
            return null;
        }
        running = true;
        try {
            const res = await runChild({ onAppLaunch, applyPending, reason });
            const code = res && typeof res.code === 'number' ? res.code : 1;
            if (code === 0) {
                suppressAsarUntil = Date.now() + suppressSelfMs;
                pendingApply = false;
                loggedPendingLock = false;
                consecutiveErrors = 0;
                stopUnlockPoll();
            } else if (code === 75) {
                pendingApply = true;
                consecutiveErrors = 0;
                if (!loggedPendingLock) {
                    log('事件守護：偵測到待套用的繁中更新，將於 Antigravity 關閉後自動立即補套。');
                    loggedPendingLock = true;
                }
                ensureUnlockPoll();
            } else {
                consecutiveErrors++;
                const info = currentAppInfo || getAppInfoFn();
                if (info && needsLocalFn(info)) {
                    pendingApply = true;
                    if (consecutiveErrors <= 3) {
                        ensureUnlockPoll();
                    } else {
                        stopUnlockPoll();
                    }
                }
            }
            return res;
        } finally {
            running = false;
            if (!stopped && queuedRun) {
                const next = queuedRun;
                queuedRun = null;
                triggerRun(next);
            }
        }
    }

    function handleAsarWatchEvent(relTarget, filename) {
        if (stopped) return;
        const norm = normalizeRelPath(filename);
        if (!norm || norm !== relTarget) return;
        if (running || Date.now() < suppressAsarUntil) return;
        asarDebounceTimer = clearTimer(asarDebounceTimer);
        asarDebounceTimer = setTimeout(() => {
            if (stopped || running || Date.now() < suppressAsarUntil) return;
            const info = currentAppInfo || getAppInfoFn();
            if (!info || !fs.existsSync(info.asarPath)) return;
            if (!needsLocalFn(info)) return;
            if (isBusyFn(info.asarPath)) {
                pendingApply = true;
                if (!loggedPendingLock) {
                    log('事件守護：偵測到官方更新覆蓋 app.asar，待 Antigravity 關閉後將自動立即補回繁體中文。');
                    loggedPendingLock = true;
                }
                ensureUnlockPoll();
                return;
            }
            triggerRun({ onAppLaunch: false, reason: 'asar_changed' });
        }, debounceMs);
    }

    function handleLockfileEvent(lockfilePath, prevPresentRef) {
        if (stopped) return;
        const nowPresent = fs.existsSync(lockfilePath);
        const wasPresent = prevPresentRef.value;
        prevPresentRef.value = nowPresent;

        if (!nowPresent) {
            // Antigravity closed (lockfile removed)
            const info = currentAppInfo || getAppInfoFn();
            if (info && (pendingApply || needsLocalFn(info))) {
                fastUnlockTimer = clearTimer(fastUnlockTimer);
                fastUnlockTimer = setTimeout(() => scheduleFastUnlockApply(0), fastUnlockRetryMs);
            }
            return;
        }

        if (nowPresent && !wasPresent) {
            // Antigravity launched (lockfile created)
            launchDebounceTimer = clearTimer(launchDebounceTimer);
            launchDebounceTimer = setTimeout(() => {
                if (stopped) return;
                if (shouldLaunchCheckFn(cacheFile)) {
                    triggerRun({ onAppLaunch: true, reason: 'app_launch' });
                }
            }, 1500);
        }
    }

    function attachWatchers() {
        currentAppInfo = getAppInfoFn();
        if (currentAppInfo && currentAppInfo.appPath) {
            const parentDir = path.dirname(currentAppInfo.appPath);
            const relTarget = normalizeRelPath(path.relative(parentDir, currentAppInfo.asarPath));
            if (fs.existsSync(parentDir) && relTarget) {
                try {
                    const w = watchFn(parentDir, { recursive: true }, (_ev, filename) => {
                        handleAsarWatchEvent(relTarget, filename);
                    });
                    if (w && typeof w.on === 'function') w.on('error', () => {});
                    watchers.push(w);
                } catch {}
            }
        }

        for (const pDir of profileDirs) {
            if (!pDir || !fs.existsSync(pDir)) continue;
            const lockfilePath = path.join(pDir, 'lockfile');
            const prevPresentRef = { value: fs.existsSync(lockfilePath) };
            try {
                const w = watchFn(pDir, { recursive: false }, (_ev, filename) => {
                    if (normalizeRelPath(filename) !== 'lockfile') return;
                    handleLockfileEvent(lockfilePath, prevPresentRef);
                });
                if (w && typeof w.on === 'function') w.on('error', () => {});
                watchers.push(w);
            } catch {}
        }
    }

    function start({ runInitialCheck = true } = {}) {
        if (fs.existsSync(disableFlag)) {
            stopped = true;
            return false;
        }
        attachWatchers();
        periodicTimer = setInterval(() => {
            if (stopped) return;
            if (fs.existsSync(disableFlag)) { stop(); return; }
            const info = currentAppInfo || getAppInfoFn();
            if ((info && needsLocalFn(info)) || isWeeklyCheckDue(cacheFile)) {
                triggerRun({ onAppLaunch: false, reason: 'weekly_timer' });
            }
        }, periodicTickMs);
        if (runInitialCheck) {
            triggerRun({ onAppLaunch: false, reason: 'startup' });
        }
        return true;
    }

    function stop() {
        stopped = true;
        asarDebounceTimer = clearTimer(asarDebounceTimer);
        launchDebounceTimer = clearTimer(launchDebounceTimer);
        stopUnlockPoll();
        if (periodicTimer) {
            clearInterval(periodicTimer);
            periodicTimer = null;
        }
        while (watchers.length > 0) {
            const w = watchers.pop();
            try { if (w && typeof w.close === 'function') w.close(); } catch {}
        }
    }

    return {
        start,
        stop,
        triggerRun,
        handleAsarWatchEvent,
        handleLockfileEvent,
        getState: () => ({ stopped, running, pendingApply, watcherCount: watchers.length })
    };
}

function main() {
    const stateDir = path.join(DIR, '.watcher-state');
    const disableFlag = path.join(DIR, '.disable_autowatcher');
    if (fs.existsSync(disableFlag)) return;

    const pidFile = path.join(stateDir, 'win-daemon.pid');
    const releasePid = acquireDaemonPid(pidFile);
    if (!releasePid) {
        // Another live instance is already monitoring events; exit cleanly.
        return;
    }

    const daemon = createEventWatcher({ baseDir: DIR, stateDir });
    const shutdown = () => {
        daemon.stop();
        releasePid();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit', () => {
        daemon.stop();
        releasePid();
    });

    daemon.start({ runInitialCheck: true });
}

if (require.main === module) {
    main();
}

module.exports = {
    normalizeRelPath,
    isProcessAlive,
    readDaemonPid,
    acquireDaemonPid,
    getWindowsProfileDirs,
    needsLocalLocalization,
    isWeeklyCheckDue,
    createEventWatcher
};
