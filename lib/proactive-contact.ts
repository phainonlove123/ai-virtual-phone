// 主动联系控制中心：统一管理全局/分角色主动发消息开关、
// 频率档位与「自动变频」算法，并同步驱动追发（FollowUp）、冷场重连（IdleReconnect）与离线推送。

import { loadCharacters } from "./character-storage";
import {
  addChatContact,
  clearFollowUpSchedule,
  createOrGetSession,
  getLatestCharacterStateValues,
  loadChatContacts,
  loadChatMessages,
  loadChatSessions,
  type ChatSession,
} from "./chat-storage";
import {
  IDLE_RECONNECT_MAX_CONSECUTIVE,
  loadIdleReconnectRules,
  removeIdleReconnectRule,
  upsertIdleReconnectRule,
  type IdleReconnectRule,
} from "./idle-reconnect-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { isWithinPushQuietHours } from "./push-client";
import {
  getDefaultFollowUpConfig,
  loadFollowUpConfig,
  saveFollowUpConfig,
} from "./settings-storage";

export const PROACTIVE_CONTACT_CONFIG_KEY = "ai_phone_proactive_contact_config_v1";
export const PROACTIVE_CONTACT_UPDATED_EVENT = "ai-phone-proactive-contact-updated";

registerKvMigration(PROACTIVE_CONTACT_CONFIG_KEY);

export type ProactiveFrequencyMode = "auto" | "clingy" | "normal" | "chill" | "custom";

export type CharacterProactiveSettings = {
  enabled: boolean;
  mode: ProactiveFrequencyMode;
  /** mode === "custom" 时使用的沉默间隔（分钟），1 ~ 4320 */
  customIntervalMinutes: number;
  /** 不回复时最多连续主动发送次数，1 ~ 5 */
  maxConsecutive: number;
  followUpEnabled: boolean;
  idleReconnectEnabled: boolean;
  /** 冷场重连时给角色参考的附加引导意图（可空） */
  intent?: string;
};

export type ProactiveContactConfig = {
  globalEnabled: boolean;
  followUpEnabled: boolean;
  idleReconnectEnabled: boolean;
  periodCareEnabled: boolean;
  /** 未主动设置的默认节奏 */
  defaultMode: ProactiveFrequencyMode;
  defaultCustomIntervalMinutes: number;
  defaultMaxConsecutive: number;
  /** 自动变频允许的最小/最大沉默间隔（分钟） */
  autoMinMinutes: number;
  autoMaxMinutes: number;
  characters: Record<string, CharacterProactiveSettings>;
};

export type AutoProactiveMetrics = {
  intervalMinutes: number;
  followUpMultiplier: number;
  cadenceLabel: string;
  reasons: string[];
  avgUserReplyMin: number | null;
  recent24hMsgs: number;
  affectionValue: number | null;
};

export const PROACTIVE_MODE_META: Record<
  ProactiveFrequencyMode,
  { label: string; shortLabel: string; desc: string }
> = {
  auto: {
    label: "自动变频",
    shortLabel: "自动",
    desc: "根据你的回复速度、互动热度、好感度、时段与未回次数自动调节间隔",
  },
  clingy: {
    label: "高频粘人",
    shortLabel: "粘人 15m",
    desc: "沉默约 15 分钟主动找你，聊天追发更快",
  },
  normal: {
    label: "适中日常",
    shortLabel: "日常 1h",
    desc: "沉默约 1 小时主动找你，节奏自然不打扰",
  },
  chill: {
    label: "佛系克制",
    shortLabel: "佛系 4h",
    desc: "沉默约 4 小时才偶尔联系，保留充足空间",
  },
  custom: {
    label: "自定义间隔",
    shortLabel: "自定义",
    desc: "手动指定精确的分钟或小时数",
  },
};

export function getDefaultProactiveContactConfig(): ProactiveContactConfig {
  return {
    globalEnabled: true,
    followUpEnabled: true,
    idleReconnectEnabled: true,
    periodCareEnabled: true,
    defaultMode: "auto",
    defaultCustomIntervalMinutes: 60,
    defaultMaxConsecutive: IDLE_RECONNECT_MAX_CONSECUTIVE,
    autoMinMinutes: 15,
    autoMaxMinutes: 360,
    characters: {},
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeMode(value: unknown, fallback: ProactiveFrequencyMode): ProactiveFrequencyMode {
  if (
    value === "auto"
    || value === "clingy"
    || value === "normal"
    || value === "chill"
    || value === "custom"
  ) {
    return value;
  }
  return fallback;
}

export function loadProactiveContactConfig(): ProactiveContactConfig {
  const defaults = getDefaultProactiveContactConfig();
  if (typeof window === "undefined") return defaults;
  try {
    const raw = kvGet(PROACTIVE_CONTACT_CONFIG_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ProactiveContactConfig>;
    const autoMinMinutes = clampInt(parsed.autoMinMinutes, 5, 720, defaults.autoMinMinutes);
    const autoMaxMinutes = Math.max(
      autoMinMinutes,
      clampInt(parsed.autoMaxMinutes, 15, 4320, defaults.autoMaxMinutes),
    );
    const defaultMode = normalizeMode(parsed.defaultMode, defaults.defaultMode);
    const defaultCustomIntervalMinutes = clampInt(
      parsed.defaultCustomIntervalMinutes,
      1,
      4320,
      defaults.defaultCustomIntervalMinutes,
    );
    const defaultMaxConsecutive = clampInt(
      parsed.defaultMaxConsecutive,
      1,
      5,
      defaults.defaultMaxConsecutive,
    );

    const characters: Record<string, CharacterProactiveSettings> = {};
    if (parsed.characters && typeof parsed.characters === "object" && !Array.isArray(parsed.characters)) {
      for (const [charId, item] of Object.entries(parsed.characters)) {
        if (!charId || !item || typeof item !== "object") continue;
        const rec = item as Partial<CharacterProactiveSettings>;
        characters[charId] = {
          enabled: rec.enabled !== false,
          mode: normalizeMode(rec.mode, defaultMode),
          customIntervalMinutes: clampInt(rec.customIntervalMinutes, 1, 4320, defaultCustomIntervalMinutes),
          maxConsecutive: clampInt(rec.maxConsecutive, 1, 5, defaultMaxConsecutive),
          followUpEnabled: rec.followUpEnabled !== false,
          idleReconnectEnabled: rec.idleReconnectEnabled !== false,
          ...(typeof rec.intent === "string" && rec.intent.trim() ? { intent: rec.intent.trim().slice(0, 200) } : {}),
        };
      }
    }

    return {
      globalEnabled: parsed.globalEnabled !== false,
      followUpEnabled: parsed.followUpEnabled !== false,
      idleReconnectEnabled: parsed.idleReconnectEnabled !== false,
      periodCareEnabled: parsed.periodCareEnabled !== false,
      defaultMode,
      defaultCustomIntervalMinutes,
      defaultMaxConsecutive,
      autoMinMinutes,
      autoMaxMinutes,
      characters,
    };
  } catch {
    return defaults;
  }
}

export function saveProactiveContactConfig(config: ProactiveContactConfig): void {
  if (typeof window === "undefined") return;
  kvSet(PROACTIVE_CONTACT_CONFIG_KEY, JSON.stringify(config));
  window.dispatchEvent(new CustomEvent(PROACTIVE_CONTACT_UPDATED_EVENT, { detail: config }));
}

export function getCharacterProactiveSettings(
  characterId: string,
  config: ProactiveContactConfig = loadProactiveContactConfig(),
): CharacterProactiveSettings {
  const existing = config.characters[characterId];
  if (existing) return existing;

  // 若用户在旧版界面建过冷场规则但还没进过控制中心，继承其已有间隔与开启状态
  const legacyRule = loadIdleReconnectRules().find(rule => rule.characterId === characterId);
  if (legacyRule) {
    return {
      enabled: true,
      mode: "custom",
      customIntervalMinutes: clampInt(legacyRule.intervalMinutes, 1, 4320, config.defaultCustomIntervalMinutes),
      maxConsecutive: config.defaultMaxConsecutive,
      followUpEnabled: true,
      idleReconnectEnabled: true,
      ...(legacyRule.intent ? { intent: legacyRule.intent } : {}),
    };
  }

  return {
    enabled: true,
    mode: config.defaultMode,
    customIntervalMinutes: config.defaultCustomIntervalMinutes,
    maxConsecutive: config.defaultMaxConsecutive,
    followUpEnabled: true,
    idleReconnectEnabled: false,
    intent: "",
  };
}

export async function updateCharacterProactiveSettings(
  characterId: string,
  patch: Partial<CharacterProactiveSettings>,
  syncOptions?: { ensureSession?: boolean; syncBailout?: boolean },
): Promise<ProactiveContactConfig> {
  const config = loadProactiveContactConfig();
  const current = getCharacterProactiveSettings(characterId, config);
  const nextIntent = patch.intent !== undefined
    ? patch.intent.trim().slice(0, 200)
    : (current.intent ?? "");
  const nextChar: CharacterProactiveSettings = {
    ...current,
    ...patch,
    customIntervalMinutes: clampInt(
      patch.customIntervalMinutes ?? current.customIntervalMinutes,
      1,
      4320,
      current.customIntervalMinutes,
    ),
    maxConsecutive: clampInt(
      patch.maxConsecutive ?? current.maxConsecutive,
      1,
      5,
      current.maxConsecutive,
    ),
    ...(nextIntent ? { intent: nextIntent } : { intent: "" }),
  };
  const nextConfig: ProactiveContactConfig = {
    ...config,
    characters: {
      ...config.characters,
      [characterId]: nextChar,
    },
  };
  saveProactiveContactConfig(nextConfig);
  await syncCharacterProactiveRule(characterId, {
    ensureSession: syncOptions?.ensureSession ?? nextChar.idleReconnectEnabled,
    syncBailout: syncOptions?.syncBailout ?? true,
  });
  return nextConfig;
}

export async function resetCharacterConsecutiveCount(characterId: string): Promise<void> {
  const rule = loadIdleReconnectRules().find(r => r.characterId === characterId);
  if (!rule) return;
  const reset: IdleReconnectRule = {
    ...rule,
    consecutiveCount: 0,
    suppressedUntil: undefined,
  };
  upsertIdleReconnectRule(reset);
  await syncCharacterProactiveRule(characterId, { syncBailout: true });
}

export function isGlobalProactiveEnabled(): boolean {
  return loadProactiveContactConfig().globalEnabled;
}

export function isCharacterProactiveEnabled(characterId: string): boolean {
  const config = loadProactiveContactConfig();
  if (!config.globalEnabled) return false;
  return getCharacterProactiveSettings(characterId, config).enabled;
}

export function isFollowUpAllowedForSession(session: Pick<ChatSession, "isGroup" | "contactId"> | null | undefined): boolean {
  if (!session) return false;
  const config = loadProactiveContactConfig();
  if (!config.globalEnabled || !config.followUpEnabled) return false;
  if (session.isGroup) return true;
  const charSettings = getCharacterProactiveSettings(session.contactId, config);
  return charSettings.enabled && charSettings.followUpEnabled;
}

export function isIdleReconnectAllowedForCharacter(characterId: string): boolean {
  const config = loadProactiveContactConfig();
  if (!config.globalEnabled || !config.idleReconnectEnabled) return false;
  const charSettings = getCharacterProactiveSettings(characterId, config);
  return charSettings.enabled && charSettings.idleReconnectEnabled;
}

export function getCharacterMaxConsecutive(characterId: string): number {
  const config = loadProactiveContactConfig();
  return getCharacterProactiveSettings(characterId, config).maxConsecutive;
}

function findAffectionValue(characterId: string): number | null {
  try {
    const values = getLatestCharacterStateValues(characterId);
    if (!values || values.length === 0) return null;
    const matched = values.find(item => /(好感|亲密|羁绊|爱意|信任|心动|affection|love)/i.test(item.name));
    if (matched && Number.isFinite(matched.value)) return matched.value;
    return null;
  } catch {
    return null;
  }
}

export function computeAutoProactiveMetrics(
  characterId: string,
  sessionId?: string,
  consecutiveCount = 0,
  nowMs = Date.now(),
  config: ProactiveContactConfig = loadProactiveContactConfig(),
): AutoProactiveMetrics {
  const targetSession = sessionId
    ? loadChatSessions().find(s => s.id === sessionId)
    : loadChatSessions().find(s => !s.isGroup && s.contactId === characterId);

  const messages = targetSession ? loadChatMessages(targetSession.id, 80) : [];
  const reasons: string[] = [];

  // 1. 近期互动频率（2h / 24h）
  const twoHoursAgo = nowMs - 2 * 3_600_000;
  const oneDayAgo = nowMs - 24 * 3_600_000;
  let recent2hMsgs = 0;
  let recent24hMsgs = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const ts = Date.parse(m.createdAt);
    if (!Number.isFinite(ts)) continue;
    if (ts >= oneDayAgo) recent24hMsgs += 1;
    if (ts >= twoHoursAgo) recent2hMsgs += 1;
  }

  // 2. 用户历史回复速度（中位数，只统计 1 分钟 ~ 12 小时内正常接话的轮次）
  const replyGapsMin: number[] = [];
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (prev.role === "assistant" && curr.role === "user") {
      const gapMin = (Date.parse(curr.createdAt) - Date.parse(prev.createdAt)) / 60_000;
      if (Number.isFinite(gapMin) && gapMin >= 0.3 && gapMin <= 720) {
        replyGapsMin.push(gapMin);
      }
    }
  }
  let avgUserReplyMin: number | null = null;
  let baseMinutes = 60;
  if (replyGapsMin.length > 0) {
    const sorted = [...replyGapsMin].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    avgUserReplyMin = Math.round(median * 10) / 10;
    if (median <= 5) {
      baseMinutes = 25;
      reasons.push(`你平时约 ${Math.max(1, Math.round(median))} 分钟内回复（偏高频）`);
    } else if (median <= 20) {
      baseMinutes = 45;
      reasons.push(`你平时约 ${Math.round(median)} 分钟回复`);
    } else if (median <= 60) {
      baseMinutes = 75;
      reasons.push(`你平时约 ${Math.round(median)} 分钟回复`);
    } else if (median <= 180) {
      baseMinutes = 120;
      reasons.push(`你回复节奏较从容（约 ${Math.round(median / 60 * 10) / 10} 小时）`);
    } else {
      baseMinutes = 180;
      reasons.push("你回复间隔较长，已自动放宽等待");
    }
  } else {
    reasons.push("暂无近期互动记录，采用标准节奏");
  }

  // 3. 热聊余温加成
  let heatFactor = 1;
  if (recent2hMsgs >= 10) {
    heatFactor = 0.72;
    reasons.push(`近 2 小时热聊 ${recent2hMsgs} 条（主动更勤）`);
  } else if (recent2hMsgs >= 4) {
    heatFactor = 0.85;
  }

  // 4. 好感度/亲密度修正
  const affectionValue = findAffectionValue(characterId);
  let affectionFactor = 1;
  if (affectionValue !== null) {
    if (affectionValue >= 80) {
      affectionFactor = 0.78;
      reasons.push(`关系值 ${affectionValue}（亲密加速）`);
    } else if (affectionValue >= 55) {
      affectionFactor = 0.92;
      reasons.push(`关系值 ${affectionValue}`);
    } else if (affectionValue < 25) {
      affectionFactor = 1.25;
      reasons.push(`关系值 ${affectionValue}（保持分寸）`);
    }
  }

  // 5. 时段感知（深夜适当放缓）
  const hour = new Date(nowMs).getHours();
  let timeFactor = 1;
  if (hour >= 23 || hour < 7) {
    timeFactor = 1.45;
    if (!isWithinPushQuietHours(nowMs)) reasons.push("深夜时段放缓打扰");
  }

  // 6. 未回复连发退避（越没回，间隔指数级拉长，温柔不刷屏）
  const backoffStep = Math.max(0, Math.min(4, consecutiveCount));
  const backoffFactor = backoffStep === 0 ? 1 : Math.pow(1.85, backoffStep);
  if (backoffStep > 0) {
    reasons.push(`连续未回第 ${backoffStep + 1} 阶退避（×${backoffFactor.toFixed(1)}）`);
  }

  const rawMinutes = baseMinutes * heatFactor * affectionFactor * timeFactor * backoffFactor;
  const intervalMinutes = Math.max(
    config.autoMinMinutes,
    Math.min(config.autoMaxMinutes, Math.round(rawMinutes)),
  );

  // 追发延迟倍率（相对于 FollowUpConfig 基准秒数）
  const rawMultiplier = (intervalMinutes / 60) * (backoffStep > 0 ? 1.15 : 1);
  const followUpMultiplier = Math.max(0.55, Math.min(2.2, Math.round(rawMultiplier * 100) / 100));

  const cadenceLabel = intervalMinutes <= 25
    ? "高频粘人"
    : intervalMinutes <= 75
      ? "适中日常"
      : intervalMinutes <= 180
        ? "轻柔适度"
        : "佛系低打扰";

  return {
    intervalMinutes,
    followUpMultiplier,
    cadenceLabel,
    reasons,
    avgUserReplyMin,
    recent24hMsgs,
    affectionValue,
  };
}

export function getEffectiveIdleIntervalMinutes(
  characterId: string,
  sessionId?: string,
  consecutiveCount = 0,
  fallbackMinutes?: number,
): number {
  const config = loadProactiveContactConfig();
  const charSettings = getCharacterProactiveSettings(characterId, config);

  switch (charSettings.mode) {
    case "auto":
      return computeAutoProactiveMetrics(characterId, sessionId, consecutiveCount, Date.now(), config).intervalMinutes;
    case "clingy": {
      const steps = [15, 25, 45, 75, 120];
      return steps[Math.min(steps.length - 1, Math.max(0, consecutiveCount))];
    }
    case "normal": {
      const steps = [60, 110, 180, 270, 360];
      return steps[Math.min(steps.length - 1, Math.max(0, consecutiveCount))];
    }
    case "chill": {
      const steps = [240, 360, 540, 720, 960];
      return steps[Math.min(steps.length - 1, Math.max(0, consecutiveCount))];
    }
    case "custom":
    default:
      return clampInt(charSettings.customIntervalMinutes, 1, 4320, fallbackMinutes ?? 60);
  }
}

export function getFollowUpDelayMultiplierForSession(
  session: Pick<ChatSession, "id" | "isGroup" | "contactId"> | null | undefined,
): number {
  if (!session || session.isGroup) return 1;
  const config = loadProactiveContactConfig();
  const charSettings = getCharacterProactiveSettings(session.contactId, config);
  switch (charSettings.mode) {
    case "auto":
      return computeAutoProactiveMetrics(session.contactId, session.id, 0, Date.now(), config).followUpMultiplier;
    case "clingy":
      return 0.6;
    case "normal":
      return 1.0;
    case "chill":
      return 1.8;
    case "custom":
    default:
      return Math.max(0.5, Math.min(2.5, Math.round((charSettings.customIntervalMinutes / 60) * 100) / 100));
  }
}

export function formatIntervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours >= 24 && hours % 24 === 0 && rem === 0) return `${hours / 24} 天`;
  return rem === 0 ? `${hours} 小时` : `${hours} 小时 ${rem} 分`;
}

/** 快捷同步单角色的冷场重连规则与离线推送 */
export async function syncCharacterProactiveRule(
  characterId: string,
  options?: { ensureSession?: boolean; syncBailout?: boolean },
): Promise<void> {
  const config = loadProactiveContactConfig();
  const charSettings = getCharacterProactiveSettings(characterId, config);
  const existingRule = loadIdleReconnectRules().find(r => r.characterId === characterId);
  const shouldEnableIdle = config.globalEnabled && config.idleReconnectEnabled && charSettings.enabled && charSettings.idleReconnectEnabled;

  // 若追发也关闭，清理该角色单聊排队追发
  const session = loadChatSessions().find(s => !s.isGroup && s.contactId === characterId)
    || (options?.ensureSession && shouldEnableIdle ? (() => {
      addChatContact(characterId);
      return createOrGetSession(characterId);
    })() : undefined);

  if (session && (!config.globalEnabled || !config.followUpEnabled || !charSettings.enabled || !charSettings.followUpEnabled)) {
    clearFollowUpSchedule(session.id);
    if (options?.syncBailout) {
      const { cancelFollowUpBailout } = await import("./push-bailout-client");
      cancelFollowUpBailout(session.id);
    }
  }

  if (!shouldEnableIdle) {
    if (existingRule) {
      removeIdleReconnectRule(existingRule.id);
      if (options?.syncBailout) {
        const { cancelBailoutPrefix } = await import("./push-bailout-client");
        await cancelBailoutPrefix(`idle:${existingRule.id}:`);
      }
    }
    return;
  }

  if (!session) return;

  const intervalMinutes = getEffectiveIdleIntervalMinutes(
    characterId,
    session.id,
    existingRule?.consecutiveCount ?? 0,
    charSettings.customIntervalMinutes,
  );
  const resolvedIntent = charSettings.intent !== undefined
    ? charSettings.intent
    : (existingRule?.intent ?? "");
  const nextRule: IdleReconnectRule = existingRule
    ? { ...existingRule, sessionId: session.id, intervalMinutes, intent: resolvedIntent }
    : {
        id: `idle_${characterId}_${Date.now().toString(36)}`,
        characterId,
        sessionId: session.id,
        intervalMinutes,
        intent: resolvedIntent,
        consecutiveCount: 0,
        createdAt: Date.now(),
      };
  upsertIdleReconnectRule(nextRule);

  if (options?.syncBailout) {
    const { armIdleReconnectBailout } = await import("./push-bailout-client");
    await armIdleReconnectBailout(nextRule).catch(() => undefined);
  }
}

/** 同步全部好友角色的主动规则到系统调度与离线推送 */
export async function syncAllProactiveRules(options?: { ensureContacts?: boolean; syncBailout?: boolean }): Promise<void> {
  const contactIds = new Set(loadChatContacts().map(c => c.characterId));
  for (const r of loadIdleReconnectRules()) contactIds.add(r.characterId);
  if (options?.ensureContacts) {
    for (const c of loadCharacters()) contactIds.add(c.id);
  }
  for (const characterId of contactIds) {
    await syncCharacterProactiveRule(characterId, {
      ensureSession: options?.ensureContacts,
      syncBailout: options?.syncBailout,
    });
  }
}

export type FollowUpSensitivityPreset = "off" | "gentle" | "balanced" | "eager";

export function detectFollowUpSensitivityPreset(): FollowUpSensitivityPreset {
  const cfg = loadProactiveContactConfig();
  if (!cfg.followUpEnabled) return "off";
  const fu = loadFollowUpConfig();
  if (fu.anxietyThreshold >= 70 && fu.anxietyMinDelay >= 30) return "gentle";
  if (fu.anxietyThreshold <= 35 && fu.anxietyMinDelay <= 15) return "eager";
  return "balanced";
}

export function applyFollowUpSensitivityPreset(preset: FollowUpSensitivityPreset): void {
  const cfg = loadProactiveContactConfig();
  if (preset === "off") {
    saveProactiveContactConfig({ ...cfg, followUpEnabled: false });
    for (const s of loadChatSessions()) {
      if (!s.isGroup) clearFollowUpSchedule(s.id);
    }
    return;
  }

  const base = getDefaultFollowUpConfig();
  const current = loadFollowUpConfig();
  const patch = preset === "gentle"
    ? { anxietyThreshold: 75, anxietyMinDelay: 45, anxietyMaxDelay: 300 }
    : preset === "eager"
      ? { anxietyThreshold: 30, anxietyMinDelay: 10, anxietyMaxDelay: 90 }
      : {
          anxietyThreshold: base.anxietyThreshold,
          anxietyMinDelay: base.anxietyMinDelay,
          anxietyMaxDelay: base.anxietyMaxDelay,
        };
  saveFollowUpConfig({ ...current, ...patch });
  if (!cfg.followUpEnabled) {
    saveProactiveContactConfig({ ...cfg, followUpEnabled: true });
  }
}
