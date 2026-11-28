// magpie 供应商插件。供测试使用的内部函数汇总在 _internal 中。

const PROVIDER = "wps-comate";
const API_BASE = "https://comate.wps.cn/llmproxy/v1/user";
const CHAT_URL = `${API_BASE}/chat/completions`;
const APP_ID = "comate";
const NPM = "@ai-sdk/openai-compatible";
const TIMEOUT_MS = 15000;

// 没有登录、或 /models 拉不到时的兜底列表（占位 companyId）。
// 拉到真实列表后会被覆盖，登录后按你账号的 companyId 自动跟上。
const FALLBACK_MODELS = {
  "deepseek-v4-flash": {
    id: "000000000/deepseek/deepseek-v4-flash//public",
    name: "DeepSeek V4 Flash",
    limit: { context: 1000000, output: 32000 },
    tool_call: true,
  },
  "deepseek-v4-pro": {
    id: "000000000/deepseek/deepseek-v4-pro//public",
    name: "DeepSeek V4 Pro",
    limit: { context: 1000000, output: 32000 },
    tool_call: true,
  },
  "deepseek-v4.1-flash": {
    id: "000000000/deepseek/deepseek-v4.1-flash//public",
    name: "DeepSeek V4.1 Flash",
    limit: { context: 1000000, output: 32000 },
    tool_call: true,
  },
  "minimax-m3": {
    id: "000000000/minimax/MiniMax-M3//public",
    name: "MiniMax M3",
    limit: { context: 1000000, output: 32000 },
    tool_call: true,
  },
  "mimo-v2.6-flash": {
    id: "000000000/xiaomi/mimo-v2.6-flash//public",
    name: "MiMo V2.6 Flash",
    limit: { context: 1000000, output: 32000 },
    tool_call: true,
  },
  "mimo-v2.6-pro": {
    id: "000000000/xiaomi/mimo-v2.6-pro//public",
    name: "MiMo V2.6 Pro",
    limit: { context: 1000000, output: 32000 },
    tool_call: true,
  },
  "glm-5.2": {
    id: "000000000/zhipu/glm-5.2//public",
    name: "GLM 5.2",
    limit: { context: 1000000, output: 32000 },
    tool_call: true,
  },
  "glm-5.3-flash": {
    id: "000000000/zhipu/glm-5.3-flash//public",
    name: "GLM 5.3 Flash",
    limit: { context: 1000000, output: 32000 },
    tool_call: true,
  },
  "glm-5.3": {
    id: "000000000/zhipu/glm-5.3//public",
    name: "GLM 5.3",
    limit: { context: 1000000, output: 32000 },
    tool_call: true,
  },
};

// ---------------------------------------------------------------------------
// cookie 处理
// ---------------------------------------------------------------------------

const clean = (v) => (typeof v === "string" ? v.replace(/[\r\n]+/g, "").trim() : "");

/** 兼容旧版保存的 Cookie 串，只保留其中的 wps_sid。 */
function normalizeCookie(raw) {
  let value = typeof raw === "string" ? raw.trim() : "";
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return "";
  const cookieHeader = /^cookie\s*:/i;
  const hasHeader = cookieHeader.test(value);
  value = value.replace(cookieHeader, "").trim().replace(/^"(.*)"$/, "$1").trim();
  if (hasHeader || value.includes(";") || /^wps_sid\s*=/i.test(value) || value.replace(/=+$/, "").includes("=")) {
    const matches = value.split(";").map((pair) => /^\s*wps_sid\s*=\s*(.*?)\s*$/i.exec(pair)).filter(Boolean);
    if (matches.length !== 1) return "";
    value = matches[0][1];
  }
  return /^[A-Za-z0-9._~+/%-]+=*$/.test(value) ? `wps_sid=${value}` : "";
}

function resolveCookie(auth) {
  const candidates = [
    auth?.type === "api" ? auth.key : undefined,
    auth?.cookie,
    process.env.WPS_COMATE_COOKIE,
    process.env.COMATE_SDK_WPS_COOKIE,
    process.env.WPS_SID,
  ];
  for (const candidate of candidates) {
    const cookie = normalizeCookie(candidate);
    if (cookie) return cookie;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 请求头
// ---------------------------------------------------------------------------

function buildHeaders(cookie, inputHeaders) {
  const headers = new Headers({
    accept: "application/json",
    cookie,
    authorization: `Bearer ${cookie.slice("wps_sid=".length)}`,
    "x-app-id": APP_ID,
  });
  const provided = new Headers(inputHeaders);
  for (const name of ["accept", "content-type"]) {
    if (provided.has(name)) headers.set(name, provided.get(name));
  }
  return headers;
}

function chatResponse(response) {
  if (response.status !== 401 && !response.headers.has("set-cookie") &&
      !response.headers.has("set-cookie2") && !response.headers.has("x-magpie-sign-in")) return response;
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("set-cookie2");
  headers.delete("x-magpie-sign-in");
  if (response.status === 401) headers.set("x-magpie-sign-in", "expired");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// 显式传空代理值时，magpie 按直连处理。
function proxyOf(options) {
  const p = clean(options?.proxy);
  if (!p || p === "direct" || p === "none") return "";
  return p;
}

async function callUpstream(cookie, path, options, signal) {
  const timeout = AbortSignal.timeout(options?.timeoutMs ?? TIMEOUT_MS);
  return fetch(`${API_BASE}${path}`, {
    headers: buildHeaders(cookie),
    redirect: "error",
    proxy: proxyOf(options),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

// ---------------------------------------------------------------------------
// /models 解析
// Comate 实际形状：
//   { code:0, msg:"", data:{ auto:{...}, items:[{
//       display_name, name(=完整上游 id), llm_types, context_window,
//       max_tokens:{min,max,default,type}, model_tier, consume_ratio,
//       support_thinking, thinking_levels, thinking_can_disable }] } }
// 其他形状顺手兼容。
// ---------------------------------------------------------------------------

function pickArray(json) {
  if (Array.isArray(json)) return json;
  const candidates = [
    json?.data?.items,
    json?.data?.models,
    json?.data?.list,
    json?.data,
    json?.models,
    json?.list,
    json?.items,
    json?.result?.models,
    json?.result?.items,
    json?.result,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

function slugOf(id, displayName, index) {
  const n = clean(displayName);
  if (n && /^[A-Za-z][A-Za-z0-9._-]{0,62}$/.test(n)) return n.toLowerCase();
  const parts = String(id ?? "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  const tail = parts.filter((p) => p !== "public").pop();
  const slug = clean(tail).replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
  return slug || `model-${index + 1}`;
}

/** 数字，或 {max, default} 这种限值对象。 */
function num(v) {
  const n = typeof v === "object" && v !== null ? Number(v.max ?? v.default) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toModel(entry, base, index) {
  const idField = clean(entry?.id ?? entry?.model_id ?? entry?.modelId);
  const nameField = clean(entry?.name);
  const displayField = clean(entry?.display_name ?? entry?.displayName ?? entry?.label);
  // Comate 把完整上游 id 放在 name 里；老形状用 id + name(展示名)
  const id = idField || nameField;
  if (!id) return null;
  const display = displayField || (idField ? nameField : "") || id;
  const name = display;
  const context = num(entry?.context_window ?? entry?.contextWindow ?? entry?.limit?.context) || base.limit.context;
  const output = num(entry?.max_tokens ?? entry?.maxTokens ?? entry?.limit?.output) || base.limit.output;
  const model = {
    ...base,
    id,
    name,
    limit: { context, output },
    // 关键：base 是「拿来做模板的那个模型」，它的 api.id 是自己的完整上游 id。
    // 只覆盖顶层 id 不够 —— magpie 发送时优先用 api.id，漏掉这一步会让所有模型
    // 都顶着模板模型的 apiId 发请求（表现为「请求 glm-5.3，实际 deepseek 作答」）。
    api: { ...(base?.api ?? {}), id, url: API_BASE, npm: NPM },
  };
  if (entry?.support_thinking === true) {
    model.reasoning = true;
    const levels = Array.isArray(entry?.thinking_levels) ? entry.thinking_levels : [];
    if (levels.length) model.variants = Object.fromEntries(levels.map((l) => [String(l), {}]));
  } else if (entry?.support_thinking === false) {
    model.reasoning = false;
  }
  const ratio = Number(entry?.consume_ratio);
  if (Number.isFinite(ratio) && ratio > 0) model.rate = ratio;
  return [slugOf(id, display, index), model];
}

// ---------------------------------------------------------------------------
// [本地补丁] 工具 schema 兼容：Comate 的 Go 后端把 enum 解析成 []string，
// 工具参数里的布尔/数字枚举会让请求 502
// （json: cannot unmarshal bool into ... enum of type string）。
// 典型来源：Codex 桌面版 tool_search 加载的 create_worktree（allowAsync: enum [true]）。
// 处理：只删含非字符串成员的 enum，允许值挪进 description 保留约束语义；
// 字符串枚举不动；没有任何删除时不重序列化（字节级原样）；异常时原样转发（fail-open）。
// ---------------------------------------------------------------------------

function sanitizeToolSchemas(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null; // 非 JSON，原样转发
  }
  let changed = false;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.enum) && node.enum.some((v) => typeof v !== "string")) {
      const allowed = node.enum
        .map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
        .join(", ");
      const note = `(allowed values: ${allowed})`;
      node.description =
        typeof node.description === "string" && node.description
          ? `${node.description} ${note}`
          : note;
      delete node.enum;
      changed = true;
    }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  try {
    for (const tool of body?.tools ?? []) {
      walk(tool?.function?.parameters ?? tool?.parameters);
    }
  } catch {
    return null; // 结构意外：原样转发
  }
  return changed ? JSON.stringify(body) : null;
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export const WpsComateAuthPlugin = async ({ client } = {}, options) => {
  const opts = options ?? {};
  const logWarning = async (message) => {
    try {
      await client?.app?.log?.({ body: { service: PROVIDER, level: "warn", message } });
    } catch {
      // 日志失败时继续保留模型列表。
    }
  };

  return {
    // 供应商 + 默认模型
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "WPS Comate",
        npm: NPM,
        api: API_BASE,
        models: structuredClone(FALLBACK_MODELS),
      };
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "WPS Comate 会话凭据",
          prompts: [
            {
              type: "password",
              key: "cookie",
              message: "输入你自己账号的 wps_sid",
              placeholder: "wps_sid=…",
              validate: (v) => (normalizeCookie(v) ? undefined : "请输入有效的 wps_sid"),
            },
          ],
          async authorize(inputs, { signal } = {}) {
            const cookie = normalizeCookie(inputs?.cookie);
            if (!cookie) {
              return { type: "failed", error: "请输入有效的 wps_sid" };
            }
            const metadata = {};
            try {
              const res = await callUpstream(cookie, "/models", opts, signal);
              if (res.status === 401 || res.status === 403) {
                return {
                  type: "failed",
                  error: `Comate 拒绝了登录（HTTP ${res.status}）`,
                };
              }
              if (!res.ok) metadata.unverified = true;
            } catch {
              metadata.unverified = true;
            }
            if (signal?.aborted) return { type: "failed", error: "登录已取消" };
            return { type: "success", key: cookie, metadata };
          },
        },
      ],

      // 每个账号的请求：发到 Comate 的 llmproxy，带上 cookie + bearer
      async loader(getAuth) {
        const cookie = resolveCookie(await getAuth());
        return {
          baseURL: API_BASE,
          async fetch(input, init) {
            if (!cookie) throw new Error("请先登录 wps-comate");
            const request = input instanceof Request ? input : undefined;
            const url = URL.parse(request?.url ?? input);
            if (url?.href !== CHAT_URL) throw new Error("Comate 对话请求地址不受支持");
            // [本地补丁] 清洗工具 schema；没有改动时保持请求字节级原样
            let outbound = request ?? CHAT_URL;
            let outboundInit = init;
            try {
              if (request && /^post$/i.test(request.method)) {
                const raw = await request.text();
                const patched = sanitizeToolSchemas(raw);
                outbound = new Request(url, {
                  method: request.method,
                  body: patched ?? raw,
                  duplex: "half",
                });
                outboundInit = { ...init, body: undefined };
              } else if (!request && typeof init?.body === "string") {
                const patched = sanitizeToolSchemas(init.body);
                if (patched !== null) outboundInit = { ...init, body: patched };
              }
            } catch {
              // 读体/重建失败：维持原样转发
            }
            try {
              const response = await fetch(outbound, {
                ...outboundInit,
                headers: buildHeaders(cookie, outboundInit?.headers ?? request?.headers),
                redirect: "error",
                proxy: proxyOf(opts),
              });
              return chatResponse(response);
            } catch {
              throw new Error("Comate 对话请求失败");
            }
          },
        };
      },

      // 额度：GET /llmproxy/v1/user/token-usage 的 credits.seat 就是套餐余额
      async usage(getAuth) {
        const cookie = resolveCookie(await getAuth());
        if (!cookie) return undefined;
        try {
          const res = await callUpstream(cookie, "/token-usage", opts);
          if (res.status === 401 || res.status === 403) {
            return { error: `Comate 额度接口拒绝了登录（HTTP ${res.status}）`, windows: [], signIn: "expired" };
          }
          if (!res.ok) return { error: `Comate 额度接口 HTTP ${res.status}`, windows: [] };
          return mapUsage(await res.json());
        } catch {
          return { error: "Comate 额度请求失败", windows: [] };
        }
      },
    },

    // 每个账号实际有哪些模型
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const cookie = resolveCookie(auth);
        if (!cookie) return provider.models;
        try {
          const res = await callUpstream(cookie, "/models", opts);
          if (!res.ok) {
            await logWarning(`Comate 模型列表返回 HTTP ${res.status}，沿用原列表`);
            return provider.models;
          }
          const json = await res.json();
          const list = pickArray(json).filter((m) => {
            const types = m?.llm_types ?? m?.llmTypes;
            return !Array.isArray(types) || types.includes("llm-chat");
          });
          const base = provider.models?.["deepseek-v4-flash"] ?? Object.values(FALLBACK_MODELS)[0];
          const out = Object.fromEntries(list.map((entry, i) => toModel(entry, base, i)).filter(Boolean));
          if (!Object.keys(out).length) return provider.models;
          return out;
        } catch {
          await logWarning("Comate 模型列表请求失败，沿用原列表");
          return provider.models;
        }
      },
    },
  };
};

/** 把账期月份换算成距下个月 1 日的秒数。 */
function secondsToNextPeriod(periodKey) {
  const m = /^(\d{4})(\d{2})$/.exec(clean(periodKey));
  if (!m) return undefined;
  const next = new Date(Number(m[1]), Number(m[2]), 1); // JS 月份 0-based，正好是下月 1 日
  const secs = Math.round((next.getTime() - Date.now()) / 1000);
  return secs > 0 ? secs : undefined;
}

/**
 * Comate 的额度在 GET /llmproxy/v1/user/token-usage 里：
 *   data.credits.seat = { period_key, quota, quota_period, remain, used, seat_level }
 *   data.credits_usage.periods[0] = { credits_limit, credits_rest, credits_used, period_label, period_type }
 * 也兼容已采用 magpie 字段的响应。
 */
function mapUsage(j) {
  const d = j?.data ?? j ?? {};
  const seat = d?.credits?.seat ?? {};
  const period = Array.isArray(d?.credits_usage?.periods) ? d.credits_usage.periods[0] ?? {} : {};

  const limit = Number(seat.quota ?? period.credits_limit);
  const usedRaw = Number(seat.used ?? period.credits_used);
  const remainRaw = Number(seat.remain ?? period.credits_rest);

  const windows = [];

  // ① Comate 真实结构
  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(usedRaw)) {
    const pct = (usedRaw / limit) * 100;
    const w = {
      name: clean(period.period_label) || (seat.quota_period === "month" ? "每月" : clean(seat.quota_period) || "quota"),
      used: Math.round(pct * 100) / 100,
      amount: Math.round(usedRaw * 100) / 100,
      limit,
      unit: "credits",
      display: `${fmt(usedRaw)} / ${fmt(limit)} credits（剩 ${fmt(remainRaw)}）`,
    };
    const secs = secondsToNextPeriod(seat.period_key);
    if (secs) w.resetSecs = secs;
    windows.push(w);
  }

  // ② 已采用 magpie 字段的响应
  if (!windows.length && Array.isArray(j?.windows ?? d?.windows)) {
    for (const w of j?.windows ?? d?.windows) {
      const used = Number(w?.used ?? w?.percent ?? w?.usage_percent);
      if (!Number.isFinite(used)) continue;
      windows.push({
        name: String(w?.name ?? w?.window ?? "quota"),
        used,
        resetsAt: w?.resetsAt ?? w?.resets_at ?? w?.reset_at,
        span: Number(w?.span) || undefined,
      });
    }
  }

  const plan = clean(seat.seat_level) ? `Comate ${clean(seat.seat_level)}` : clean(d?.plan) || undefined;
  const balance = Number.isFinite(remainRaw)
    ? `${fmt(remainRaw)} credits`
    : d?.balance === undefined || d?.balance === null
      ? undefined
      : String(d.balance);

  return { plan, balance, windows };
}

function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// 给测试用，不会被当成插件调用
export const _internal = {
  normalizeCookie,
  buildHeaders,
  pickArray,
  slugOf,
  toModel,
  mapUsage,
  sanitizeToolSchemas,
  PROVIDER,
  API_BASE,
  FALLBACK_MODELS,
};
