/**
 * presence-status —— 按「自己是否在游戏内」自动切换自定义状态描述
 * =====================================================================
 * 需求：使用者常驻挂着本服务（云服务器 24h 在线），自己的 VRChat 状态因此长期显示
 * "在网站上活跃"。使用者要求：
 *   - 不在游戏内（服务挂着/挂机）→ 自定义状态文字写成"挂机"提示；
 *   - 回到游戏内 → **恢复成上次下线时的那条状态文字**（不是固定文案）。
 *
 * 因此实现为「捕获 + 恢复」模型：
 *   1) 判定源：核心服务 `dashboard.selfPresence`（三态 in_game / not_in_game / unknown，
 *      见 core/self-presence.js）；
 *   2) 检测到 **游戏内 → 不在游戏** 的转换时，先读一次当前状态文字并**捕获**为
 *      `savedText`（= 使用者上次下线时的状态），再写入 `idleTemplate`；
 *   3) 检测到 **不在游戏 → 游戏内** 的转换时，把 `savedText` 写回去；
 *   4) `unknown`（无法判定）不翻转现状。
 *
 * 为什么是插件（DEVELOPMENT.md §1.1 贡献模型）：这是具体业务功能，必须落插件；
 * 状态读写走 `api.vrchat.fetch`（核心注入登录态 + 自动限流），插件不接触凭据。
 *
 * 为什么是轮询：插件契约 v1.3 的 8 个 API 面没有「事件订阅」能力，插件只能
 * `api.consume` 拉取核心服务；因此按 pollSeconds（默认 60s，下限 20s）轮询在场状态。
 * 轮询成本 = 一次本地 SQL 查询（不产生 VRChat API 调用），只有**状态转换点**才发生
 * /auth/user + PUT /users/{id}（每次转换最多 2 次调用）。要秒级切换需先给插件加
 * 事件订阅面（架构级改动，按 DEVELOPMENT.md §1 应先开 issue 讨论）。
 *
 * 安全与不变量：
 *   - 只改 `statusDescription`（自定义状态文字），并把当前 `status` 种类原样回传，
 *     不改变在线形态；
 *   - PUT 之间最小间隔 65s（与核心 status-sync 同阈值），文案不变不提交；
 *   - 三态里的 `unknown` **不翻转**现状；
 *   - **只在状态转换点动作**：进/出游戏各触发一次，之后不反复改写——使用者在别处
 *     手动改的状态文字会被保留（不在每次轮询里被抢回去）；
 *   - 默认 enabled=false，需使用者显式开启。
 *
 * 工具：get_presence_status（查询配置/在场/捕获值/最近应用）、set_presence_status（改配置）。
 */
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  idleTemplate: '挂机中（服务在线）',
  pollSeconds: 60,
});

const MIN_POLL_SECONDS = 20;
const MAX_POLL_SECONDS = 3600;
/** 两次 PUT 的最小间隔（与 core/status-sync.js 的 65s 同口径，避免高频改状态） */
const MIN_APPLY_INTERVAL_MS = 65 * 1000;
/** VRChat statusDescription 上限（与核心 set_dynamic_status 一致） */
const MAX_TEMPLATE_CHARS = 64;
/** 启动后延迟首跑：等核心完成登录态就绪与 WS 建连 */
const BOOT_DELAY_MS = 5 * 1000;

/** pollSeconds 规整：非数字/非法回落默认，越界钳到 [20, 3600]（纯函数，便于单测） */
export function clampPollSeconds(value, fallback = DEFAULT_CONFIG.pollSeconds) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(n)));
}

/** 文案校验：字符串、去空白后非空且不超过 64 字符（纯函数，便于单测） */
export function isValidTemplate(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && [...value].length <= MAX_TEMPLATE_CHARS;
}

/** 是否处于两次 PUT 之间的最小间隔内（纯函数，便于单测） */
export function isWithinCooldown({ lastApplyAt = 0, now = Date.now(), manual = false, minIntervalMs = MIN_APPLY_INTERVAL_MS } = {}) {
  if (manual) return false;
  if (!lastApplyAt) return false;
  return now - lastApplyAt < minIntervalMs;
}

/**
 * 按「当前在场态 + 上次判定态」决定本次要做什么（纯函数，便于单测）。
 *
 * @param {'in_game'|'not_in_game'|'unknown'} state 当前在场态
 * @param {string} lastState 上一次判定态（''=首次运行）
 * @param {{idleTemplate: string, savedText: string}} ctx 配置与已捕获文字
 * @returns {{action: 'skip', reason: string}|{action: 'restore', text: string}|{action: 'idle', text: string}}
 */
export function decideAction(state, lastState, { idleTemplate, savedText }) {
  if (state === 'unknown') return { action: 'skip', reason: 'state-unknown' };
  if (state === 'in_game') {
    if (lastState === 'in_game') return { action: 'skip', reason: 'no-transition' };
    // 回到游戏：恢复上次下线时捕获的状态文字。没有捕获值（或捕获值就是挂机文案）时
    // 本纯函数只给出 text = ''（清空意图）——**是否真的清空由 applyStatus 依现状裁定**：
    // 现状确知是本插件写的才清空，是使用者自己写的文案则保持不动。
    const text = (savedText && savedText !== idleTemplate) ? savedText : '';
    return { action: 'restore', text };
  }
  // 不在游戏内
  if (lastState === 'not_in_game') return { action: 'skip', reason: 'no-transition' };
  return { action: 'idle', text: idleTemplate };
}

export default function register(api) {
  const cfg = api.db.table('settings');

  const readRaw = () => {
    const rows = cfg.all('SELECT cfg_key, cfg_val FROM settings');
    const out = {};
    for (const r of rows) out[r.cfg_key] = r.cfg_val;
    return out;
  };

  const writeRaw = (key, val) => {
    // 命名参数（仓库惯例：core/storage.js 的 _normParams 只支持 $name 形式，位置参数 ? 不生效）
    cfg.run('INSERT OR REPLACE INTO settings (cfg_key, cfg_val, updated_at) VALUES ($k, $v, datetime(\'now\'))',
      { $k: key, $v: String(val) });
  };

  function readConfig() {
    const raw = readRaw();
    return {
      enabled: raw.enabled === 'true',
      idleTemplate: isValidTemplate(raw.idleTemplate) ? raw.idleTemplate : DEFAULT_CONFIG.idleTemplate,
      pollSeconds: clampPollSeconds(raw.pollSeconds),
    };
  }

  // 进程内状态：跨重启由 api.db 恢复
  let appliedText = '';
  let lastState = '';
  let lastApplyAt = 0;
  let lastError = '';
  try {
    const raw = readRaw();
    appliedText = typeof raw.lastText === 'string' ? raw.lastText : '';
    lastState = typeof raw.lastState === 'string' ? raw.lastState : '';
  } catch { /* 首次加载无表数据 */ }

  /** 读当前账号（用于拿 selfId、当前 status 种类与当前文案） */
  async function fetchMe() {
    const me = await api.vrchat.fetch('/auth/user');
    if (!me || !me.id) throw new Error('无法读取当前用户');
    return me;
  }

  /** 写入自定义状态文字（只改 statusDescription，status 种类原样保留） */
  async function putDescription(me, text) {
    await api.vrchat.fetch(`/users/${encodeURIComponent(me.id)}`, {
      method: 'PUT',
      body: { statusDescription: text, status: me.status || 'active' },
    });
    appliedText = text;
    lastApplyAt = Date.now();
    lastError = '';
    writeRaw('lastText', text);
    writeRaw('lastAppliedAt', new Date().toISOString());
  }

  /**
   * 执行一次同步：读在场状态 → 判定动作（转换点才动手）→ 需要时 PUT。
   * 转换点动作：
   *   出游戏 → 先捕获当前文案为 savedText（= 上次下线时的状态），再写 idleTemplate；
   *   进游戏 → 把 savedText 写回去。
   */
  async function applyStatus({ manual = false } = {}) {
    const config = readConfig();
    if (!config.enabled) return { action: 'skipped', reason: 'disabled' };

    if (!api.hasService('dashboard.selfPresence')) {
      return { action: 'skipped', reason: 'no-self-presence-service' };
    }
    let presence = null;
    try {
      presence = await api.consume('dashboard.selfPresence');
    } catch (err) {
      lastError = `consume 失败: ${err.message}`;
      return { action: 'skipped', reason: 'consume-failed', detail: lastError };
    }
    const state = (presence && presence.state) || 'unknown';

    const savedText = readRaw().savedText || '';
    const decision = decideAction(state, lastState, { idleTemplate: config.idleTemplate, savedText });

    if (decision.action === 'skip') {
      // 转换点之外（或在游戏态无可恢复值）→ 只推进已判定态，不做 API 调用
      if (state !== 'unknown' && lastState !== state) {
        lastState = state;
        writeRaw('lastState', state);
      }
      return { action: 'skipped', reason: decision.reason, state };
    }

    const now = Date.now();
    if (isWithinCooldown({ lastApplyAt, now, manual })) {
      return { action: 'skipped', reason: 'cooldown', nextInMs: MIN_APPLY_INTERVAL_MS - (now - lastApplyAt), state };
    }

    try {
      const me = await fetchMe();
      const current = typeof me.statusDescription === 'string' ? me.statusDescription : '';

      // 出游戏：先把"上次状态"捕获下来。两类不捕获：
      //   1) 当前文案就是挂机文案（说明本来就是我们写的）；
      //   2) 当前文案等于我们自己上一次写入的文案（appliedText，跨重启已从表恢复）
      //      —— 否则会把"上一版的挂机文案"误当成使用者的状态，回游戏时又给恢复出来。
      if (decision.action === 'idle' && current && current !== config.idleTemplate && current !== appliedText) {
        writeRaw('savedText', current);
      }

      // 「回到游戏内但无可恢复值」的守卫：只有在**确知现状是本插件写的**（现状本身为空 /
      // 正是挂机文案 / 正是我们上次写入的文案）时才清空；现状是使用者自己写的文案时
      // **保持不动**，并把它采纳为新的基线（savedText）——否则首轮启用（人已在游戏内）
      // 会悄悄抹掉使用者的文案，且此后永不恢复。见 SKILL.md「没有可恢复值时保护现状」。
      if (decision.action === 'restore' && decision.text === ''
        && current && current !== config.idleTemplate && current !== appliedText) {
        writeRaw('savedText', current);
        lastState = state;
        writeRaw('lastState', state);
        api.log(`presence-status: 无捕获值，保持使用者现有状态文字（${state}）→ 「${current}」`);
        return { action: 'skipped', reason: 'keep-current-text', state, statusDescription: current };
      }

      if (current === decision.text) {
        // 目标文案已在位（如使用者手动设过同样文案）→ 只记基线，不重复提交
        appliedText = decision.text;
        lastState = state;
        writeRaw('lastText', decision.text);
        writeRaw('lastState', state);
        return { action: 'skipped', reason: 'already-set', state };
      }

      await putDescription(me, decision.text);
      lastState = state;
      writeRaw('lastState', state);
      api.log(`presence-status: ${decision.action === 'restore' ? '回到游戏内，已恢复上次状态' : '已离开游戏，写入挂机文案'}（${state}）→ ${decision.text}`);
      return {
        action: decision.action === 'restore' ? 'restored' : 'applied',
        state,
        statusDescription: decision.text,
        at: new Date().toISOString(),
      };
    } catch (err) {
      lastError = String((err && err.message) || err);
      api.log(`presence-status: 状态描述写入失败：${lastError}`);
      return { action: 'failed', reason: 'put-failed', detail: lastError, state };
    }
  }

  let timer = null;
  function reschedule() {
    if (timer) { clearInterval(timer); timer = null; }
    const config = readConfig();
    if (!config.enabled) return;
    timer = setInterval(() => { applyStatus().catch(() => {}); }, config.pollSeconds * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // ── MCP 工具 ─────────────────────────────────────────────────────────
  api.registerTool({
    name: 'get_presence_status',
    description: '[query] 查询「按自己是否在游戏内自动切换自定义状态文字」的配置与最近一次应用结果：挂机文案、回到游戏时恢复用的已捕获文字（savedText = 上次下线时的状态）、核心自我在场判定（in_game 游戏内 / not_in_game 不在游戏 / unknown 无法判定）、最近写入与错误。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      let presence = null;
      if (api.hasService('dashboard.selfPresence')) {
        try { presence = await api.consume('dashboard.selfPresence'); } catch { /* 服务异常时只报配置 */ }
      }
      const raw = readRaw();
      return {
        plugin: 'presence-status',
        config: readConfig(),
        presence,
        savedText: raw.savedText || '',
        lastState: lastState || raw.lastState || '',
        lastText: appliedText,
        lastAppliedAt: raw.lastAppliedAt || '',
        lastError,
        minApplyIntervalMs: MIN_APPLY_INTERVAL_MS,
        serviceAvailable: api.hasService('dashboard.selfPresence'),
      };
    },
  });

  api.registerTool({
    name: 'set_presence_status',
    description: '[manage] 设置「按自己是否在游戏内自动切换自定义状态文字」：enabled 开关（默认关闭）、idleTemplate 不在游戏时写入的文案（≤64 字符，只改状态文字不改在线形态）、pollSeconds 轮询间隔秒（默认 60，下限 20）、savedText 回游戏时恢复用的文字（省略=保留已捕获值；传空串=清空，回到游戏后不改文字）、syncNow 保存后是否立即同步一次（默认 true）。进游戏恢复的是"上次下线时捕获的状态文字"；没有捕获值时不改使用者自己的现有文案。⚠️ 与本服务另一状态功能 set_dynamic_status（按在线好友数改状态文字）写同一个 statusDescription，同时启用会互相覆盖，建议只启用其一。',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: '是否启用自动切换（默认关闭）' },
        idleTemplate: { type: 'string', description: '不在游戏内时写入的自定义状态文字（≤64 字符）' },
        savedText: { type: 'string', description: '回到游戏内时要恢复的文字（省略=保留当前已捕获值；空串=清空）' },
        pollSeconds: { type: 'number', description: '轮询在场状态的间隔秒数（默认 60，下限 20，上限 3600）' },
        syncNow: { type: 'boolean', description: '保存后立即同步一次（默认 true）' },
      },
    },
    destructive: false,
    handler: async (args = {}) => {
      if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
        return { ok: false, error: 'enabled 必须是 boolean' };
      }
      if (args.idleTemplate !== undefined && !isValidTemplate(args.idleTemplate)) {
        return { ok: false, error: `idleTemplate 必须是非空字符串且不超过 ${MAX_TEMPLATE_CHARS} 字符` };
      }
      if (args.savedText !== undefined && typeof args.savedText !== 'string') {
        return { ok: false, error: 'savedText 必须是字符串（空串=清空）' };
      }
      if (args.savedText !== undefined && args.savedText !== '' && !isValidTemplate(args.savedText)) {
        return { ok: false, error: `savedText 不能超过 ${MAX_TEMPLATE_CHARS} 字符` };
      }
      if (args.pollSeconds !== undefined && !Number.isFinite(Number(args.pollSeconds))) {
        return { ok: false, error: 'pollSeconds 必须是数字' };
      }

      if (args.enabled !== undefined) writeRaw('enabled', args.enabled ? 'true' : 'false');
      if (args.idleTemplate !== undefined) writeRaw('idleTemplate', args.idleTemplate);
      if (args.savedText !== undefined) writeRaw('savedText', args.savedText);
      if (args.pollSeconds !== undefined) writeRaw('pollSeconds', String(clampPollSeconds(args.pollSeconds)));

      reschedule();
      const syncResult = (args.syncNow === false)
        ? { action: 'skipped', reason: 'not-sync-now' }
        : await applyStatus({ manual: true });
      return { ok: true, config: readConfig(), savedText: readRaw().savedText || '', syncResult };
    },
  });

  reschedule();
  const boot = setTimeout(() => { applyStatus().catch(() => {}); }, BOOT_DELAY_MS);
  if (typeof boot.unref === 'function') boot.unref();

  api.log(`presence-status: 已加载（enabled=${readConfig().enabled}，pollSeconds=${readConfig().pollSeconds}）`);

  return function dispose() {
    if (timer) { clearInterval(timer); timer = null; }
    clearTimeout(boot);
  };
}
