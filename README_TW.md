# Antigravity 2.0 個人專屬台灣繁體中文（zh-TW）在地化套件

本專案整合 **[qqxpee/antigravity2-cn](https://github.com/qqxpee/antigravity2-cn)**（零依賴純 Node.js ASAR 核心引擎）與 **[atonnyshen/antigravity2-TW](https://github.com/atonnyshen/antigravity2-TW)**（台灣軟體體例詞庫、原子置換與跨平台背景守護），並加上 **GitHub Actions 上游自動同步＋台灣用語正規化＋個人詞彙覆蓋層**，同時支援 **Windows** 與 **macOS**。

---

## 核心特色

1. **原版 App 直接變繁中**：修改本機 `resources/app.asar` 並自動備份 `app.asar.bak`，不會多出第二個 App，也不影響登入狀態、專案與對話紀錄；隨時可一鍵還原官方英文。
2. **執行期零外部依賴**：安裝與常駐核心皆為純 Node.js（需求 Node.js `>= 22.12.0`），執行期無須 `npm install`。
3. **跨平台背景常駐更新（Windows & macOS）**：
   - **每 5 分鐘**：檢查 Antigravity 官方是否自動更新，若被覆蓋為英文則自動重套繁體中文（Windows 採 `ReplaceFileW`、macOS 採 `renamex_np` 原子交換＋本機 ad-hoc 簽章）。
   - **每 24 小時**：僅連線至 **本倉庫（`junny0204/antigravity-tw`）** 檢查新版純翻譯資料包，強制驗證 SHA-256 與詞庫安全規則後自動套用（**絕不自動下載執行遠端程式碼**）。
4. **上游自動同步流水線（GitHub Actions）**：
   - 每日自動比對 `qqxpee/antigravity2-cn` 與 `atonnyshen/antigravity2-TW` 更新。
   - 透過 `config/tw_glossary.json` 自動將新詞條轉換為台灣用語，並套用你的 `config/tw_overrides.json` 個人覆蓋設定。
   - **安全分流**：僅字典更新時通過全部測試後自動發布純翻譯 Release；若上游核心 `.js` 引擎變動，則自動開 PR 供人工檢視後合併。

---

## Windows 安裝與常駐指引

前置需求：已安裝 [Node.js LTS](https://nodejs.org/)（`>= 22.12.0`）。

1. 下載或 `git clone` 本倉庫：
   ```powershell
   git clone https://github.com/junny0204/antigravity-tw.git
   ```
2. **完全退出 Antigravity**（含系統匣右下角圖示右鍵結束）。
3. 進入資料夾，點兩下 **`點兩下安裝繁體中文.bat`** 完成繁體中文化。
4. 啟用背景常駐自動更新：點兩下 **`點兩下安裝Windows背景守護.bat`**。
5. 重新打開原本的 **Antigravity** 即可看到繁體中文介面。

- 卸載背景守護：點兩下 **`點兩下卸載Windows背景守護.bat`**
- 還原官方英文：點兩下 **`點兩下還原官方英文.bat`**

---

## macOS 安裝與常駐指引

前置需求：已安裝 Node.js `>= 22.12.0`（官方安裝包或 `brew install node`）。

### 最防呆一鍵安裝（推薦：免手動解壓、免處理雙擊權限）

打開 Mac 的「**終端機（Terminal）**」，直接複製貼上以下一行按 Enter，即可自動下載、安裝繁體中文並啟用背景自動更新：

```bash
git clone https://github.com/junny0204/antigravity-tw.git ~/antigravity-tw && cd ~/antigravity-tw && node localization_engine.js --tw --brand-title english && bash install_macos_autowatcher.sh
```

執行完成後，按 **`Cmd + Q`** 完全退出 Antigravity 並重新開啟即生效（若系統要求密碼，輸入 Mac 開機密碼即可）。

### 圖形化點兩下安裝（若已下載資料夾）

1. 執行一次繁體中文化：點兩下 **`點兩下安裝繁體中文.command`**。
2. 啟用背景常駐自動更新：點兩下 **`點兩下安裝macOS背景守護.command`**（或在終端機以 bash 執行 `install_macos_autowatcher.sh`）。
3. 按 `Cmd + Q` 完全退出 Antigravity 並重新開啟即可生效。

> 註：若 Antigravity 安裝於 `/Applications/` 且系統提示權限不足，請輸入管理員密碼或於「系統設定 → 隱私權與安全性 → App 管理」授權。若直接從瀏覽器下載 ZIP 解壓而遭 macOS Gatekeeper 攔截，可對 `.command` 檔按右鍵 →「開啟」，或改用上方終端機一行指令。

- 卸載背景守護：點兩下 **`點兩下卸載macOS背景守護.command`**
- 還原官方英文：點兩下 **`點兩下還原官方英文.command`**

---

## 客製個人用語（`config/tw_overrides.json`）

編輯 `config/tw_overrides.json` 即可永久保留你的用詞偏好，後續上游自動同步時不會被覆蓋：

```json
{
  "allowForbiddenTerms": ["渲染"],
  "termReplacements": {
    "算繪": "渲染"
  },
  "exactOverrides": {
    "Agent Manager": "Agent 管理員"
  }
}
```

修改後執行：
```bash
npm run sync
npm test
```

---

## 授權與致謝

本專案採 **MIT License**，完整保留並致謝以下上游開源專案（詳見 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)）：
- [qqxpee/antigravity2-cn](https://github.com/qqxpee/antigravity2-cn)（MIT）
- [atonnyshen/antigravity2-TW](https://github.com/atonnyshen/antigravity2-TW)（MIT）
