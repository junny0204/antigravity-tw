#!/bin/bash
set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
    echo "此安裝程式僅適用 macOS。" >&2
    exit 1
fi

MODE="auto"
for arg in "$@"; do
    case "$arg" in
        --user) MODE="user" ;;
        --daemon) MODE="daemon" ;;
        *) echo "不支援的安裝參數：${arg}。守護程序預設自動更新翻譯資料。" >&2; exit 1 ;;
    esac
done

IS_FD_SCRIPT=0
case "$0" in
    /dev/fd/*|/proc/self/fd/*|bash|-bash) IS_FD_SCRIPT=1 ;;
esac

if [ "$IS_FD_SCRIPT" -eq 0 ] && [ -f "$(dirname "$0")/auto_localize_watcher.js" ]; then
    DIR="$(cd "$(dirname "$0")" && pwd)"
elif [ "$IS_FD_SCRIPT" -eq 0 ] && [ -f "$PWD/auto_localize_watcher.js" ]; then
    DIR="$PWD"
else
    if [ "$EUID" -eq 0 ]; then
        echo "請先以一般使用者執行本安裝指令（需要管理員權限時腳本會自動提示輸入密碼）。" >&2
        exit 1
    fi
    DIR="$HOME/.antigravity-tw"
    HAS_GIT=0
    if xcode-select -p >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
        HAS_GIT=1
    fi
    if [ "$HAS_GIT" -eq 1 ] && [ -d "$DIR/.git" ] && git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "🔄 更新既有專案至最新版本..."
        git -C "$DIR" fetch --depth=1 origin main && git -C "$DIR" reset --hard origin/main
    else
        if [ -e "$DIR" ]; then
            BACKUP="${DIR}.bak-$(date +%Y%m%d%H%M%S)"
            echo "📦 發現既有目錄，已安全移至 ${BACKUP} 後重新取得最新版..."
            mv "$DIR" "$BACKUP"
        fi
        if [ "$HAS_GIT" -eq 1 ]; then
            echo "⬇️ 正在下載 antigravity-tw..."
            git clone https://github.com/junny0204/antigravity-tw.git "$DIR"
        else
            echo "⬇️ 未偵測到 Git，改用內建 curl 下載最新版本..."
            TMP_TAR="$(mktemp -d)"
            curl -fsSL "https://github.com/junny0204/antigravity-tw/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP_TAR"
            mv "$TMP_TAR"/antigravity-tw-* "$DIR"
            rm -rf "$TMP_TAR"
        fi
    fi
    exec bash "$DIR/install_macos_autowatcher.sh" "$@"
fi

cd "$DIR"

ACTUAL_USER="${SUDO_USER:-$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || echo "${USER:-}")}"
REAL_HOME="$HOME"
if [ -n "$ACTUAL_USER" ] && [ "$ACTUAL_USER" != "root" ] && [ "$ACTUAL_USER" != "loginwindow" ]; then
    DSCL_HOME="$(/usr/bin/dscl . -read "/Users/$ACTUAL_USER" NFSHomeDirectory 2>/dev/null | /usr/bin/sed 's/^NFSHomeDirectory: //' || true)"
    [ -n "$DSCL_HOME" ] && REAL_HOME="$DSCL_HOME"
fi

# 尋找可用的 Node.js 執行檔 (支援官方獨立安裝、Homebrew、nvm、volta、fnm、mise、asdf 或環境 PATH)
NODE_BIN=""
CANDIDATES=(
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "$REAL_HOME/.volta/bin/node"
    "$REAL_HOME/.fnm/current/bin/node"
    "$REAL_HOME/.local/share/mise/shims/node"
    "$REAL_HOME/.asdf/shims/node"
    "$HOME/.volta/bin/node"
    "$HOME/.fnm/current/bin/node"
    "$HOME/.local/share/mise/shims/node"
    "$HOME/.asdf/shims/node"
    "$(command -v node 2>/dev/null || true)"
)
for nvm_root in "$REAL_HOME/.nvm/versions/node" "$HOME/.nvm/versions/node"; do
    if [ -d "$nvm_root" ]; then
        while IFS= read -r nvm_node; do
            [ -n "$nvm_node" ] && CANDIDATES+=("$nvm_node")
        done < <(ls -1d "$nvm_root"/v*/bin/node 2>/dev/null | sort -r)
    fi
done
for prev_node in /Library/Application\ Support/Antigravity2TW/runtime.*/node; do
    if [ -x "$prev_node" ]; then
        CANDIDATES+=("$prev_node")
    fi
done

find_valid_node() {
    for cand in "$@"; do
        if [ -n "$cand" ] && [ -x "$cand" ]; then
            if "$cand" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<12)) process.exit(1)' 2>/dev/null; then
                NODE_BIN="$cand"
                return 0
            fi
        fi
    done
    return 1
}

find_valid_node "${CANDIDATES[@]}" || true

if [ -z "$NODE_BIN" ]; then
    BREW_BIN=""
    for b in "/opt/homebrew/bin/brew" "/usr/local/bin/brew" "$(command -v brew 2>/dev/null || true)"; do
        if [ -n "$b" ] && [ -x "$b" ]; then
            BREW_BIN="$b"
            break
        fi
    done
    if [ -n "$BREW_BIN" ] && [ "$EUID" -ne 0 ]; then
        echo "📦 未偵測到 Node.js 22.12+，正在透過 Homebrew 自動安裝 Node.js..."
        "$BREW_BIN" install node
        find_valid_node "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(command -v node 2>/dev/null || true)" || true
    fi
fi

if [ -z "$NODE_BIN" ]; then
    echo "請先安裝 Node.js 22.12+（請至 https://nodejs.org/ 下載 LTS 安裝包後再重貼一次指令）。" >&2
    exit 1
fi

LABEL="com.antigravity.autolocalize"
SYSTEM_PLIST="/Library/LaunchDaemons/$LABEL.plist"
ACTUAL_USER="${SUDO_USER:-$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || echo "$USER")}"
CURRENT_UID="$(id -u)"

# 若已有官方 app.asar 且尚未建立 .bak，在具寫入權限時預先備份，避免背景服務建立新檔遭遇權限阻礙
for cand_app in "/Applications/Antigravity.app" "/Applications/Antigravity IDE.app" "$HOME/Applications/Antigravity.app" "$HOME/Applications/Antigravity IDE.app"; do
    cand_asar="$cand_app/Contents/Resources/app.asar"
    cand_bak="$cand_asar.bak"
    if [ -f "$cand_asar" ] && [ ! -f "$cand_bak" ]; then
        if [ -w "$(dirname "$cand_asar")" ]; then
            /bin/cp "$cand_asar" "$cand_bak" 2>/dev/null || true
            /bin/chmod 644 "$cand_bak" 2>/dev/null || true
        fi
    fi
done

# 判定安裝模式：系統級 LaunchDaemon 或使用者級 LaunchAgent
IS_DAEMON=0
if [ "$MODE" = "daemon" ]; then
    IS_DAEMON=1
elif [ "$MODE" = "user" ]; then
    IS_DAEMON=0
else
    # auto mode：若已存在系統級 LaunchDaemon，預設沿用並升級該服務，避免新舊雙服務同時覆寫 app.asar
    if [ "$EUID" -eq 0 ] || [ -f "$SYSTEM_PLIST" ]; then
        IS_DAEMON=1
    else
        TARGET_ASAR="/Applications/Antigravity.app/Contents/Resources/app.asar"
        if [ -w "/Applications/Antigravity.app" ] || [ -w "$TARGET_ASAR" ] || [ ! -e "/Applications/Antigravity.app" ]; then
            IS_DAEMON=0
        else
            echo "偵測到目標應用程式需要管理員權限，嘗試提權..."
            exec sudo /bin/bash "$DIR/install_macos_autowatcher.sh" --daemon
        fi
    fi
fi

if [ "$IS_DAEMON" -eq 1 ] && [ "$EUID" -ne 0 ]; then
    echo "以管理員認證安裝系統服務..."
    exec sudo /bin/bash "$DIR/install_macos_autowatcher.sh" --daemon
fi

if [ "$IS_DAEMON" -eq 1 ]; then
    echo "🛡️ 安裝為系統級 LaunchDaemon 守護服務..."
    BASE="/Library/Application Support/Antigravity2TW"
    LOG_DIR="/Library/Logs/Antigravity2TW"
    PLIST="/Library/LaunchDaemons/$LABEL.plist"
    
    for target in "$BASE" "$LOG_DIR" "$PLIST"; do
        if [ -L "$target" ]; then
            echo "拒絕覆寫符號連結：$target" >&2
            exit 1
        fi
    done
    
    /usr/bin/install -d -o root -g wheel -m 755 "$BASE" "$LOG_DIR"
    /bin/chmod 755 "$BASE" "$LOG_DIR"
    if [ ! -f "$LOG_DIR/autolocalize.log" ]; then
        /usr/bin/install -o root -g wheel -m 644 /dev/null "$LOG_DIR/autolocalize.log"
    else
        /bin/chmod 644 "$LOG_DIR/autolocalize.log"
    fi
    
    RUNTIME="$(mktemp -d "$BASE/runtime.XXXXXX")"
    /bin/chmod 755 "$RUNTIME"
    if xcode-select -p >/dev/null 2>&1 && /usr/bin/otool -L "$NODE_BIN" 2>/dev/null | /usr/bin/grep -q '@rpath/'; then
        # Homebrew 動態連結版 Node.js 依賴 @rpath/libnode.*.dylib，無法單獨複製執行檔，改用原本的 Node 路徑
        DAEMON_NODE_BIN="$NODE_BIN"
    else
        DAEMON_NODE_BIN="$RUNTIME/node"
        /usr/bin/install -o root -g wheel -m 755 "$NODE_BIN" "$RUNTIME/node"
        if ! ("$RUNTIME/node" -v) >/dev/null 2>&1; then
            /bin/rm -f "$RUNTIME/node"
            DAEMON_NODE_BIN="$NODE_BIN"
        fi
    fi
    for file in auto_localize_watcher.js localization_engine.js package.json package-lock.json; do
        /usr/bin/install -o root -g wheel -m 644 "$DIR/$file" "$RUNTIME/$file"
    done
    for folder in config dicts dicts_tw rules node_modules src scripts; do
        if [ -d "$DIR/$folder" ]; then
            /bin/cp -R "$DIR/$folder" "$RUNTIME/$folder"
        fi
    done
    /usr/sbin/chown -R root:wheel "$RUNTIME"
    /bin/chmod -R go-w "$RUNTIME"
    /usr/bin/install -d -o root -g wheel -m 700 "$RUNTIME/.watcher-state"
    
    PLIST_TMP="$(mktemp "$BASE/launchd.XXXXXX")"
    cat > "$PLIST_TMP" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$DAEMON_NODE_BIN</string><string>$RUNTIME/auto_localize_watcher.js</string></array>
<key>WorkingDirectory</key><string>$RUNTIME</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/>
<key>WatchPaths</key><array>
<string>/Applications/Antigravity.app</string>
<string>/Applications/Antigravity.app/Contents/Resources/app.asar</string>
<string>/Applications/Antigravity IDE.app</string>
<string>/Applications/Antigravity IDE.app/Contents/Resources/app.asar</string>
</array>
<key>StartInterval</key><integer>300</integer>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>$LOG_DIR/autolocalize.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/autolocalize.log</string>
</dict></plist>
PLIST_EOF
    /usr/bin/plutil -lint "$PLIST_TMP"
    
    if [ "$ACTUAL_USER" != root ] && [ "$ACTUAL_USER" != loginwindow ]; then
        ACTUAL_UID="$(id -u "$ACTUAL_USER" 2>/dev/null || echo 501)"
        USER_DIR="$(/usr/bin/dscl . -read "/Users/$ACTUAL_USER" NFSHomeDirectory 2>/dev/null | /usr/bin/sed 's/^NFSHomeDirectory: //' || echo "$HOME")"
        AGENT="$USER_DIR/Library/LaunchAgents/$LABEL.plist"
        /bin/launchctl bootout "gui/$ACTUAL_UID/$LABEL" 2>/dev/null || true
        if [ -f "$AGENT" ]; then
            /bin/mv "$AGENT" "$AGENT.disabled-$(date +%Y%m%d%H%M%S)"
        fi
    fi
    
    /bin/launchctl bootout "system/$LABEL" 2>/dev/null || true
    if [ -f "$PLIST" ]; then
        /bin/cp "$PLIST" "$BASE/previous-launchd.plist"
    fi
    /usr/bin/install -o root -g wheel -m 644 "$PLIST_TMP" "$PLIST"
    /bin/rm -f "$PLIST_TMP"
    /bin/launchctl enable "system/$LABEL"
    # 預先檢查 macOS「App 管理」TCC 權限：若被 Apple 系統擋住，自動打開正確的系統設定頁面引導授權
    TARGET_RES="/Applications/Antigravity.app/Contents/Resources"
    if [ ! -d "$TARGET_RES" ] && [ -d "/Applications/Antigravity IDE.app/Contents/Resources" ]; then
        TARGET_RES="/Applications/Antigravity IDE.app/Contents/Resources"
    fi
    if [ -d "$TARGET_RES" ]; then
        PERM_PROBE="${TARGET_RES}/.agtw_perm_probe_$$"
        if ! /usr/bin/touch "$PERM_PROBE" 2>/dev/null; then
            if [ -n "$ACTUAL_USER" ] && [ "$ACTUAL_USER" != "root" ] && [ "$ACTUAL_USER" != "loginwindow" ]; then
                sudo -u "$ACTUAL_USER" /usr/bin/open "x-apple.systempreferences:com.apple.preference.security?Privacy_AppManagement" 2>/dev/null || true
            fi
            echo "" >&2
            echo "============================================================" >&2
            echo "🔒 macOS 尚未開啟「終端機」的 App 管理權限（Apple 系統規定，每台 Mac 只需開這一次）" >&2
            echo "👉 已幫你自動打開「系統設定 → 隱私權與安全性 → App 管理」視窗！" >&2
            echo "" >&2
            echo "請照這 3 步做完即可：" >&2
            echo "  1. 在剛打開的視窗中，把「終端機（Terminal）」的開關打開" >&2
            echo "     （若清單裡沒有，點左下角「+」→ 選「應用程式 / 工具程式 / 終端機」）" >&2
            echo "  2. 若系統跳出「結束並重新開啟」，點選它重開終端機" >&2
            echo "  3. 回到終端機再貼一次剛剛那行指令按 Enter，就會立刻安裝完成！" >&2
            echo "============================================================" >&2
            exit 1
        else
            /bin/rm -f "$PERM_PROBE" 2>/dev/null || true
        fi
    fi
    echo "🌐 正在立即套用繁體中文介面（使用 ${DAEMON_NODE_BIN}）..."
    APPLY_OK=1
    if ! "$DAEMON_NODE_BIN" "$RUNTIME/auto_localize_watcher.js"; then
        APPLY_OK=0
        echo "⚠️ 立即套用繁體中文時發生錯誤，請檢查上方輸出或日誌：${LOG_DIR}/autolocalize.log" >&2
    fi
    /bin/launchctl bootstrap system "$PLIST"
    /bin/launchctl print "system/$LABEL" >/dev/null
    for old_rt in "$BASE"/runtime.*; do
        if [ -d "$old_rt" ] && [ "$old_rt" != "$RUNTIME" ]; then
            /bin/rm -rf "$old_rt" 2>/dev/null || true
        fi
    done
    if [ "$APPLY_OK" -eq 1 ]; then
        echo "🎉 繁體中文與系統級背景守護已全部安裝完成！"
        echo "👉 請按 Cmd+Q 完全結束 Antigravity 再重新開啟，即可看到繁體中文介面。"
        echo "日誌路徑：${LOG_DIR}/autolocalize.log"
    else
        echo "❌ 背景守護已註冊，但本次套用繁體中文未成功，請檢視上方錯誤訊息或日誌：${LOG_DIR}/autolocalize.log" >&2
        exit 1
    fi
else
    echo "👤 安裝為使用者級 LaunchAgent 守護服務..."
    if [ -f "$SYSTEM_PLIST" ]; then
        echo "⚡ 偵測到舊版系統級 LaunchDaemon ($SYSTEM_PLIST)，正在停止並移除以避免雙服務衝突..."
        sudo /bin/launchctl bootout "system/$LABEL" 2>/dev/null || true
        sudo /bin/mv "$SYSTEM_PLIST" "$SYSTEM_PLIST.disabled-$(date +%Y%m%d%H%M%S)"
    fi

    USER_HOME="$HOME"
    TARGET_DIR="$USER_HOME/Library/LaunchAgents"
    PLIST="$TARGET_DIR/$LABEL.plist"
    LOG_DIR="$USER_HOME/Library/Logs/Antigravity2TW"
    BASE="$USER_HOME/Library/Application Support/Antigravity2TW"
    
    mkdir -p "$TARGET_DIR" "$LOG_DIR" "$BASE"
    chmod 755 "$TARGET_DIR" "$LOG_DIR" "$BASE"
    touch "$LOG_DIR/autolocalize.log"
    chmod 644 "$LOG_DIR/autolocalize.log"
    
    RUNTIME="$BASE/runtime"
    /bin/launchctl bootout "gui/$CURRENT_UID/$LABEL" 2>/dev/null || true
    mkdir -p "$RUNTIME"
    for file in auto_localize_watcher.js localization_engine.js package.json package-lock.json; do
        cp "$DIR/$file" "$RUNTIME/$file"
    done
    for folder in config dicts dicts_tw rules node_modules src scripts; do
        rm -rf "$RUNTIME/$folder"
        if [ -d "$DIR/$folder" ]; then
            cp -R "$DIR/$folder" "$RUNTIME/$folder"
        fi
    done
    mkdir -p "$RUNTIME/.watcher-state"
    rm -f "$RUNTIME/.watcher-state/update_policy.json"
    
    PLIST_TMP="$(mktemp "$BASE/launchd.XXXXXX")"
    cat > "$PLIST_TMP" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$RUNTIME/auto_localize_watcher.js</string></array>
<key>WorkingDirectory</key><string>$RUNTIME</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/>
<key>WatchPaths</key><array>
<string>/Applications/Antigravity.app</string>
<string>/Applications/Antigravity.app/Contents/Resources/app.asar</string>
<string>/Applications/Antigravity IDE.app</string>
<string>/Applications/Antigravity IDE.app/Contents/Resources/app.asar</string>
<string>$USER_HOME/Applications/Antigravity.app</string>
<string>$USER_HOME/Applications/Antigravity.app/Contents/Resources/app.asar</string>
<string>$USER_HOME/Applications/Antigravity IDE.app</string>
<string>$USER_HOME/Applications/Antigravity IDE.app/Contents/Resources/app.asar</string>
</array>
<key>StartInterval</key><integer>300</integer>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>$LOG_DIR/autolocalize.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/autolocalize.log</string>
</dict></plist>
PLIST_EOF
    /usr/bin/plutil -lint "$PLIST_TMP"
    
    /bin/launchctl bootout "gui/$CURRENT_UID/$LABEL" 2>/dev/null || true
    mv "$PLIST_TMP" "$PLIST"
    chmod 644 "$PLIST"
    /bin/launchctl enable "gui/$CURRENT_UID/$LABEL" 2>/dev/null || true
    TARGET_RES="/Applications/Antigravity.app/Contents/Resources"
    if [ ! -d "$TARGET_RES" ] && [ -d "$USER_HOME/Applications/Antigravity.app/Contents/Resources" ]; then
        TARGET_RES="$USER_HOME/Applications/Antigravity.app/Contents/Resources"
    fi
    if [ -d "$TARGET_RES" ]; then
        PERM_PROBE="${TARGET_RES}/.agtw_perm_probe_$$"
        if ! /usr/bin/touch "$PERM_PROBE" 2>/dev/null; then
            /usr/bin/open "x-apple.systempreferences:com.apple.preference.security?Privacy_AppManagement" 2>/dev/null || true
            echo "" >&2
            echo "============================================================" >&2
            echo "🔒 macOS 尚未開啟「終端機」的 App 管理權限（Apple 系統規定，每台 Mac 只需開這一次）" >&2
            echo "👉 已幫你自動打開「系統設定 → 隱私權與安全性 → App 管理」視窗！" >&2
            echo "" >&2
            echo "請照這 3 步做完即可：" >&2
            echo "  1. 在剛打開的視窗中，把「終端機（Terminal）」的開關打開" >&2
            echo "     （若清單裡沒有，點左下角「+」→ 選「應用程式 / 工具程式 / 終端機」）" >&2
            echo "  2. 若系統跳出「結束並重新開啟」，點選它重開終端機" >&2
            echo "  3. 回到終端機再貼一次剛剛那行指令按 Enter，就會立刻安裝完成！" >&2
            echo "============================================================" >&2
            exit 1
        else
            /bin/rm -f "$PERM_PROBE" 2>/dev/null || true
        fi
    fi
    echo "🌐 正在立即套用繁體中文介面（使用 ${NODE_BIN}）..."
    APPLY_OK=1
    if ! "$NODE_BIN" "$RUNTIME/auto_localize_watcher.js"; then
        APPLY_OK=0
        echo "⚠️ 立即套用繁體中文時發生錯誤，請檢查上方輸出或日誌：${LOG_DIR}/autolocalize.log" >&2
    fi
    /bin/launchctl bootstrap "gui/$CURRENT_UID" "$PLIST"
    /bin/launchctl print "gui/$CURRENT_UID/$LABEL" >/dev/null
    if [ "$APPLY_OK" -eq 1 ]; then
        echo "🎉 繁體中文與背景守護已全部安裝完成！"
        echo "👉 請按 Cmd+Q 完全結束 Antigravity 再重新開啟，即可看到繁體中文介面。"
        echo "日誌路徑：${LOG_DIR}/autolocalize.log"
    else
        echo "❌ 背景守護已註冊，但本次套用繁體中文未成功，請檢視上方錯誤訊息或日誌：${LOG_DIR}/autolocalize.log" >&2
        exit 1
    fi
fi
