"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  Clock,
  HeartHandshake,
  Moon,
  RefreshCw,
  RotateCcw,
  Satellite,
  Search,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";

import { PageShell } from "@/components/ui/page-shell";
import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
  addChatContact,
  createOrGetSession,
  loadChatContacts,
  loadChatSessions,
} from "@/lib/chat-storage";
import { loadIdleReconnectRules, type IdleReconnectRule } from "@/lib/idle-reconnect-storage";
import { isPersonalPushCloudActive } from "@/lib/personal-push-cloud";
import {
  applyFollowUpSensitivityPreset,
  computeAutoProactiveMetrics,
  detectFollowUpSensitivityPreset,
  formatIntervalLabel,
  getCharacterProactiveSettings,
  getDefaultProactiveContactConfig,
  getEffectiveIdleIntervalMinutes,
  loadProactiveContactConfig,
  PROACTIVE_CONTACT_UPDATED_EVENT,
  PROACTIVE_MODE_META,
  resetCharacterConsecutiveCount,
  saveProactiveContactConfig,
  syncAllProactiveRules,
  syncCharacterProactiveRule,
  updateCharacterProactiveSettings,
  type CharacterProactiveSettings,
  type FollowUpSensitivityPreset,
  type ProactiveContactConfig,
  type ProactiveFrequencyMode,
} from "@/lib/proactive-contact";
import { armTimedWakeBailout, cancelBailoutKey } from "@/lib/push-bailout-client";
import {
  disableOfflinePush,
  enableOfflinePush,
  getOfflinePushState,
  isShellEnvironment,
  loadPushQuietHours,
  savePushQuietHours,
  sendTestOfflinePush,
  type OfflinePushState,
} from "@/lib/push-client";
import { loadFollowUpConfig } from "@/lib/settings-storage";
import {
  loadTimedWakeSchedules,
  makeTimedWakeId,
  removeTimedWakeSchedule,
  saveTimedWakeSchedule,
  type TimedWakeSchedule,
} from "@/lib/timed-wake-storage";

type ProactiveContactAppProps = {
  onClose: () => void;
  onNotice?: (text: string) => void;
};

const MODE_KEYS: ProactiveFrequencyMode[] = ["auto", "clingy", "normal", "chill", "custom"];

const FOLLOWUP_PRESETS: Array<{ id: FollowUpSensitivityPreset; label: string; desc: string }> = [
  { id: "off", label: "关闭追发", desc: "聊完不主动追问" },
  { id: "gentle", label: "温柔克制", desc: "高焦虑才追发，等待更久" },
  { id: "balanced", label: "适中自然", desc: "系统默认节奏" },
  { id: "eager", label: "积极粘人", desc: "更容易触发短间隔追发" },
];

const CUSTOM_INTERVAL_PRESETS = [
  { label: "15分", minutes: 15 },
  { label: "30分", minutes: 30 },
  { label: "1小时", minutes: 60 },
  { label: "3小时", minutes: 180 },
  { label: "6小时", minutes: 360 },
  { label: "12小时", minutes: 720 },
];

function parseQuietWindow(raw: string): { enabled: boolean; start: string; end: string } {
  const match = raw.match(/^(\d{1,2}):(\d{2})\s*[-~—]\s*(\d{1,2}):(\d{2})$/);
  if (!match) return { enabled: false, start: "23:00", end: "08:00" };
  return {
    enabled: true,
    start: `${match[1].padStart(2, "0")}:${match[2]}`,
    end: `${match[3].padStart(2, "0")}:${match[4]}`,
  };
}

function formatRemainingTime(fireAt: number): string {
  const remainMinutes = Math.max(0, Math.round((fireAt - Date.now()) / 60000));
  const remain = remainMinutes >= 1440
    ? `${Math.round((remainMinutes / 1440) * 10) / 10} 天后`
    : remainMinutes >= 60
      ? `${Math.round((remainMinutes / 60) * 10) / 10} 小时后`
      : `${remainMinutes} 分钟后`;
  const absolute = new Date(fireAt).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${remain}（${absolute}）`;
}

export function ProactiveContactApp({ onClose, onNotice }: ProactiveContactAppProps) {
  const [config, setConfig] = useState<ProactiveContactConfig>(() => loadProactiveContactConfig());
  const [characters, setCharacters] = useState<Character[]>([]);
  const [contactIds, setContactIds] = useState<Set<string>>(() => new Set());
  const [idleRules, setIdleRules] = useState<IdleReconnectRule[]>([]);
  const [sessionsByCharacterId, setSessionsByCharacterId] = useState<Map<string, string>>(() => new Map());
  const [timedSchedules, setTimedSchedules] = useState<TimedWakeSchedule[]>([]);
  const [followUpPreset, setFollowUpPreset] = useState<FollowUpSensitivityPreset>(() =>
    detectFollowUpSensitivityPreset(),
  );

  const initialQuiet = parseQuietWindow(loadPushQuietHours());
  const [quietEnabled, setQuietEnabled] = useState(initialQuiet.enabled);
  const [quietStart, setQuietStart] = useState(initialQuiet.start);
  const [quietEnd, setQuietEnd] = useState(initialQuiet.end);

  const [offlinePushState, setOfflinePushState] = useState<OfflinePushState>("unsupported");
  const [isShellApp, setIsShellApp] = useState(false);
  const [personalCloudActive, setPersonalCloudActive] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingCharId, setSyncingCharId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "enabled">("all");
  const [expandedCharId, setExpandedCharId] = useState<string | null>(null);
  const [showGlobalAdvanced, setShowGlobalAdvanced] = useState(false);
  const [showTimedSection, setShowTimedSection] = useState(false);

  // 编辑草稿状态（自定义间隔 & 引导意图）
  const [customMinuteDrafts, setCustomMinuteDrafts] = useState<Record<string, string>>({});
  const [intentDrafts, setIntentDrafts] = useState<Record<string, string>>({});

  // 新建一次性定时唤醒草稿
  const [onceCharId, setOnceCharId] = useState("");
  const [onceValue, setOnceValue] = useState("60");
  const [onceUnit, setOnceUnit] = useState<"minute" | "hour" | "day">("minute");
  const [onceIntent, setOnceIntent] = useState("");
  const [onceBusy, setOnceBusy] = useState(false);

  const toast = useCallback((msg: string) => {
    if (onNotice) onNotice(msg);
    else if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("global-notice", { detail: msg }));
    }
  }, [onNotice]);

  const reloadAll = useCallback(() => {
    setConfig(loadProactiveContactConfig());
    setCharacters(loadCharacters());
    setContactIds(new Set(loadChatContacts().map(c => c.characterId)));
    setIdleRules(loadIdleReconnectRules());
    const nextSessions = new Map<string, string>();
    for (const session of loadChatSessions()) {
      if (!session.isGroup && !nextSessions.has(session.contactId)) {
        nextSessions.set(session.contactId, session.id);
      }
    }
    setSessionsByCharacterId(nextSessions);
    setTimedSchedules(loadTimedWakeSchedules().slice().sort((a, b) => a.fireAt - b.fireAt));
    setFollowUpPreset(detectFollowUpSensitivityPreset());
  }, []);

  useEffect(() => {
    reloadAll();
    setIsShellApp(isShellEnvironment());
    setPersonalCloudActive(isPersonalPushCloudActive());
    void getOfflinePushState().then(setOfflinePushState);

    const onUpdated = () => reloadAll();
    window.addEventListener(PROACTIVE_CONTACT_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(PROACTIVE_CONTACT_UPDATED_EVENT, onUpdated);
  }, [reloadAll]);



  const idleRuleByCharacterId = useMemo(() => {
    const map = new Map<string, IdleReconnectRule>();
    for (const rule of idleRules) {
      map.set(rule.characterId, rule);
    }
    return map;
  }, [idleRules]);

  const sortedCharacters = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    const list = characters.filter(char => {
      if (keyword && !char.name.toLowerCase().includes(keyword)) return false;
      if (filterMode === "enabled") {
        const s = getCharacterProactiveSettings(char.id, config);
        return s.enabled && (s.followUpEnabled || s.idleReconnectEnabled);
      }
      return true;
    });

    return [...list].sort((a, b) => {
      const aContact = contactIds.has(a.id) ? 0 : 1;
      const bContact = contactIds.has(b.id) ? 0 : 1;
      if (aContact !== bContact) return aContact - bContact;
      const aSettings = getCharacterProactiveSettings(a.id, config);
      const bSettings = getCharacterProactiveSettings(b.id, config);
      const aActive = aSettings.enabled && (aSettings.followUpEnabled || aSettings.idleReconnectEnabled) ? 0 : 1;
      const bActive = bSettings.enabled && (bSettings.followUpEnabled || bSettings.idleReconnectEnabled) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.name.localeCompare(b.name, "zh-CN");
    });
  }, [characters, contactIds, config, filterMode, searchText]);

  const activeCharacterCount = useMemo(() => {
    return characters.filter(char => {
      const s = getCharacterProactiveSettings(char.id, config);
      return s.enabled && (s.followUpEnabled || s.idleReconnectEnabled);
    }).length;
  }, [characters, config]);

  const updateGlobalConfig = async (
    patch: Partial<ProactiveContactConfig>,
    options?: { syncRules?: boolean; noticeText?: string },
  ) => {
    const next: ProactiveContactConfig = { ...config, ...patch };
    setConfig(next);
    saveProactiveContactConfig(next);
    if (options?.syncRules) {
      setSyncingAll(true);
      try {
        await syncAllProactiveRules({ syncBailout: true });
        reloadAll();
      } finally {
        setSyncingAll(false);
      }
    }
    if (options?.noticeText) toast(options.noticeText);
  };

  const handleGlobalMuteToggle = async (enableAll: boolean) => {
    await updateGlobalConfig(
      { globalEnabled: enableAll },
      {
        syncRules: true,
        noticeText: enableAll
          ? "已恢复全部主动联系，并同步离线预约"
          : "已一键暂停全部角色主动联系（聊天回复不受影响）",
      },
    );
  };

  const handleSyncAll = async () => {
    if (syncingAll) return;
    setSyncingAll(true);
    try {
      await syncAllProactiveRules({ syncBailout: true });
      reloadAll();
      toast("已将全部角色节奏同步到调度与离线推送");
    } finally {
      setSyncingAll(false);
    }
  };

  const handleFollowUpPreset = (preset: FollowUpSensitivityPreset) => {
    applyFollowUpSensitivityPreset(preset);
    setFollowUpPreset(preset);
    setConfig(loadProactiveContactConfig());
    const label = FOLLOWUP_PRESETS.find(item => item.id === preset)?.label ?? "";
    toast(`追发灵敏度已切换为「${label}」`);
  };

  const persistQuietHours = (enabled: boolean, start: string, end: string) => {
    savePushQuietHours(enabled && start && end ? `${start}-${end}` : "");
    toast(enabled ? `安静时段已设为 ${start} - ${end}` : "已关闭安静时段限制");
  };

  const handleOfflinePushToggle = async (enabled: boolean) => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (enabled) {
        const res = await enableOfflinePush();
        if (res.ok) {
          setOfflinePushState("on");
          toast("已开启本设备离线推送");
        } else {
          setOfflinePushState("off");
          toast(res.error || "开启离线推送失败");
        }
      } else {
        await disableOfflinePush();
        setOfflinePushState("off");
        toast("已关闭本设备离线推送");
      }
    } finally {
      setPushBusy(false);
    }
  };

  const handleTestOfflinePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const res = await sendTestOfflinePush();
      toast(res.ok ? "测试推送已发送，约 6 秒后送达" : (res.error || "测试发送失败"));
    } finally {
      setPushBusy(false);
    }
  };

  const handleUpdateChar = async (
    characterId: string,
    patch: Partial<CharacterProactiveSettings>,
    options?: { ensureSession?: boolean; syncBailout?: boolean; noticeText?: string },
  ) => {
    setSyncingCharId(characterId);
    try {
      const next = await updateCharacterProactiveSettings(characterId, patch, {
        ensureSession: options?.ensureSession,
        syncBailout: options?.syncBailout ?? true,
      });
      setConfig(next);
      reloadAll();
      if (options?.noticeText) toast(options.noticeText);
    } finally {
      setSyncingCharId(null);
    }
  };

  const handleManualSyncChar = async (characterId: string) => {
    setSyncingCharId(characterId);
    try {
      await syncCharacterProactiveRule(characterId, { ensureSession: true, syncBailout: true });
      reloadAll();
      toast("已同步该角色的调度规则与离线预约");
    } finally {
      setSyncingCharId(null);
    }
  };

  const handleResetConsecutive = async (characterId: string) => {
    setSyncingCharId(characterId);
    try {
      await resetCharacterConsecutiveCount(characterId);
      reloadAll();
      toast("已清零连发计数，恢复正常联系节奏");
    } finally {
      setSyncingCharId(null);
    }
  };

  const handleCreateOnceWake = async () => {
    if (onceBusy) return;
    if (!onceCharId) {
      toast("请先选择角色");
      return;
    }
    const amount = Number(onceValue);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast("请输入有效的时间数值");
      return;
    }
    const unitMs = onceUnit === "day" ? 86_400_000 : onceUnit === "hour" ? 3_600_000 : 60_000;
    const delayMs = amount * unitMs;
    if (delayMs < 60_000 || delayMs > 7 * 86_400_000) {
      toast("定时范围需在 1 分钟 ~ 7 天之间");
      return;
    }
    setOnceBusy(true);
    try {
      addChatContact(onceCharId);
      const session = createOrGetSession(onceCharId);
      const now = Date.now();
      const schedule: TimedWakeSchedule = {
        id: makeTimedWakeId(session.id),
        sessionId: session.id,
        characterId: onceCharId,
        createdAt: now,
        fireAt: now + delayMs,
        delayMinutes: Math.max(1, Math.round(delayMs / 60_000)),
        intent: onceIntent.trim() || "主动联系",
        source: "user",
      };
      saveTimedWakeSchedule(schedule);
      const armRes = await armTimedWakeBailout(schedule);
      setOnceIntent("");
      reloadAll();
      toast(armRes.ok
        ? "已创建定时主动消息并预约离线推送"
        : `已保存本地定时（离线推送提示：${armRes.reason}）`);
    } finally {
      setOnceBusy(false);
    }
  };

  const handleDeleteTimedSchedule = (schedule: TimedWakeSchedule) => {
    removeTimedWakeSchedule(schedule.id);
    cancelBailoutKey(`timedwake:${schedule.id}`);
    reloadAll();
    toast("已取消该条定时主动消息");
  };

  const followUpConfig = loadFollowUpConfig();

  return (
    <PageShell
      title="主动联系"
      onBack={onClose}
      rightAction={
        <button
          type="button"
          className="page-back-btn"
          onClick={() => void handleSyncAll()}
          disabled={syncingAll}
          title="同步全部离线预约"
          aria-label="同步全部离线预约"
        >
          <RefreshCw size={18} className={syncingAll ? "animate-spin" : ""} />
        </button>
      }
    >
      <div className="proactive-app-body">
        {/* 1. 全局总控 */}
        <section className="proactive-card proactive-hero-card">
          <div className="proactive-row">
            <div className="proactive-label-group">
              <span className="proactive-label flex items-center gap-1.5">
                {config.globalEnabled ? <Bell size={16} /> : <BellOff size={16} />}
                主动联系总开关
              </span>
              <span className="proactive-desc">
                {config.globalEnabled
                  ? `已启用 · 当前 ${activeCharacterCount}/${characters.length} 个角色允许主动找你`
                  : "已全局暂停 · 所有追发、冷场重连、经期关怀与角色自主约时均暂不触发"}
              </span>
            </div>
            <Toggle
              checked={config.globalEnabled}
              onChange={v => void handleGlobalMuteToggle(v)}
            />
          </div>

          <div className="proactive-quick-actions">
            <button
              type="button"
              className="ui-btn ui-btn-outline ts-12"
              onClick={() => void handleGlobalMuteToggle(!config.globalEnabled)}
              disabled={syncingAll}
            >
              {config.globalEnabled ? <BellOff size={14} /> : <Bell size={14} />}
              {config.globalEnabled ? "一键全部静音" : "一键恢复联系"}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-soft-action ts-12"
              onClick={() => void handleSyncAll()}
              disabled={syncingAll}
            >
              <RefreshCw size={14} className={syncingAll ? "animate-spin" : ""} />
              {syncingAll ? "同步中..." : "同步离线预约"}
            </button>
          </div>
        </section>

        {/* 2. 能力分流与安静时段 */}
        <div className="proactive-section-title">触发能力与安静时段</div>
        <section className="proactive-card">
          <div className="proactive-row">
            <div className="proactive-label-group">
              <span className="proactive-label">聊天自动追发</span>
              <span className="proactive-desc">你暂时没回复时，按角色情绪与节奏补充追问</span>
            </div>
            <Toggle
              checked={config.followUpEnabled}
              disabled={!config.globalEnabled}
              onChange={v => void updateGlobalConfig({ followUpEnabled: v }, { syncRules: true })}
            />
          </div>

          <div className="proactive-row">
            <div className="proactive-label-group">
              <span className="proactive-label">冷场主动重连</span>
              <span className="proactive-desc">长时间未联系时，角色按设定频率或自动变频来找你</span>
            </div>
            <Toggle
              checked={config.idleReconnectEnabled}
              disabled={!config.globalEnabled}
              onChange={v => void updateGlobalConfig({ idleReconnectEnabled: v }, { syncRules: true })}
            />
          </div>

          <div className="proactive-row">
            <div className="proactive-label-group">
              <span className="proactive-label">经期日主动关怀</span>
              <span className="proactive-desc">在日历记录的经期关怀日发送关心消息</span>
            </div>
            <Toggle
              checked={config.periodCareEnabled}
              disabled={!config.globalEnabled}
              onChange={v => void updateGlobalConfig({ periodCareEnabled: v })}
            />
          </div>

          <div className="proactive-row">
            <div className="proactive-label-group">
              <span className="proactive-label flex items-center gap-1.5">
                <Moon size={15} />
                安静时段（免打扰）
              </span>
              <span className="proactive-desc">时段内不主动联系、不发离线唤醒；你主动聊天不受影响</span>
            </div>
            <Toggle
              checked={quietEnabled}
              onChange={v => {
                setQuietEnabled(v);
                persistQuietHours(v, quietStart, quietEnd);
              }}
            />
          </div>

          {quietEnabled && (
            <div className="proactive-row">
              <span className="proactive-desc">免打扰时段</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="time"
                  className="proactive-mini-input"
                  value={quietStart}
                  onChange={e => {
                    setQuietStart(e.target.value);
                    persistQuietHours(true, e.target.value, quietEnd);
                  }}
                />
                <span className="ts-12 opacity-60">至</span>
                <input
                  type="time"
                  className="proactive-mini-input"
                  value={quietEnd}
                  onChange={e => {
                    setQuietEnd(e.target.value);
                    persistQuietHours(true, quietStart, e.target.value);
                  }}
                />
              </div>
            </div>
          )}

          <div className="proactive-row">
            <div className="proactive-label-group">
              <span className="proactive-label flex items-center gap-1.5">
                <Satellite size={15} />
                设备离线推送
              </span>
              <span className="proactive-desc">
                {personalCloudActive ? "个人云已连接" : "个人云未部署（仅前台轮询可用）"}
                {isShellApp ? " · 壳App通道已就绪" : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {(offlinePushState === "on" || isShellApp) && (
                <button
                  type="button"
                  className="ui-btn ui-btn-outline !py-1 !px-2.5 ts-11"
                  disabled={pushBusy}
                  onClick={() => void handleTestOfflinePush()}
                >
                  测试
                </button>
              )}
              <Toggle
                checked={offlinePushState === "on" || isShellApp}
                disabled={pushBusy || isShellApp || offlinePushState === "unsupported"}
                onChange={v => void handleOfflinePushToggle(v)}
              />
            </div>
          </div>
        </section>

        {/* 3. 默认节奏与追发参数 */}
        <section className="proactive-card">
          <button
            type="button"
            className="w-full flex items-center justify-between gap-2 text-left"
            onClick={() => setShowGlobalAdvanced(prev => !prev)}
          >
            <div className="proactive-label-group">
              <span className="proactive-label flex items-center gap-1.5">
                <Sparkles size={15} />
                默认节奏与追发灵敏度
              </span>
              <span className="proactive-desc">
                默认：{PROACTIVE_MODE_META[config.defaultMode].label} · 自动变频范围 {formatIntervalLabel(config.autoMinMinutes)} ~ {formatIntervalLabel(config.autoMaxMinutes)} · 追发：{FOLLOWUP_PRESETS.find(p => p.id === followUpPreset)?.label}
              </span>
            </div>
            {showGlobalAdvanced ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </button>

          {showGlobalAdvanced && (
            <div className="mt-3 pt-3 border-t border-[color-mix(in_srgb,var(--c-card-border)_28%,transparent)] flex flex-col gap-3">
              <div>
                <div className="ts-12 font-semibold text-[var(--c-text-title)] mb-1.5">新角色默认节奏</div>
                <div className="proactive-pill-group">
                  {MODE_KEYS.map(modeKey => (
                    <button
                      key={modeKey}
                      type="button"
                      className={`proactive-pill ${config.defaultMode === modeKey ? "active" : ""}`}
                      onClick={() => void updateGlobalConfig({ defaultMode: modeKey })}
                    >
                      {PROACTIVE_MODE_META[modeKey].shortLabel}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="ts-12 font-semibold text-[var(--c-text-title)] mb-1.5">
                  追发灵敏度（当前阈值 {followUpConfig.anxietyThreshold}% · {followUpConfig.anxietyMinDelay}~{followUpConfig.anxietyMaxDelay}秒）
                </div>
                <div className="proactive-pill-group">
                  {FOLLOWUP_PRESETS.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      className={`proactive-pill ${followUpPreset === item.id ? "active" : ""}`}
                      title={item.desc}
                      onClick={() => handleFollowUpPreset(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="ts-12 text-[var(--c-text)]">自动变频下限 / 上限（分钟）</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={5}
                    max={720}
                    className="proactive-mini-input w-[72px] text-center"
                    value={config.autoMinMinutes}
                    onChange={e => {
                      const val = Math.max(5, Math.min(720, Number(e.target.value) || 15));
                      void updateGlobalConfig({
                        autoMinMinutes: val,
                        autoMaxMinutes: Math.max(val, config.autoMaxMinutes),
                      });
                    }}
                  />
                  <span className="ts-12 opacity-60">~</span>
                  <input
                    type="number"
                    min={15}
                    max={4320}
                    className="proactive-mini-input w-[78px] text-center"
                    value={config.autoMaxMinutes}
                    onChange={e => {
                      const val = Math.max(config.autoMinMinutes, Math.min(4320, Number(e.target.value) || 360));
                      void updateGlobalConfig({ autoMaxMinutes: val });
                    }}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="ts-12 text-[var(--c-text)]">默认最大连发次数（不回时）</span>
                <div className="proactive-pill-group">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button
                      key={n}
                      type="button"
                      className={`proactive-pill ${config.defaultMaxConsecutive === n ? "active" : ""}`}
                      onClick={() => void updateGlobalConfig({ defaultMaxConsecutive: n })}
                    >
                      {n}次
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="ui-btn ui-btn-outline ts-12 self-start"
                onClick={() => {
                  const defaults = getDefaultProactiveContactConfig();
                  void updateGlobalConfig(
                    {
                      ...defaults,
                      characters: config.characters,
                    },
                    { syncRules: true, noticeText: "已恢复全局默认节奏（保留分角色设置）" },
                  );
                }}
              >
                <RotateCcw size={13} /> 恢复全局默认参数
              </button>
            </div>
          )}
        </section>

        {/* 4. 分角色主动联系列表 */}
        <div className="flex items-center justify-between px-1">
          <span className="proactive-section-title !px-0">分角色独立控制（{sortedCharacters.length}）</span>
          <div className="proactive-pill-group">
            <button
              type="button"
              className={`proactive-pill !py-1 !px-2.5 !text-[11px] ${filterMode === "all" ? "active" : ""}`}
              onClick={() => setFilterMode("all")}
            >
              全部
            </button>
            <button
              type="button"
              className={`proactive-pill !py-1 !px-2.5 !text-[11px] ${filterMode === "enabled" ? "active" : ""}`}
              onClick={() => setFilterMode("enabled")}
            >
              已开启
            </button>
          </div>
        </div>

        <div className="proactive-search-row">
          <div className="relative flex-1 flex items-center">
            <Search size={15} className="absolute left-3 opacity-50 pointer-events-none" />
            <input
              type="text"
              placeholder="搜索角色名字..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="proactive-search-input !pl-9"
            />
          </div>
        </div>

        {sortedCharacters.length === 0 ? (
          <div className="proactive-card text-center py-8">
            <div className="proactive-desc">没有符合条件的角色</div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {sortedCharacters.map(char => {
              const charSettings = getCharacterProactiveSettings(char.id, config);
              const sessionId = sessionsByCharacterId.get(char.id);
              const rule = idleRuleByCharacterId.get(char.id);
              const consecutive = rule?.consecutiveCount ?? 0;
              const isExpanded = expandedCharId === char.id;
              const isBusy = syncingCharId === char.id;
              const autoMetrics = computeAutoProactiveMetrics(char.id, sessionId, consecutive, Date.now(), config);
              const effectiveInterval = getEffectiveIdleIntervalMinutes(
                char.id,
                sessionId,
                consecutive,
                charSettings.customIntervalMinutes,
              );
              const isEffectivelyOn = config.globalEnabled && charSettings.enabled;
              const customDraft = customMinuteDrafts[char.id] ?? String(charSettings.customIntervalMinutes);
              const intentDraft = intentDrafts[char.id] ?? (charSettings.intent ?? rule?.intent ?? "");

              return (
                <article
                  key={char.id}
                  className={`proactive-char-card ${!isEffectivelyOn ? "is-disabled" : ""}`}
                >
                  <div className="proactive-char-head">
                    <button
                      type="button"
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                      onClick={() => setExpandedCharId(isExpanded ? null : char.id)}
                    >
                      <div className="proactive-char-avatar">
                        {char.avatar ? <img src={char.avatar} alt={char.name} /> : char.name.slice(0, 1)}
                      </div>
                      <div className="flex-1 min-w-0 flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="ts-14 font-semibold text-[var(--c-text-title)] truncate">
                            {char.name}
                          </span>
                          {!isEffectivelyOn ? (
                            <span className="proactive-badge off">已静音</span>
                          ) : charSettings.idleReconnectEnabled ? (
                            <span className="proactive-badge ok">
                              {PROACTIVE_MODE_META[charSettings.mode].shortLabel} · {formatIntervalLabel(effectiveInterval)}
                            </span>
                          ) : charSettings.followUpEnabled ? (
                            <span className="proactive-badge">仅追发</span>
                          ) : (
                            <span className="proactive-badge off">未开触发项</span>
                          )}
                          {consecutive > 0 && (
                            <span className="proactive-badge warn">
                              连发 {consecutive}/{charSettings.maxConsecutive}
                            </span>
                          )}
                        </div>
                        <span className="proactive-desc truncate">
                          {charSettings.mode === "auto"
                            ? `${autoMetrics.cadenceLabel} · ${autoMetrics.reasons[0] || "自动变频"}`
                            : PROACTIVE_MODE_META[charSettings.mode].desc}
                        </span>
                      </div>
                      {isExpanded ? <ChevronDown size={16} className="opacity-55 shrink-0" /> : <ChevronRight size={16} className="opacity-55 shrink-0" />}
                    </button>

                    <Toggle
                      checked={charSettings.enabled}
                      disabled={isBusy}
                      onChange={v => void handleUpdateChar(char.id, { enabled: v })}
                    />
                  </div>

                  {isExpanded && (
                    <div className="proactive-char-body">
                      {/* 频率档位 */}
                      <div>
                        <div className="ts-12 font-semibold text-[var(--c-text-title)] mb-1.5 flex items-center gap-1.5">
                          <Zap size={13} />
                          联系频率档位
                        </div>
                        <div className="proactive-pill-group">
                          {MODE_KEYS.map(modeKey => (
                            <button
                              key={modeKey}
                              type="button"
                              className={`proactive-pill ${charSettings.mode === modeKey ? "active" : ""}`}
                              disabled={isBusy}
                              onClick={() => void handleUpdateChar(char.id, {
                                mode: modeKey,
                                idleReconnectEnabled: true,
                              }, { ensureSession: true })}
                            >
                              {PROACTIVE_MODE_META[modeKey].label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* 自动变频依据面板 */}
                      {charSettings.mode === "auto" && (
                        <div className="proactive-metrics-box">
                          <div className="flex items-center justify-between gap-2">
                            <span className="ts-12 font-semibold text-[var(--c-text-title)] flex items-center gap-1">
                              <HeartHandshake size={14} />
                              自动变频实时推算：{formatIntervalLabel(autoMetrics.intervalMinutes)}
                            </span>
                            <span className="ts-11 opacity-75">
                              追发倍率 ×{autoMetrics.followUpMultiplier}
                            </span>
                          </div>
                          <div className="proactive-reason-list">
                            {autoMetrics.reasons.map((reason, idx) => (
                              <span key={idx} className="proactive-reason-tag">{reason}</span>
                            ))}
                            {autoMetrics.recent24hMsgs > 0 && (
                              <span className="proactive-reason-tag">近24h互动 {autoMetrics.recent24hMsgs} 条</span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* 自定义精确分钟 */}
                      {charSettings.mode === "custom" && (
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="ts-12 text-[var(--c-text)]">沉默间隔（分钟，1 ~ 4320）</span>
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                min={1}
                                max={4320}
                                className="proactive-mini-input w-[84px] text-center"
                                value={customDraft}
                                onChange={e => setCustomMinuteDrafts(prev => ({ ...prev, [char.id]: e.target.value }))}
                              />
                              <button
                                type="button"
                                className="ui-btn ui-btn-soft-action !py-1 !px-2.5 ts-11"
                                disabled={isBusy}
                                onClick={() => {
                                  const mins = Math.max(1, Math.min(4320, Math.round(Number(customDraft) || 60)));
                                  setCustomMinuteDrafts(prev => ({ ...prev, [char.id]: String(mins) }));
                                  void handleUpdateChar(
                                    char.id,
                                    { customIntervalMinutes: mins, idleReconnectEnabled: true },
                                    { ensureSession: true, noticeText: `已将 ${char.name} 设为沉默 ${formatIntervalLabel(mins)} 后主动联系` },
                                  );
                                }}
                              >
                                应用
                              </button>
                            </div>
                          </div>
                          <div className="proactive-pill-group">
                            {CUSTOM_INTERVAL_PRESETS.map(p => (
                              <button
                                key={p.minutes}
                                type="button"
                                className={`proactive-pill !py-1 !px-2.5 !text-[11px] ${charSettings.customIntervalMinutes === p.minutes ? "active" : ""}`}
                                disabled={isBusy}
                                onClick={() => {
                                  setCustomMinuteDrafts(prev => ({ ...prev, [char.id]: String(p.minutes) }));
                                  void handleUpdateChar(
                                    char.id,
                                    { customIntervalMinutes: p.minutes, idleReconnectEnabled: true },
                                    { ensureSession: true },
                                  );
                                }}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 分项触发开关 */}
                      <div className="proactive-row !py-1.5">
                        <span className="ts-12 font-medium text-[var(--c-text-title)]">聊后自动追发</span>
                        <Toggle
                          checked={charSettings.followUpEnabled}
                          disabled={isBusy}
                          onChange={v => void handleUpdateChar(char.id, { followUpEnabled: v })}
                        />
                      </div>

                      <div className="proactive-row !py-1.5">
                        <span className="ts-12 font-medium text-[var(--c-text-title)]">长时间冷场主动发消息</span>
                        <Toggle
                          checked={charSettings.idleReconnectEnabled}
                          disabled={isBusy}
                          onChange={v => void handleUpdateChar(
                            char.id,
                            { idleReconnectEnabled: v },
                            { ensureSession: v },
                          )}
                        />
                      </div>

                      {/* 连发上限 */}
                      <div className="flex items-center justify-between gap-2">
                        <span className="ts-12 text-[var(--c-text)]">未回复最多连发</span>
                        <div className="proactive-pill-group">
                          {[1, 2, 3, 4, 5].map(n => (
                            <button
                              key={n}
                              type="button"
                              className={`proactive-pill !py-1 !px-2.5 !text-[11px] ${charSettings.maxConsecutive === n ? "active" : ""}`}
                              disabled={isBusy}
                              onClick={() => void handleUpdateChar(char.id, { maxConsecutive: n })}
                            >
                              {n}次
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* 自定义引导意图 */}
                      <div className="flex flex-col gap-1.5">
                        <span className="ts-12 text-[var(--c-text)]">冷场主动联系时的引导意图（可选）</span>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            maxLength={200}
                            placeholder="例如：自然找个话题问问近况，或分享一件小事"
                            className="proactive-mini-input flex-1 min-w-0"
                            value={intentDraft}
                            onChange={e => setIntentDrafts(prev => ({ ...prev, [char.id]: e.target.value }))}
                          />
                          <button
                            type="button"
                            className="ui-btn ui-btn-outline !py-1 !px-2.5 ts-11 shrink-0"
                            disabled={isBusy}
                            onClick={() => void handleUpdateChar(
                              char.id,
                              { intent: intentDraft },
                              { noticeText: "已更新引导意图并同步预约" },
                            )}
                          >
                            保存
                          </button>
                        </div>
                      </div>

                      {/* 角色操作栏 */}
                      <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
                        <button
                          type="button"
                          className="ui-btn ui-btn-outline !py-1.5 !px-3 ts-11"
                          disabled={isBusy}
                          onClick={() => void handleManualSyncChar(char.id)}
                        >
                          <RefreshCw size={12} className={isBusy ? "animate-spin" : ""} />
                          同步此角色离线预约
                        </button>
                        {consecutive > 0 && (
                          <button
                            type="button"
                            className="ui-btn ui-btn-outline !py-1.5 !px-3 ts-11"
                            disabled={isBusy}
                            onClick={() => void handleResetConsecutive(char.id)}
                          >
                            <RotateCcw size={12} />
                            重置连发计数
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {/* 5. 定时唤醒队列与快速新建 */}
        <section className="proactive-card">
          <button
            type="button"
            className="w-full flex items-center justify-between gap-2 text-left"
            onClick={() => setShowTimedSection(prev => !prev)}
          >
            <div className="proactive-label-group">
              <span className="proactive-label flex items-center gap-1.5">
                <Clock size={15} />
                一次性定时主动消息（{timedSchedules.length}）
              </span>
              <span className="proactive-desc">
                查看角色自约/你预约的单次定时唤醒，或快速新建一条
              </span>
            </div>
            {showTimedSection ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </button>

          {showTimedSection && (
            <div className="mt-3 pt-3 border-t border-[color-mix(in_srgb,var(--c-card-border)_28%,transparent)] flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <select
                    className="proactive-mini-input flex-1"
                    value={onceCharId}
                    onChange={e => setOnceCharId(e.target.value)}
                  >
                    <option value="">选择要预约的角色...</option>
                    {characters.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    className="proactive-mini-input w-[68px] text-center"
                    value={onceValue}
                    onChange={e => setOnceValue(e.target.value)}
                  />
                  <select
                    className="proactive-mini-input"
                    value={onceUnit}
                    onChange={e => setOnceUnit(e.target.value as "minute" | "hour" | "day")}
                  >
                    <option value="minute">分钟</option>
                    <option value="hour">小时</option>
                    <option value="day">天</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="到点主动聊什么（可选）"
                    className="proactive-mini-input flex-1"
                    value={onceIntent}
                    onChange={e => setOnceIntent(e.target.value)}
                  />
                  <button
                    type="button"
                    className="ui-btn ui-btn-soft-action !py-1.5 !px-3.5 ts-12 shrink-0"
                    disabled={onceBusy}
                    onClick={() => void handleCreateOnceWake()}
                  >
                    {onceBusy ? "创建中..." : "预约一次"}
                  </button>
                </div>
              </div>

              {timedSchedules.length > 0 && (
                <div className="flex flex-col gap-2">
                  {timedSchedules.map(schedule => {
                    const charName = characters.find(c => c.id === schedule.characterId)?.name ?? "未知角色";
                    return (
                      <div
                        key={schedule.id}
                        className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 bg-[color-mix(in_srgb,var(--c-page-body-bg)_60%,transparent)]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="ts-12 font-semibold text-[var(--c-text-title)] truncate">
                            {charName} · {formatRemainingTime(schedule.fireAt)}
                          </div>
                          <div className="ts-11 text-[var(--c-text)] opacity-75 truncate">
                            {schedule.source === "user" ? "用户预约" : "角色自约"} · {schedule.intent}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="ui-btn ui-btn-outline !py-1 !px-2 ts-11 shrink-0"
                          style={{ color: "var(--c-danger)" }}
                          onClick={() => handleDeleteTimedSchedule(schedule)}
                          aria-label="取消定时"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}
