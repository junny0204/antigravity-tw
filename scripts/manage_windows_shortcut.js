// Windows Script Host (cscript.exe //B //NoLogo //E:JScript) Desktop shortcut manager.
// Parameters are passed via process environment variables (AG_SC_*) to avoid
// WSH double-slash (//...) argument hijacking and Win32 quote/Unicode mangling:
//   AG_SC_ACTION  : "create" | "remove"
//   AG_SC_PATH    : target .lnk path (prefix "__DESKTOP__\" for active Desktop)
//   AG_SC_TARGET  : TargetPath (create only)
//   AG_SC_ARGS    : Arguments (create only)
//   AG_SC_WORKDIR : WorkingDirectory (create only)
//   AG_SC_ICON    : IconLocation (optional, create only)
//   AG_SC_DESC    : Description (optional, create only)
var shell = WScript.CreateObject('WScript.Shell');
var env = shell.Environment('Process');

function getParam(name) {
    return String(env(name) || '');
}

var action = getParam('AG_SC_ACTION').toLowerCase();
var spec = getParam('AG_SC_PATH');
if (!action || !spec) {
    WScript.Quit(2);
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

var shortcutPath = resolveShortcutPath(spec);

if (action === 'create') {
    var targetPath = getParam('AG_SC_TARGET');
    var workingDir = getParam('AG_SC_WORKDIR');
    if (!targetPath || !workingDir) {
        WScript.Quit(2);
    }
    var sc = shell.CreateShortcut(shortcutPath);
    sc.TargetPath = targetPath;
    sc.Arguments = getParam('AG_SC_ARGS');
    sc.WorkingDirectory = workingDir;
    var iconLocation = getParam('AG_SC_ICON');
    if (iconLocation) {
        sc.IconLocation = iconLocation;
    }
    var description = getParam('AG_SC_DESC');
    if (description) {
        sc.Description = description;
    }
    sc.WindowStyle = 7;
    sc.Save();
    WScript.Quit(0);
} else if (action === 'remove') {
    var fso = WScript.CreateObject('Scripting.FileSystemObject');
    if (fso.FileExists(shortcutPath)) {
        fso.DeleteFile(shortcutPath, true);
    }
    WScript.Quit(0);
} else {
    WScript.Quit(2);
}
