// Windows Script Host (wscript.exe //B //NoLogo //E:JScript) silent launcher.
// Runs node.exe with window style 0 (SW_HIDE) so the background event watcher
// daemon never flashes a console window or steals focus on Windows.
var args = WScript.Arguments;
if (args.length < 2) {
    WScript.Quit(2);
}
function quoteArg(val) {
    var str = String(val);
    // Win32 CommandLineToArgvW: double backslashes before a quote or end-of-arg
    var escaped = str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
    return '"' + escaped + '"';
}
var parts = [];
for (var i = 0; i < args.length; i++) {
    parts.push(quoteArg(args(i)));
}
var shell = WScript.CreateObject('WScript.Shell');
var exitCode = shell.Run(parts.join(' '), 0, true);
WScript.Quit(exitCode);
