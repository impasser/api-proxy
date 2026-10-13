const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');

const app = express();

// ==========================================
// 🎯 上游目標網址設定 (由環境變數注入)
// ==========================================
const TARGET_URL = (process.env.TARGET_URL || '').replace(/\/+$/, '');
if (!TARGET_URL) {
    console.error('❌ 錯誤: 未設定 TARGET_URL 環境變數！');
    console.error('👉 請在環境變數或 docker-compose.yml 中設置 TARGET_URL，例如: TARGET_URL=https://your-api-endpoint.com');
    process.exit(1);
}
console.log(`🎯 上游目標網址 (TARGET_URL): ${TARGET_URL}`);

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ==========================================
// 🛠️ 特殊欄位轉發控制開關 (true: 保留生效 / false: 攔截移除)
// ==========================================
const FEATURE_FLAGS = {
    ENABLE_TOOLS: process.env.ENABLE_TOOLS !== undefined 
        ? process.env.ENABLE_TOOLS.toLowerCase() === 'true' 
        : true,

    ENABLE_PROMPT_CACHE_OPTIONS: process.env.ENABLE_PROMPT_CACHE_OPTIONS !== undefined 
        ? process.env.ENABLE_PROMPT_CACHE_OPTIONS.toLowerCase() === 'true' 
        : false,

    ENABLE_TRUNCATION: process.env.ENABLE_TRUNCATION !== undefined 
        ? process.env.ENABLE_TRUNCATION.toLowerCase() === 'true' 
        : false,

    ENABLE_TOP_LEVEL_REASONING_EFFORT: process.env.ENABLE_TOP_LEVEL_REASONING_EFFORT !== undefined 
        ? process.env.ENABLE_TOP_LEVEL_REASONING_EFFORT.toLowerCase() === 'true' 
        : false,

    ENABLE_TOP_P: process.env.ENABLE_TOP_P !== undefined 
        ? process.env.ENABLE_TOP_P.toLowerCase() === 'true' 
        : false
};

console.log('⚙️ 特殊欄位轉發開關配置:', FEATURE_FLAGS);

// ==========================================
// 🔧 載入環境變數設定 (模型別名與除錯)
// ==========================================
const aliasMap = {};
const envAliases = process.env.MODEL_ALIASES || '';
if (envAliases) {
    envAliases.split(',').forEach(rule => {
        const parts = rule.split(':');
        if (parts.length === 3) {
            const [alias, target, effort] = parts;
            aliasMap[alias.trim()] = { target: target.trim(), effort: effort.trim() };
        }
    });
    console.log('✅ 已成功加載模型別名配置:', Object.keys(aliasMap));
}

const DEBUG_LOG = (process.env.DEBUG_LOG || 'false').toLowerCase() === 'true';

// ==========================================
// 🛡️ 靜態路由與安全防護 (可選網域名稱限制)
// ==========================================
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || '').trim();
if (ALLOWED_DOMAIN) {
    console.log(`🔒 啟用網域名稱白名單限制: ${ALLOWED_DOMAIN}`);
    app.use((req, res, next) => {
        if (req.hostname !== ALLOWED_DOMAIN) {
            return res.status(404).send('404 Not Found');
        }
        next();
    });
} else {
    console.log(`🔓 未限制網域名稱 (開放所有 Host / 容器內網存取)`);
}

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/', (req, res) => {
    res.send(`
        <html>
            <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f2f5;">
                <div style="text-align: center; padding: 40px; background: white; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <h1 style="color: #ea4c89;">✅ API Proxy is Running</h1>
                    <p style="color: #666;">伺服器運作正常 (Zero-Latency SSE 管線模式)。</p>
                    <p style="color: #999; font-size: 13px;">Target: ${TARGET_URL}</p>
                </div>
            </body>
        </html>
    `);
});

// 擴充 /v1/models 列表
app.get('/v1/models', async (req, res) => {
    try {
        const headers = { ...req.headers };
        delete headers.host;

        const response = await fetch(`${TARGET_URL}/v1/models`, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            return res.status(response.status).send(await response.text());
        }

        const data = await response.json();
        const customModels = Object.keys(aliasMap).map(alias => ({
            id: alias,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "proxy-injected"
        }));

        if (data && Array.isArray(data.data)) {
            const existingIds = new Set(data.data.map(m => m.id));
            customModels.forEach(cm => {
                if (!existingIds.has(cm.id)) data.data.push(cm);
            });
        }

        res.json(data);
    } catch (error) {
        console.error('獲取並整合模型列表失敗:', error);
        res.status(500).json({ error: "Failed to fetch models via proxy" });
    }
});

// ==========================================
// 🚀 核心通用轉發邏輯 (原生 Fetch + 即時 SSE 串流直通)
// ==========================================
app.all('*', async (req, res) => {
    const currentPath = req.originalUrl || req.url || '';
    const targetEndpoint = `${TARGET_URL}${currentPath}`;
    const isResponsesApi = currentPath.includes('responses') || (req.body && req.body.input !== undefined);
    const isMessagesApi = currentPath.includes('/messages');

    // 1. 整理轉發 Headers
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders['content-length'];
    delete forwardHeaders['anthropic-beta'];

    if (isMessagesApi) {
        if (!forwardHeaders['anthropic-version']) {
            forwardHeaders['anthropic-version'] = '2023-06-01';
        }
        // 若 VS Code 送的是 x-api-key，補上 Authorization Bearer 防止下游報 Invalid token
        if (!forwardHeaders['authorization'] && forwardHeaders['x-api-key']) {
            forwardHeaders['authorization'] = `Bearer ${forwardHeaders['x-api-key']}`;
        }
    }

    let requestBody = req.body;
    let isModified = false;
    let injectedEffort = null;
    let originalModel = requestBody ? requestBody.model : null;

    // 2. 清洗與優化 Body 欄位
    if (req.method === 'POST' && requestBody && typeof requestBody === 'object') {
        // 模型別名轉換與推論強度注入
        if (requestBody.model && aliasMap[requestBody.model]) {
            const rule = aliasMap[requestBody.model];
            requestBody.model = rule.target;
            injectedEffort = rule.effort;
            isModified = true;

            if (isResponsesApi) {
                if (!requestBody.reasoning || typeof requestBody.reasoning !== 'object') {
                    requestBody.reasoning = {};
                }
                requestBody.reasoning.effort = rule.effort;
            } else {
                requestBody.reasoning_effort = rule.effort;
            }
        }

        // Responses API 清洗與快取對齊
        if (isResponsesApi) {
            // 🛡️ 精準判斷：
            // Databricks 上的模型通常帶有 claude 或 databricks 關鍵字，且上游不支援 previous_response_id，必須移除。
            // 其餘模型（所有 GPT、客製別名、部署名）預設均為 OpenAI/Azure 規範，必須完整保留 previous_response_id 以維護工具呼叫！
            const targetModelLower = (requestBody.model || '').toLowerCase();
            const isDatabricksClaude = targetModelLower.includes('claude') || 
                                       targetModelLower.includes('databricks') || 
                                       targetModelLower.includes('dbrx') ||
                                       targetModelLower.startsWith('system.ai.');
            
            if (isDatabricksClaude) {
                delete requestBody.previous_response_id;
            }

            if (!FEATURE_FLAGS.ENABLE_TOOLS) {
                delete requestBody.tools;
                delete requestBody.tool_choice;
            }
            if (!FEATURE_FLAGS.ENABLE_PROMPT_CACHE_OPTIONS) delete requestBody.prompt_cache_options;
            if (!FEATURE_FLAGS.ENABLE_TRUNCATION) delete requestBody.truncation;
            if (!FEATURE_FLAGS.ENABLE_TOP_LEVEL_REASONING_EFFORT && requestBody.reasoning_effort !== undefined) {
                if (!requestBody.reasoning || typeof requestBody.reasoning !== 'object') {
                    requestBody.reasoning = {};
                }
                requestBody.reasoning.effort = requestBody.reasoning.effort || requestBody.reasoning_effort;
                delete requestBody.reasoning_effort;
            }
            if (!FEATURE_FLAGS.ENABLE_TOP_P) delete requestBody.top_p;
        }

        // Claude Messages 協議優化
        if (isMessagesApi) {
            delete requestBody.temperature;
            requestBody.stream = true;
            // 避免硬砍為 3072 導致 Agent 寫長代碼時被截斷而報錯
            if (!requestBody.max_tokens) {
                requestBody.max_tokens = 8192;
            }
            // 🛡️ 針對 Bedrock 託管的 Claude（如 claude-sonnet-5-5），將不相容的 enabled thinking 自適應轉換為 adaptive
            if (requestBody.thinking && requestBody.thinking.type === 'enabled') {
                requestBody.thinking = { type: 'adaptive' };
            }
        }

        // ==========================================
        // 📊 智慧詳細日誌分析（完整還原工具呼叫與使用者輸入）
        // ==========================================
        const clientIp = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0].trim() 
            : req.ip;

        console.log('========================================');
        console.log(`[${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}] 收到 API 請求`);
        console.log(`來源 IP  : ${clientIp}`);
        console.log(`請求路徑: ${currentPath}`);
        if (originalModel) console.log(`請求模型: ${originalModel}`);
        if (isModified) {
            console.log(` ↳ 攔截覆寫為: ${requestBody.model}`);
            console.log(` ↳ 注入推論強度: ${injectedEffort}`);
        }

        // 偵測 Tools 數量與清單
        const requestTools = requestBody.tools || [];
        if (Array.isArray(requestTools) && requestTools.length > 0) {
            const toolNames = requestTools.map(t => t.name || t.function?.name || 'unknown').slice(0, 8);
            console.log(`[Tools 數量]: ${requestTools.length} 個 (${toolNames.join(', ')}${requestTools.length > 8 ? '...' : ''})`);
        } else {
            console.log(`[Tools 數量]: 0 (此請求未攜帶任何 tools 定義，模型無法觸發本地執行！)`);
        }

        if (DEBUG_LOG) {
            console.log('\n--- 🕵️ DEBUG 模式: 發送前結構校驗 ---');
            console.log(`[頂層 Keys 清單]:`, Object.keys(requestBody));
            console.log('--------------------------------------\n');
        }

        // 提取日誌內容
        let userRealInput = null;
        let toolCallOutputs = [];

        if (requestBody.input && Array.isArray(requestBody.input)) {
            requestBody.input.forEach(item => {
                if (item.role === 'user' && Array.isArray(item.content)) {
                    item.content.forEach(part => {
                        if (part.type === 'input_text' && part.text) {
                            const match = part.text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/);
                            if (match) userRealInput = match[1].trim();
                        }
                    });
                }
                if (item.type === 'function_call_output' && Array.isArray(item.output)) {
                    item.output.forEach(op => {
                        if (op.text) {
                            let cleanText = op.text.trim();
                            if (cleanText.length > 300) cleanText = cleanText.substring(0, 300) + '...[截斷]';
                            toolCallOutputs.push(`[${item.call_id || 'Tool'}] ${cleanText}`);
                        }
                    });
                }
            });
        }

        // 智慧提取 Claude Messages 中的使用者提問與工具反饋
        if (!userRealInput && requestBody.messages && Array.isArray(requestBody.messages)) {
            requestBody.messages.forEach(msg => {
                const content = msg.content;
                if (typeof content === 'string') {
                    const m = content.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/);
                    if (m) userRealInput = m[1].trim();
                } else if (Array.isArray(content)) {
                    content.forEach(part => {
                        if (part.type === 'text' && part.text) {
                            const m = part.text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/);
                            if (m) userRealInput = m[1].trim();
                        }
                        if (part.type === 'tool_result') {
                            let resText = typeof part.content === 'string' 
                                ? part.content 
                                : Array.isArray(part.content) 
                                    ? part.content.map(c => c.text || '').join(' ') 
                                    : JSON.stringify(part.content);
                            resText = resText.trim();
                            if (resText.length > 200) resText = resText.substring(0, 200) + '...[截斷]';
                            toolCallOutputs.push(`[${part.tool_use_id || 'Tool'}] ${resText}`);
                        }
                    });
                }
            });
        }

        if (userRealInput) {
            console.log(`\n[Copilot 真實提問 (Clean)]:\n${userRealInput}\n`);
        }
        if (toolCallOutputs.length > 0) {
            console.log(`\n[Agent 工具執行反饋 (Tool Outputs)]:\n${toolCallOutputs.join('\n')}\n`);
        }
        
        // 若完全沒抓到提問或反饋，才印出過濾掉龐大環境資訊後的精華概要
        if (!userRealInput && toolCallOutputs.length === 0) {
            if (requestBody.messages && Array.isArray(requestBody.messages)) {
                const lastMsg = requestBody.messages[requestBody.messages.length - 1];
                let lastContent = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content || '');
                // 剔除超長的環境與說明標籤
                lastContent = lastContent
                    .replace(/<environment_info>[\s\S]*?<\/environment_info>/g, '[環境資訊]')
                    .replace(/<workspace_info>[\s\S]*?<\/workspace_info>/g, '[工作區結構]')
                    .replace(/<reminderInstructions>[\s\S]*?<\/reminderInstructions>/g, '[提示規則]')
                    .trim();
                if (lastContent.length > 300) lastContent = lastContent.substring(0, 300) + '...[截斷]';
                console.log(`\n[對話概要 (已過濾龐大資訊)]:\n${lastContent}\n`);
            } else {
                let sample = JSON.stringify(requestBody);
                if (sample.length > 300) sample = sample.substring(0, 300) + '...[截斷]';
                console.log(`\n[Payload 摘要]:\n${sample}\n`);
            }
        }

        console.log('========================================\n');
    }

    // 3. 原生 Fetch 轉發與 SSE 串流直通管線
    try {
        const fetchOptions = {
            method: req.method,
            headers: forwardHeaders,
            keepalive: false
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOptions.body = JSON.stringify(requestBody);
            forwardHeaders['content-type'] = 'application/json';
        }

        const upstreamRes = await fetch(targetEndpoint, fetchOptions);
        console.log(`[上游回應狀態]: ${upstreamRes.status} ${upstreamRes.statusText}`);

        res.status(upstreamRes.status);

        upstreamRes.headers.forEach((val, key) => {
            const lowerKey = key.toLowerCase();
            if (lowerKey !== 'content-length' && lowerKey !== 'content-encoding' && lowerKey !== 'transfer-encoding') {
                res.setHeader(key, val);
            }
        });

        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');

        if (res.socket) {
            res.socket.setNoDelay(true);
        }

        if (upstreamRes.body) {
            const nodeStream = Readable.fromWeb(upstreamRes.body);
            nodeStream.on('data', (chunk) => {
                res.write(chunk);
                if (typeof res.flush === 'function') {
                    res.flush();
                }
            });
            nodeStream.on('end', () => res.end());
            nodeStream.on('error', (err) => {
                console.error('上游串流傳輸中斷:', err);
                res.end();
            });
        } else {
            res.end();
        }

    } catch (err) {
        console.error('轉發上游請求發生異常:', err);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Proxy Gateway Error', details: err.message });
        }
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`✅ 中轉伺服器已啟動 (完整日誌追蹤與直通模式)，Port: ${PORT}`);
    console.log(`🔗 轉發目標: ${TARGET_URL}`);
});
