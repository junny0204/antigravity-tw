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

    [DllImport("kernel32.dll", EntryPoint="MoveFileExW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool MoveNoOverwrite(string existingFileName, string newFileName, uint flags);
}
'@
Add-Type -TypeDefinition $interop
if (-not [AntigravityAtomicReplace]::Replace(
    $Live, $Replacement, $Previous, 0,
    [IntPtr]::Zero, [IntPtr]::Zero)) {
    $errno = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    # Win32 error 32 (ERROR_SHARING_VIOLATION): Electron/Antigravity.exe opens
    # app.asar with FILE_SHARE_READ | FILE_SHARE_DELETE, which blocks ReplaceFileW
    # while allowing strict no-overwrite MoveFileExW(flags=0) displacement on NTFS.
    if ($errno -eq 32) {
        if (-not [AntigravityAtomicReplace]::MoveNoOverwrite($Live, $Previous, 0)) {
            $moveErr1 = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "ReplaceFileW sharing violation (32); MoveFileExW displace failed (Win32 error $moveErr1)"
        }
        if (-not [AntigravityAtomicReplace]::MoveNoOverwrite($Replacement, $Live, 0)) {
            $moveErr2 = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if (-not [System.IO.File]::Exists($Live)) {
                [void][AntigravityAtomicReplace]::MoveNoOverwrite($Previous, $Live, 0)
            }
            throw "ReplaceFileW sharing violation (32); MoveFileExW promote failed (Win32 error $moveErr2)"
        }
    } else {
        throw "ReplaceFileW failed (Win32 error $errno)"
    }
}
