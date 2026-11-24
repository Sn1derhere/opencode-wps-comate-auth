// 本地自测：不联网，只验证插件契约与请求头拼装。
//   node test/plugin.test.mjs
import assert from "node:assert/strict";
import { WpsComateAuthPlugin, _internal } from "../index.mjs";

let pass = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const COOKIE = "wps_sid=abc123";
const CHAT_URL = "https://comate.wps.cn/llmproxy/v1/user/chat/completions";

test("config 声明 wps-comate 供应商与 9 个兜底模型", async () => {
  const plugin = await WpsComateAuthPlugin({}, undefined);
  const cfg = {};
  await plugin.config(cfg);
  const p = cfg.provider["wps-comate"];
  assert.equal(p.name, "WPS Comate");
  assert.equal(p.npm, "@ai-sdk/openai-compatible");
  assert.equal(p.api, "https://comate.wps.cn/llmproxy/v1/user");
  assert.equal(Object.keys(p.models).length, 9);
  assert.equal(p.models["glm-5.3"].id, "000000000/zhipu/glm-5.3//public");
});

test("config 不覆盖用户已有的供应商配置", async () => {
  const plugin = await WpsComateAuthPlugin({}, undefined);
  const cfg = { provider: { "wps-comate": { name: "mine", models: {} } } };
  await plugin.config(cfg);
  assert.equal(cfg.provider["wps-comate"].name, "mine");
});

test("normalizeCookie 接受裸 sid / wps_sid / 整条 cookie", () => {
  assert.equal(_internal.normalizeCookie("abc"), "wps_sid=abc");
  assert.equal(_internal.normalizeCookie("wps_sid=abc"), "wps_sid=abc");
  assert.equal(_internal.normalizeCookie("Cookie: wps_sid=abc; csrf=abc"), "wps_sid=abc");
  assert.equal(_internal.normalizeCookie('"wps_sid=abc"'), "wps_sid=abc");
  assert.equal(_internal.normalizeCookie("wps_sid=abc\nInjected: 1"), "");
  assert.equal(_internal.normalizeCookie("other=abc; csrf=abc"), "");
  assert.equal(_internal.normalizeCookie("wps_sid=abc; wps_sid=def"), "");
  assert.equal(_internal.normalizeCookie("wps_sid=abc\x00def"), "");
});

test("buildHeaders 只发对话所需的请求头", () => {
  const h = _internal.buildHeaders(COOKIE, {
    authorization: "Bearer synthetic-other",
    cookie: "synthetic=1",
    "user-agent": "synthetic-client",
    "x-request-id": "synthetic-session",
    accept: "text/event-stream",
  });
  assert.equal(h.get("cookie"), COOKIE);
  assert.equal(h.get("authorization"), "Bearer abc123");
  assert.equal(h.get("x-app-id"), "comate");
  assert.equal(h.get("accept"), "text/event-stream");
  assert.equal(h.get("x-comate-scene"), null);
  assert.equal(h.get("x-request-id"), null);
  assert.equal(h.get("user-agent"), null);
});

test("loader.fetch 透传 body 并注入身份头", async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (input, init) => {
    seen = { input, init };
    return new Response("data: [DONE]\n\n", { status: 200 });
  };
  try {
    const plugin = await WpsComateAuthPlugin({}, {});
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: COOKIE }));
    assert.equal(loader.baseURL, "https://comate.wps.cn/llmproxy/v1/user");
    const res = await loader.fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "old=1",
        "x-session-id": "synthetic-local-session",
      },
      body: JSON.stringify({ model: "x", stream: true }),
    });
    assert.equal(res.status, 200);
    const h = seen.init.headers;
    assert.equal(h.get("cookie"), COOKIE);
    assert.equal(h.get("authorization"), "Bearer abc123");
    assert.equal(h.get("x-app-id"), "comate");
    assert.equal(h.get("content-type"), "application/json");
    assert.equal(h.get("x-session-id"), null);
    assert.equal(seen.init.redirect, "error");
    assert.equal(seen.init.body, JSON.stringify({ model: "x", stream: true }));
  } finally {
    globalThis.fetch = original;
  }
});

test("loader.fetch 只允许固定的 HTTPS 对话地址", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(null);
  };
  try {
    const plugin = await WpsComateAuthPlugin();
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: COOKIE }));
    for (const url of [
      "https://outside.example/chat/completions",
      CHAT_URL.replace("https:", "http:"),
      CHAT_URL.replace("comate.wps.cn", "comate.wps.cn:8443"),
      CHAT_URL.replace("comate.wps.cn", "test@comate.wps.cn"),
      CHAT_URL.replace("/chat/completions", "/models"),
    ]) {
      await assert.rejects(loader.fetch(new URL(url)), /请求地址/);
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("loader.fetch 保留 Request 的对话正文并移除响应 Cookie", async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (input, init) => {
    seen = new Request(input, init);
    return new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream", "set-cookie": "wps_sid=synthetic-response" },
    });
  };
  try {
    const plugin = await WpsComateAuthPlugin();
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: COOKIE }));
    const response = await loader.fetch(new Request(CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"stream":true}',
    }));
    assert.equal(await seen.text(), '{"stream":true}');
    assert.equal(seen.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "data: [DONE]\n\n");
  } finally {
    globalThis.fetch = original;
  }
});

test("usage 只向内置额度接口发送凭据", async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (input, init) => {
    seen = { url: String(input), init };
    return Response.json({ data: { credits: { seat: { quota: 10, remain: 8, used: 2 } } } });
  };
  try {
    const plugin = await WpsComateAuthPlugin({}, { usageUrl: "https://outside.example/usage" });
    const usage = await plugin.auth.usage(async () => ({ type: "api", key: COOKIE }));
    assert.equal(seen.url, `${_internal.API_BASE}/token-usage`);
    assert.equal(seen.init.redirect, "error");
    assert.equal(usage.balance, "8 credits");
  } finally {
    globalThis.fetch = original;
  }
});

test("loader.fetch 把 401 标成需要重新登录", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":{"code":"not_login"}}', { status: 401 });
  try {
    const plugin = await WpsComateAuthPlugin({}, {});
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: COOKIE }));
    const res = await loader.fetch(CHAT_URL);
    assert.equal(res.headers.get("X-Magpie-Sign-In"), "expired");
  } finally {
    globalThis.fetch = original;
  }
});

test("provider.models 解析 Comate 真实形状 {data:{items:[…]}}", async () => {
  const original = globalThis.fetch;
  const body = {
    code: 0,
    msg: "",
    data: {
      auto: { auto_enabled: 1, model_tiers: ["flash", "pro", "max"] },
      items: [
        {
          display_name: "kimi-k4",
          name: "111/kimi/kimi-k4//public",
          llm_types: ["llm-chat"],
          context_window: 256000,
          max_tokens: { min: 0, max: 65536, default: 16384 },
          support_thinking: true,
          thinking_levels: ["low", "high"],
          consume_ratio: 1.5,
        },
        { display_name: "img", name: "111/oai/gpt-image//public", llm_types: ["llm-image"] },
      ],
    },
  };
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  try {
    const plugin = await WpsComateAuthPlugin({}, {});
    const provider = { models: structuredClone(_internal.FALLBACK_MODELS) };
    const out = await plugin.provider.models(provider, { auth: { type: "api", key: COOKIE } });
    assert.deepEqual(Object.keys(out), ["kimi-k4"]);
    assert.equal(out["kimi-k4"].id, "111/kimi/kimi-k4//public");
    assert.equal(out["kimi-k4"].name, "kimi-k4");
    assert.equal(out["kimi-k4"].limit.context, 256000);
    assert.equal(out["kimi-k4"].limit.output, 65536);
    assert.equal(out["kimi-k4"].reasoning, true);
    assert.deepEqual(Object.keys(out["kimi-k4"].variants), ["low", "high"]);
    assert.equal(out["kimi-k4"].rate, 1.5);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider.models 每个模型的 api.id 必须是自己的（不能继承模板模型）", async () => {
  const original = globalThis.fetch;
  const body = {
    data: {
      items: [
        { display_name: "glm-5.3", name: "C/zhipu/glm-5.3//public", llm_types: ["llm-chat"] },
        { display_name: "minimax-m3", name: "C/minimax/M3//public", llm_types: ["llm-chat"] },
      ],
    },
  };
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  try {
    // 模拟 magpie 真实传进来的结构：模板模型自带 api.id
    const template = structuredClone(_internal.FALLBACK_MODELS["deepseek-v4-flash"]);
    template.api = { id: template.id, url: "https://comate.wps.cn/llmproxy/v1/user", npm: "@ai-sdk/openai-compatible" };
    const plugin = await WpsComateAuthPlugin({}, {});
    const out = await plugin.provider.models({ models: { "deepseek-v4-flash": template } }, { auth: { type: "api", key: COOKIE } });
    assert.equal(out["glm-5.3"].api.id, "C/zhipu/glm-5.3//public");
    assert.equal(out["minimax-m3"].api.id, "C/minimax/M3//public");
    assert.equal(out["glm-5.3"].id, "C/zhipu/glm-5.3//public");
    // 模板模型自己那条不应被污染
    assert.notEqual(out["glm-5.3"].api.id, template.id);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider.models 也吃老形状 {data:[{id,name}]}", async () => {
  const original = globalThis.fetch;
  const body = { data: [{ id: "vendor/x-large", name: "X Large", context_window: 128000 }] };
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  try {
    const plugin = await WpsComateAuthPlugin({}, {});
    const provider = { models: structuredClone(_internal.FALLBACK_MODELS) };
    const out = await plugin.provider.models(provider, { auth: { type: "api", key: COOKIE } });
    assert.deepEqual(Object.keys(out), ["x-large"]);
    assert.equal(out["x-large"].id, "vendor/x-large");
  } finally {
    globalThis.fetch = original;
  }
});

test("provider.models 上游失败时保留原列表", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  try {
    const plugin = await WpsComateAuthPlugin({}, {});
    const provider = { models: structuredClone(_internal.FALLBACK_MODELS) };
    const out = await plugin.provider.models(provider, { auth: { type: "api", key: COOKIE } });
    assert.equal(out, provider.models);
  } finally {
    globalThis.fetch = original;
  }
});

test("authorize 校验通过后保存规范化 cookie", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json({});
  };
  try {
    const plugin = await WpsComateAuthPlugin({}, {});
    const method = plugin.auth.methods[0];
    const result = await method.authorize({ cookie: "abc123" });
    assert.equal(result.type, "success");
    assert.equal(result.key, "wps_sid=abc123");
    assert.deepEqual(requests, [`${_internal.API_BASE}/models`]);
    assert.equal(result.metadata?.email, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("authorize 在 401 时给出可读失败原因", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("synthetic-sensitive-response", { status: 401 });
  try {
    const plugin = await WpsComateAuthPlugin({}, {});
    const result = await plugin.auth.methods[0].authorize({ cookie: "bad" });
    assert.equal(result.type, "failed");
    assert.match(result.error, /401/);
    assert.doesNotMatch(result.error, /synthetic-sensitive-response/);
  } finally {
    globalThis.fetch = original;
  }
});

test("登录校验失败时省略底层网络错误，取消后不保存凭据", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("synthetic-sensitive-error"); };
  try {
    const plugin = await WpsComateAuthPlugin();
    const method = plugin.auth.methods[0];
    const pending = await method.authorize({ cookie: COOKIE });
    assert.deepEqual(pending.metadata, { unverified: true });
    const cancelled = await method.authorize({ cookie: COOKIE }, { signal: AbortSignal.abort() });
    assert.equal(cancelled.type, "failed");
    assert.equal(cancelled.key, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

for (const { name, fn } of cases) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(err);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
