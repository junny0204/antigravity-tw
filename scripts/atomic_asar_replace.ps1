# Windows ReplaceFileW: atomically replace live ASAR while retaining its
# previous bytes at a separate backup path. Fail closed if unavailable.
param(
    [Parameter(Mandatory=$true)][string]$Replacement,
    [Parameter(Mandatory=$true)][string]$Live,
    [Parameter(Mandatory=$true)][string]$Previous
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$interop = @'
using System;
using System.Runtime.InteropServices;
public static class AntigravityAtomicReplace {
    [DllImport("kernel32.dll", EntryPoint="ReplaceFileW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Replace(string target, string replacement, string backup,
        uint flags, IntPtr excluded, IntPtr reserved);
}
'@
Add-Type -TypeDefinition $interop
$maxAttempts = 6
$errno = 0
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if ([AntigravityAtomicReplace]::Replace(
        $Live, $Replacement, $Previous, 0,
        [IntPtr]::Zero, [IntPtr]::Zero)) {
        exit 0
    }
    $errno = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    # Retry briefly only for transient sharing locks (e.g. AV scanner) when no partial backup was created.
    if ($errno -eq 32 -and -not [System.IO.File]::Exists($Previous) -and $attempt -lt $maxAttempts) {
        Start-Sleep -Milliseconds 150
        continue
    }
    throw "ReplaceFileW failed (Win32 error $errno)"
}
throw "ReplaceFileW failed (Win32 error $errno)"
