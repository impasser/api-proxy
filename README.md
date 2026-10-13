# API Proxy 容器化部署指南

本專案是一個專為 VS Code Copilot / Claude 轉發到自建 API 端點（如 NewAPI / Databricks）的中轉代理服務，已針對 SSE 即時串流直通、標頭清洗與工具呼叫協議完成優化。

---

## 檔案清單
* `Dockerfile`：Node.js 20 輕量化映像檔建置檔
* `.dockerignore`：排除無須打入映像檔的本機檔案
* `docker-compose.yml`：Docker Compose 容器配置
* `package.json`：專案依賴定義
* `server.js`：核心代理程式（純環境變數驅動，無任何硬編碼敏感網址）

---

## 環境變數說明

| 變數名稱 | 必填 | 說明 | 範例 |
|---|:---:|---|---|
| `TARGET_URL` | **是** | 目標上游 API 端點位址（尾端斜線會自動忽略） | `https://your-api-domain.com` 或 `http://newapi:3000` |
| `ALLOWED_DOMAIN` | 否 | 網域名稱白名單限制（留空則不限制，開放所有 Host） | `api.example.com` |
| `PORT` | 否 | 服務監聽端口（預設 `8080`） | `8080` |
| `MODEL_ALIASES` | 否 | 模型名稱別名對應 | `gpt-4o:claude-3-5-sonnet:high` |
| `DEBUG_LOG` | 否 | 是否輸出除錯詳細結構記錄 | `false` / `true` |

---

## Linux / Portainer 快速部署步驟

### 方式 1：Portainer Stacks (推薦)
1. 在 Portainer 中點擊 **Stacks** -> **Add stack**。
2. 選擇 **Repository**（若上傳至 GitHub）或 **Web editor**。
3. 在環境變數中設定你的 `TARGET_URL`。
4. 點擊 **Deploy the stack** 即可。

### 方式 2：本機/伺服器命令列
1. 進入本目錄：
   ```bash
   cd api-proxy
   ```
2. 啟動容器：
   ```bash
   docker compose up -d --build
   ```
3. 查看日誌：
   ```bash
   docker logs -f api-proxy
   ```
