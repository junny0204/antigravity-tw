#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="${SCRIPT_DIR}/$(basename "$0")"
cd "$SCRIPT_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

TARGET_USER="${SUDO_USER:-$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || echo "${USER:-}")}"
USER_HOME="$HOME"
CURRENT_UID="$(id -u)"
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ] && [ "$TARGET_USER" != "loginwindow" ]; then
    DSCL_HOME="$(/usr/bin/dscl . -read "/Users/${TARGET_USER}" NFSHomeDirectory 2>/dev/null | /usr/bin/sed 's/^NFSHomeDirectory: //' || true)"
    [ -n "$DSCL_HOME" ] && USER_HOME="$DSCL_HOME"
fi

# 尋找可用的 Node.js 22.12+ 執行檔（涵蓋 Homebrew、官方安裝包、volta、fnm、mise、asdf、nvm）
NODE_BIN=""
CANDIDATES=(
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "${USER_HOME}/.volta/bin/node"
    "${USER_HOME}/.fnm/current/bin/node"
    "${USER_HOME}/.local/share/mise/shims/node"
    "${USER_HOME}/.asdf/shims/node"
    "$(command -v node 2>/dev/null || true)"
)
if [ -d "${USER_HOME}/.nvm/versions/node" ]; then
    while IFS= read -r nvm_node; do
        [ -n "$nvm_node" ] && CANDIDATES+=("$nvm_node")
    done < <(ls -1d "${USER_HOME}/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -r)
fi
for cand in "${CANDIDATES[@]}"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
        if "$cand" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<12)) process.exit(1)' 2>/dev/null; then
            NODE_BIN="$cand"
            break
        fi
    fi
done

if [ -z "$NODE_BIN" ]; then
    echo "❌ 未偵測到 Node.js 22.12+，請先安裝 Node.js LTS（https://nodejs.org/）後再重試。"
    read -n 1 -s || true
    exit 1
fi

NEED_SUDO=0
if [ "$EUID" -ne 0 ]; then
    if [ -f "/Library/LaunchDaemons/com.antigravity.autolocalize.plist" ]; then
        NEED_SUDO=1
    else
        DETECTED_APP=""
        for app_cand in "/Applications/Antigravity.app" "/Applications/Antigravity IDE.app" "${USER_HOME}/Applications/Antigravity.app" "${USER_HOME}/Applications/Antigravity IDE.app"; do
            if [ -d "$app_cand" ]; then
                DETECTED_APP="$app_cand"
                break
            fi
        done
        if [ -n "$DETECTED_APP" ]; then
            for check_target in \
                "$DETECTED_APP" \
                "${DETECTED_APP}/Contents" \
                "${DETECTED_APP}/Contents/Info.plist" \
                "${DETECTED_APP}/Contents/Resources" \
                "${DETECTED_APP}/Contents/Resources/app.asar" \
                "${DETECTED_APP}/Contents/Resources/app.asar.bak" \
                "${DETECTED_APP}/Contents/_CodeSignature"; do
                if [ -e "$check_target" ]; then
                    OWNER_UID="$(/usr/bin/stat -f%u "$check_target" 2>/dev/null || echo 0)"
                    if [ "$OWNER_UID" != "$CURRENT_UID" ]; then
                        NEED_SUDO=1
                        break
                    fi
                fi
            done
        fi
    fi
fi

if [ "$NEED_SUDO" -eq 1 ]; then
    echo "======================================================"
    echo " 提示：macOS 修改應用程式（/Applications）需要管理員權限"
    echo " 請在下方輸入您的電腦開機密碼（輸入時畫面不會顯示密碼，直接按 Enter）："
    echo "======================================================"
    exec sudo env "PATH=$(dirname "$NODE_BIN"):$PATH" bash "$SCRIPT_PATH" "$@"
fi

# 若背景守護服務正在執行，先自動卸載，避免還原後被背景守護再次自動中文化
UNINSTALL_WARN=0
if [ -f "/Library/LaunchDaemons/com.antigravity.autolocalize.plist" ] || [ -f "${USER_HOME}/Library/LaunchAgents/com.antigravity.autolocalize.plist" ]; then
    echo "⚡ 偵測到背景自動更新守護服務正在運作。"
    echo "   為防止還原後背景守護再度將其自動重套繁中，正在為您同步停止並卸載守護服務..."
    if ! bash ./uninstall_macos_autowatcher.sh; then
        UNINSTALL_WARN=1
        echo "⚠️ 背景守護服務卸載過程回報錯誤！請留意上方訊息，避免之後再次自動套用繁體中文。" >&2
    fi
    echo ""
fi

echo "======================================================"
echo "    正在還原 macOS 版 Antigravity 官方原版英文"
echo "======================================================"
"$NODE_BIN" localization_engine.js --tw --huifu "$@"

if [ $? -ne 0 ]; then
    echo ""
    echo "❌ 執行失敗！請檢查上方錯誤訊息。"
    read -n 1 -s || true
    exit 1
fi

echo ""
if [ "$UNINSTALL_WARN" -eq 1 ]; then
    echo "⚠️ 官方英文已還原，但背景守護卸載未完全成功，請手動執行「點兩下卸載macOS背景守護.command」確認。"
    echo "請按任意鍵離開..."
    read -n 1 -s || true
else
    echo "🎉 處理完成！視窗將在 5 秒後自動關閉（或按任意鍵立即關閉）..."
    read -t 5 -n 1 -s || true
fi
