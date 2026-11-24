// Windows Script Host (cscript.exe //B //NoLogo //E:JScript) Desktop shortcut manager.
// Reads parameters from a UTF-16LE (BOM) config file passed as WScript.Arguments(0)
// so CJK/Unicode shortcut names work on every Windows locale (including en-US CP1252).
// Because wshom.ocx CreateShortcut().Save() fails silently when the .lnk filename
// contains characters outside CP_ACP, we save to an ASCII temp .lnk first and move
// it into place with Scripting.FileSystemObject (Unicode Win32 CopyFileW/DeleteFileW).
var shell = WScript.CreateObject('WScript.Shell');
var fso = WScript.CreateObject('Scripting.FileSystemObject');
var env = shell.Environment('Process');

function readConfig() {
    if (WScript.Arguments.length >= 1) {
        var cfgPath = String(WScript.Arguments(0));
        if (cfgPath && fso.FileExists(cfgPath)) {
            var ts = fso.OpenTextFile(cfgPath, 1, false, -1); // TristateTrue = UTF-16LE
            var raw = ts.ReadAll();
            ts.Close();
            var lines = raw.replace(/\r\n/g, '\n').split('\n');
            return {
                action: String(lines[0] || '').toLowerCase(),
                spec: String(lines[1] || ''),
                targetPath: String(lines[2] || ''),
                shortcutArgs: String(lines[3] || ''),
                workingDir: String(lines[4] || ''),
                iconLocation: String(lines[5] || ''),
                description: String(lines[6] || '')
            };
        }
    }
    return {
        action: String(env('AG_SC_ACTION') || '').toLowerCase(),
        spec: String(env('AG_SC_PATH') || ''),
        targetPath: String(env('AG_SC_TARGET') || ''),
        shortcutArgs: String(env('AG_SC_ARGS') || ''),
        workingDir: String(env('AG_SC_WORKDIR') || ''),
        iconLocation: String(env('AG_SC_ICON') || ''),
        description: String(env('AG_SC_DESC') || '')
    };
}

function resolveShortcutPath(rawSpec) {
    if (rawSpec.indexOf('__DESKTOP__\\') === 0 || rawSpec.indexOf('__DESKTOP__/') === 0) {
        var desktop = '';
        try {
            desktop = String(shell.SpecialFolders('Desktop') || '');
        } catch (e) {}
        if (!desktop) {
            desktop = shell.ExpandEnvironmentStrings('%USERPROFILE%\\Desktop');
        }
        return desktop + '\\' + rawSpec.substring('__DESKTOP__\\'.length).replace(/\//g, '\\');
    }
    return rawSpec;
}

var cfg = readConfig();
if (!cfg.action || !cfg.spec) {
    WScript.Quit(2);
}

var shortcutPath = resolveShortcutPath(cfg.spec);

if (cfg.action === 'create') {
    if (!cfg.targetPath || !cfg.workingDir) {
        WScript.Quit(2);
    }
    var tempFolder = fso.GetSpecialFolder(2);
    var tempBase = '';
    try { tempBase = String(tempFolder.ShortPath || ''); } catch (e) {}
    if (!tempBase) tempBase = String(tempFolder.Path);
    var tmpLnk = fso.BuildPath(tempBase, 'ag_sc_' + (new Date().getTime()) + '_' + Math.floor(Math.random() * 1000000) + '.lnk');

    try {
        var sc = shell.CreateShortcut(tmpLnk);
        sc.TargetPath = cfg.targetPath;
        sc.Arguments = cfg.shortcutArgs;
        sc.WorkingDirectory = cfg.workingDir;
        if (cfg.iconLocation) {
            sc.IconLocation = cfg.iconLocation;
        }
        if (cfg.description) {
            sc.Description = cfg.description;
        }
        sc.WindowStyle = 7;
        sc.Save();
        if (!fso.FileExists(tmpLnk)) {
            WScript.Quit(3);
        }
        fso.CopyFile(tmpLnk, shortcutPath, true);
    } finally {
        try {
            if (fso.FileExists(tmpLnk)) {
                fso.DeleteFile(tmpLnk, true);
            }
        } catch (e) {}
    }
    WScript.Quit(0);
} else if (cfg.action === 'remove') {
    if (fso.FileExists(shortcutPath)) {
        fso.DeleteFile(shortcutPath, true);
    }
    WScript.Quit(0);
} else {
    WScript.Quit(2);
}
