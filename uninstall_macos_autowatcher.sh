#!/bin/bash
set -euo pipefail
LABEL="com.antigravity.autolocalize"
SYSTEM_PLIST="/Library/LaunchDaemons/${LABEL}.plist"

ACTUAL_USER="${SUDO_USER:-$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || echo "${USER:-}")}"
USER_HOME="$HOME"
ACTUAL_UID="$(id -u)"
if [ -n "$ACTUAL_USER" ] && [ "$ACTUAL_USER" != "root" ] && [ "$ACTUAL_USER" != "loginwindow" ]; then
    ACTUAL_UID="$(id -u "$ACTUAL_USER" 2>/dev/null || echo "$ACTUAL_UID")"
    DSCL_HOME="$(/usr/bin/dscl . -read "/Users/${ACTUAL_USER}" NFSHomeDirectory 2>/dev/null | /usr/bin/sed 's/^NFSHomeDirectory: //' || true)"
    if [ -n "$DSCL_HOME" ]; then
        USER_HOME="$DSCL_HOME"
    fi
fi
USER_PLIST="${USER_HOME}/Library/LaunchAgents/${LABEL}.plist"

# 卸載真實使用者的 LaunchAgent（即使目前透過 sudo 執行也能正確定位）
if [ -f "$USER_PLIST" ] || /bin/launchctl print "gui/${ACTUAL_UID}/${LABEL}" >/dev/null 2>&1; then
    /bin/launchctl bootout "gui/${ACTUAL_UID}/${LABEL}" 2>/dev/null || true
    if [ -f "$USER_PLIST" ]; then
        /bin/mv "$USER_PLIST" "${USER_PLIST}.disabled-$(date +%Y%m%d%H%M%S)"
    fi
    /bin/rm -rf "${USER_HOME}/Library/Application Support/Antigravity2TW/runtime" 2>/dev/null || true
    echo "已停用使用者級 LaunchAgent。"
fi

# 卸載系統級 LaunchDaemon (若有管理員權限)
if [ "$EUID" -eq 0 ]; then
    /bin/launchctl bootout "system/${LABEL}" 2>/dev/null || true
    if [ -f "$SYSTEM_PLIST" ]; then
        /bin/mv "$SYSTEM_PLIST" "${SYSTEM_PLIST}.disabled-$(date +%Y%m%d%H%M%S)"
    fi
    /bin/rm -rf "/Library/Application Support/Antigravity2TW"/runtime.* 2>/dev/null || true
    echo "已停用系統級 LaunchDaemon。"
elif [ -f "$SYSTEM_PLIST" ]; then
    echo "提示：系統中尚有系統級 LaunchDaemon (${SYSTEM_PLIST})，若需完全移除請以 sudo 執行此腳本。"
fi

echo "守護服務清理完成。"
