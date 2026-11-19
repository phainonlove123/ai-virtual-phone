"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { Toggle, Input } from "@/components/ui/form";
import { ConfirmDialog } from "@/components/ui/modal";
import type { ChatSession } from "@/lib/chat-storage";
import {
    createOrGetSession,
    loadChatContacts,
    loadChatSessions,
    saveChatSessions,
} from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
    addMomentComment,
    deleteMomentPost,
    getAllPosts,
    loadMomentComments,
    loadMomentsConfig,
    saveMomentsConfig,
} from "@/lib/moments-storage";
import { onUserComment, triggerImmediatePost } from "@/lib/moments-engine";
import type { MomentAuthorProfileTarget, MomentComment, MomentPost } from "@/lib/moments-types";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { kvGet, kvRemove, kvSet } from "@/lib/kv-db";
import { CHAT_OPEN_SESSION_EVENT } from "@/lib/chat-notification-events";
import {
    formatIntervalLabel,
    getCharacterProactiveSettings,
    getEffectiveIdleIntervalMinutes,
    loadProactiveContactConfig,
    PROACTIVE_CONTACT_UPDATED_EVENT,
    PROACTIVE_MODE_META,
    updateCharacterProactiveSettings,
} from "@/lib/proactive-contact";
import { MomentsAuthorProfile } from "./moments-author-profile";
import {
    AlertCircle,
    Bell,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    Image as ImageIcon,
    MessageCircle,
    MessageSquare,
    PenLine,
    Pin,
    Radio,
    SlidersHorizontal,
    Sparkles,
} from "lucide-react";

const CHAR_COVER_KEY_PREFIX = "moments_char_cover_";
const USER_COVER_ASSET_KEY = "moments_cover_asset_id";
const USER_SIGNATURE_KEY = "moments_signature";
const DEFAULT_MOMENT_AVATAR_SRC = "/images/default-moment-avatar.png";

type ActiveMomentComposer = {
    postId: string;
    replyTo?: {
        commentId: string;
        authorId: string;
        authorType: "user" | "character" | "npc";
        name: string;
    };
};

type ChatAvatarProfileProps = {
    target: MomentAuthorProfileTarget;
    session: ChatSession;
    onClose: () => void;
    onSessionUpdated?: (nextSession: ChatSession) => void;
    onOpenChatSettings?: () => void;
    onToast?: (text: string) => void;
};

function compressAndStoreCover(
    file: File,
    onStored: (assetId: string, url: string) => void,
) {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
        const maxSize = 800;
        let w = img.width;
        let h = img.height;
        if (w > maxSize || h > maxSize) {
            if (w > h) {
                h = Math.round((h * maxSize) / w);
                w = maxSize;
            } else {
                w = Math.round((w * maxSize) / h);
                h = maxSize;
            }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            URL.revokeObjectURL(objectUrl);
            return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => {
            URL.revokeObjectURL(objectUrl);
            if (!blob) return;
            void saveChatImageToIndexedDB(blob).then(assetId => {
                void getChatImageFromIndexedDB(assetId).then(url => {
                    if (url) onStored(assetId, url);
                });
            });
        }, "image/jpeg", 0.8);
    };
    img.onerror = () => URL.revokeObjectURL(objectUrl);
    img.src = objectUrl;
}

function MomentThumb({ photoUrl }: { photoUrl: string }) {
    const [resolved, setResolved] = useState<string | null>(
        photoUrl.startsWith("asset://") ? null : photoUrl,
    );

    useEffect(() => {
        let cancelled = false;
        if (!photoUrl.startsWith("asset://")) {
            setResolved(photoUrl);
            return;
        }
        const assetId = photoUrl.slice(8);
        void getChatImageFromIndexedDB(assetId).then(url => {
            if (!cancelled) setResolved(url || null);
        });
        return () => {
            cancelled = true;
        };
    }, [photoUrl]);

    if (!resolved) return null;
    return (
        <img
            src={resolved}
            alt=""
            className="w-[46px] h-[46px] rounded-[8px] object-cover shrink-0 bg-[var(--c-input)]"
        />
    );
}

export function ChatAvatarProfile({
    target,
    session,
    onClose,
    onSessionUpdated,
    onOpenChatSettings,
    onToast,
}: ChatAvatarProfileProps) {
    const isCharacter = target.authorType === "character";
    const targetCharacterId = isCharacter ? target.authorId : undefined;
    const isCurrentDirectTarget = Boolean(isCharacter && !session.isGroup && session.contactId === targetCharacterId);

    const character = useMemo(() => {
        if (!targetCharacterId) return null;
        return loadCharacters().find(c => c.id === targetCharacterId) ?? null;
    }, [targetCharacterId]);

    const userIdentity = useMemo(
        () => resolveUserIdentity(targetCharacterId ?? (session.isGroup ? undefined : session.contactId), session.isGroup && !isCharacter ? "group_chat" : "chat"),
        [isCharacter, session.contactId, session.isGroup, targetCharacterId],
    );

    const [alias, setAlias] = useState(session.alias || "");
    const [editingAlias, setEditingAlias] = useState(false);
    const [aliasDraft, setAliasDraft] = useState(session.alias || "");
    const [isPinned, setIsPinned] = useState(Boolean(session.isPinned));

    const [userSignature, setUserSignature] = useState(() => {
        if (typeof window === "undefined") return "";
        return kvGet(USER_SIGNATURE_KEY) || "make every day count (●ˇ∀ˇ●)";
    });
    const [editingSignature, setEditingSignature] = useState(false);
    const [signatureDraft, setSignatureDraft] = useState(userSignature);

    const [coverUrl, setCoverUrl] = useState<string | null>(null);
    const [hasCustomCover, setHasCustomCover] = useState(false);
    const [userCoverUrl, setUserCoverUrl] = useState<string | null>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);

    const [bioExpanded, setBioExpanded] = useState(false);
    const [generatingMoment, setGeneratingMoment] = useState(false);
    const [generateHint, setGenerateHint] = useState<string | null>(null);

    // 朋友圈自动发帖开关（MomentsInteractionConfig.autoPostDisabledCharacterIds）
    const [autoPostEnabled, setAutoPostEnabled] = useState(() => {
        if (!targetCharacterId) return true;
        const disabled = loadMomentsConfig().autoPostDisabledCharacterIds;
        return !disabled.includes(targetCharacterId);
    });

    // 主动联系开关与节奏（proactive-contact.ts）
    const [proactiveConfig, setProactiveConfig] = useState(() => loadProactiveContactConfig());
    const [proactiveBusy, setProactiveBusy] = useState(false);

    // 主页朋友圈子页面栈 + 评论/删除弹窗状态
    const [posts, setPosts] = useState<MomentPost[]>([]);
    const [profileStack, setProfileStack] = useState<MomentAuthorProfileTarget[]>([]);
    const activeProfile = profileStack[profileStack.length - 1] ?? null;
    const [activeComposer, setActiveComposer] = useState<ActiveMomentComposer | null>(null);
    const [composerText, setComposerText] = useState("");
    const composerInputRef = useRef<HTMLTextAreaElement>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    const loadCovers = useCallback(() => {
        const userAssetId = kvGet(USER_COVER_ASSET_KEY);
        if (userAssetId) {
            void getChatImageFromIndexedDB(userAssetId).then(url => {
                setUserCoverUrl(url || null);
                if (!isCharacter) {
                    setCoverUrl(url || null);
                    setHasCustomCover(Boolean(url));
                }
            });
        } else {
            setUserCoverUrl(null);
            if (!isCharacter) {
                setCoverUrl(null);
                setHasCustomCover(false);
            }
        }

        if (isCharacter && targetCharacterId) {
            const charAssetId = kvGet(`${CHAR_COVER_KEY_PREFIX}${targetCharacterId}`);
            if (charAssetId) {
                void getChatImageFromIndexedDB(charAssetId).then(url => {
                    setCoverUrl(url || null);
                    setHasCustomCover(Boolean(url));
                });
            } else {
                setCoverUrl(null);
                setHasCustomCover(false);
            }
        }
    }, [isCharacter, targetCharacterId]);

    const refreshPosts = useCallback(() => {
        const contactIds = new Set(loadChatContacts().map(c => c.characterId));
        setPosts(
            getAllPosts().filter(p =>
                p.authorType === "user"
                || contactIds.has(p.authorId)
                || (targetCharacterId ? p.authorId === targetCharacterId : false),
            ),
        );
    }, [targetCharacterId]);

    useEffect(() => {
        loadCovers();
        refreshPosts();
        const onMomentsUpdated = () => refreshPosts();
        const onProactiveUpdated = () => setProactiveConfig(loadProactiveContactConfig());
        const onCoverUpdated = () => loadCovers();
        window.addEventListener("moments-updated", onMomentsUpdated);
        window.addEventListener(PROACTIVE_CONTACT_UPDATED_EVENT, onProactiveUpdated);
        window.addEventListener("moments-cover-updated", onCoverUpdated);
        return () => {
            window.removeEventListener("moments-updated", onMomentsUpdated);
            window.removeEventListener(PROACTIVE_CONTACT_UPDATED_EVENT, onProactiveUpdated);
            window.removeEventListener("moments-cover-updated", onCoverUpdated);
        };
    }, [loadCovers, refreshPosts]);

    useEffect(() => {
        if (!generatingMoment) return;
        const onDone = () => {
            setGeneratingMoment(false);
            setGenerateHint("新动态已更新");
            refreshPosts();
        };
        window.addEventListener("moments-immediate-post-done", onDone);
        return () => window.removeEventListener("moments-immediate-post-done", onDone);
    }, [generatingMoment, refreshPosts]);

    useEffect(() => {
        if (!generateHint || generatingMoment) return;
        const timer = window.setTimeout(() => setGenerateHint(null), 3200);
        return () => window.clearTimeout(timer);
    }, [generateHint, generatingMoment]);

    useEffect(() => {
        if (!activeComposer) return;
        const timer = window.setTimeout(() => {
            composerInputRef.current?.focus({ preventScroll: true });
        }, 40);
        return () => window.clearTimeout(timer);
    }, [activeComposer]);

    const targetPosts = useMemo(() => {
        return posts.filter(p => (
            isCharacter
                ? p.authorType === "character" && p.authorId === targetCharacterId
                : p.authorType === "user"
        ));
    }, [isCharacter, posts, targetCharacterId]);

    const targetStats = useMemo(() => {
        let likes = 0;
        let comments = 0;
        for (const p of targetPosts) {
            likes += p.likes.length;
            comments += loadMomentComments(p.id).length;
        }
        return { total: targetPosts.length, likes, comments };
    }, [targetPosts]);

    const recentPhotoUrls = useMemo(() => {
        const urls: string[] = [];
        for (const p of targetPosts) {
            if (p.photoUrl) {
                urls.push(p.photoUrl);
                if (urls.length >= 3) break;
            }
        }
        return urls;
    }, [targetPosts]);

    const latestPost = targetPosts[0] ?? null;

    const displayName = isCharacter
        ? (character?.name || "未知角色")
        : (userIdentity?.name || "我");
    const avatarUrl = isCharacter
        ? (character?.avatar ?? null)
        : (userIdentity?.avatarUrl ?? null);

    const bioText = useMemo(() => {
        if (!isCharacter) {
            return userSignature || "编写你的个性签名...";
        }
        return (
            character?.briefPersona?.trim()
            || character?.personality?.trim()
            || character?.persona?.trim()
            || "这个人很神秘，还没有留下介绍。"
        );
    }, [character, isCharacter, userSignature]);

    const isLongBio = bioText.length > 84 || bioText.split("\n").length > 2;

    const persistSessionPatch = (patch: Partial<ChatSession>) => {
        const sessions = loadChatSessions();
        const idx = sessions.findIndex(s => s.id === session.id);
        const updatedSession: ChatSession = { ...session, ...patch };
        if (idx >= 0) {
            sessions[idx] = { ...sessions[idx], ...patch };
            saveChatSessions(sessions);
        }
        Object.assign(session, patch);
        onSessionUpdated?.(updatedSession);
    };

    const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        compressAndStoreCover(file, (assetId, url) => {
            if (isCharacter && targetCharacterId) {
                kvSet(`${CHAR_COVER_KEY_PREFIX}${targetCharacterId}`, assetId);
            } else {
                kvSet(USER_COVER_ASSET_KEY, assetId);
                setUserCoverUrl(url);
            }
            setCoverUrl(url);
            setHasCustomCover(true);
            window.dispatchEvent(new CustomEvent("moments-cover-updated"));
            onToast?.("已更新主页封面");
        });
        e.target.value = "";
    };

    const handleClearCover = () => {
        if (isCharacter && targetCharacterId) {
            kvRemove(`${CHAR_COVER_KEY_PREFIX}${targetCharacterId}`);
        } else {
            kvRemove(USER_COVER_ASSET_KEY);
            setUserCoverUrl(null);
        }
        setCoverUrl(null);
        setHasCustomCover(false);
        window.dispatchEvent(new CustomEvent("moments-cover-updated"));
        onToast?.("已恢复默认封面");
    };

    const handleToggleAutoPost = (enabled: boolean) => {
        if (!targetCharacterId) return;
        const cfg = loadMomentsConfig();
        const nextDisabled = new Set(cfg.autoPostDisabledCharacterIds);
        if (enabled) nextDisabled.delete(targetCharacterId);
        else nextDisabled.add(targetCharacterId);
        saveMomentsConfig({ ...cfg, autoPostDisabledCharacterIds: [...nextDisabled] });
        setAutoPostEnabled(enabled);
        onToast?.(enabled ? "已开启自动发朋友圈" : "已关闭该角色自动发朋友圈");
    };

    const charProactiveSettings = useMemo(() => {
        if (!targetCharacterId) return null;
        return getCharacterProactiveSettings(targetCharacterId, proactiveConfig);
    }, [proactiveConfig, targetCharacterId]);

    const effectiveProactiveInterval = useMemo(() => {
        if (!targetCharacterId || !charProactiveSettings) return null;
        const directSess = loadChatSessions().find(s => !s.isGroup && s.contactId === targetCharacterId);
        return getEffectiveIdleIntervalMinutes(
            targetCharacterId,
            directSess?.id,
            0,
            charProactiveSettings.customIntervalMinutes,
        );
    }, [charProactiveSettings, targetCharacterId]);

    const handleToggleProactive = async (enabled: boolean) => {
        if (!targetCharacterId || proactiveBusy) return;
        setProactiveBusy(true);
        try {
            const next = await updateCharacterProactiveSettings(
                targetCharacterId,
                { enabled },
                { syncBailout: true },
            );
            setProactiveConfig(next);
            onToast?.(enabled ? "已允许该角色主动联系" : "已暂停该角色主动联系");
        } finally {
            setProactiveBusy(false);
        }
    };

    const handleGenerateMoment = () => {
        if (!character || generatingMoment) return;
        setGeneratingMoment(true);
        setGenerateHint("正在让TA构思新动态…");
        triggerImmediatePost(character.id);
    };

    const handleOpenMomentsHomepage = () => {
        refreshPosts();
        setProfileStack([target]);
    };

    const openAuthorProfile = useCallback((nextTarget: MomentAuthorProfileTarget) => {
        setProfileStack(prev => {
            const top = prev[prev.length - 1];
            if (
                top
                && top.authorType === nextTarget.authorType
                && (top.authorType === "user" || (nextTarget.authorType === "character" && top.authorId === nextTarget.authorId))
            ) {
                return prev;
            }
            return [...prev, nextTarget];
        });
    }, []);

    const closeTopProfile = useCallback(() => {
        setProfileStack(prev => prev.slice(0, -1));
    }, []);

    const closeComposer = useCallback(() => {
        setActiveComposer(null);
        setComposerText("");
        composerInputRef.current?.blur();
    }, []);

    const openCommentComposer = useCallback((post: MomentPost) => {
        setComposerText("");
        setActiveComposer({ postId: post.id });
    }, []);

    const openReplyComposer = useCallback((post: MomentPost, comment: MomentComment, replyName: string) => {
        setComposerText("");
        setActiveComposer({
            postId: post.id,
            replyTo: {
                commentId: comment.id,
                authorId: comment.authorId,
                authorType: comment.authorType,
                name: replyName,
            },
        });
    }, []);

    const submitComposer = useCallback(() => {
        const text = composerText.trim();
        const composerTarget = activeComposer;
        if (!text || !composerTarget) return;

        addMomentComment({
            postId: composerTarget.postId,
            authorType: "user",
            authorId: "user",
            content: text,
            replyToCommentId: composerTarget.replyTo?.commentId,
            replyToAuthorId: composerTarget.replyTo?.authorId,
            replyToAuthorType: composerTarget.replyTo?.authorType,
        });

        closeComposer();
        refreshPosts();
        window.dispatchEvent(new CustomEvent("moments-updated"));
        onUserComment(composerTarget.postId);
    }, [activeComposer, closeComposer, composerText, refreshPosts]);

    const handleDeleteConfirm = () => {
        if (!confirmDeleteId) return;
        deleteMomentPost(confirmDeleteId);
        setConfirmDeleteId(null);
        refreshPosts();
        window.dispatchEvent(new CustomEvent("moments-updated"));
    };

    const handleOpenCharacterChat = (characterId: string) => {
        if (!session.isGroup && session.contactId === characterId) {
            setProfileStack([]);
            onClose();
            return;
        }
        const targetSess = createOrGetSession(characterId);
        setProfileStack([]);
        onClose();
        window.dispatchEvent(new CustomEvent(CHAT_OPEN_SESSION_EVENT, { detail: { sessionId: targetSess.id } }));
    };

    const pageTitle = isCharacter
        ? (isCurrentDirectTarget && alias ? alias : displayName)
        : "我的主页";

    return (
        <>
            <PageShell
                title={pageTitle}
                onBack={onClose}
                className="moments-feed-page moments-profile-page absolute inset-0 z-20"
            >
                {/* Cover + Profile Header */}
                <div className="feed-cover-shell w-full relative mb-3">
                    <div
                        onClick={() => coverInputRef.current?.click()}
                        className="feed-cover-bg absolute inset-0 w-full h-full bg-[var(--c-input)] z-0 cursor-pointer"
                        style={{
                            maskImage: "linear-gradient(to bottom, black 42%, transparent 100%)",
                            WebkitMaskImage: "linear-gradient(to bottom, black 42%, transparent 100%)",
                        }}
                    >
                        {coverUrl ? (
                            <img src={coverUrl} alt="" className="feed-cover-image w-full h-full object-cover" />
                        ) : avatarUrl ? (
                            <img src={avatarUrl} alt="" className="feed-profile-cover-fallback w-full h-full object-cover" />
                        ) : null}
                    </div>
                    <input
                        ref={coverInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleCoverUpload}
                        className="hidden"
                    />

                    <div
                        className="feed-profile relative w-full px-5 pb-4 pointer-events-none"
                        style={{ paddingTop: "calc(var(--page-header-safe-top, 48px) + var(--page-header-content-height, 54px) + 108px)" }}
                    >
                        <div className="feed-profile-avatar w-[72px] h-[72px] rounded-full border-[3px] border-[var(--c-page-body-bg)] bg-[var(--c-input)] overflow-hidden flex items-center justify-center translate-x-[2px] pointer-events-auto">
                            {avatarUrl ? (
                                <img src={avatarUrl} alt={displayName} className="feed-profile-avatar-image w-full h-full object-cover" />
                            ) : (
                                <img src={DEFAULT_MOMENT_AVATAR_SRC} alt={displayName} className="feed-default-avatar w-full h-full object-cover" />
                            )}
                        </div>

                        <div className="feed-profile-info flex flex-col gap-1.5 mt-3 ml-[6px] pointer-events-auto">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="feed-profile-name ts-20 font-bold text-[var(--c-text-title)]">
                                    {isCurrentDirectTarget && alias ? alias : displayName}
                                </span>
                                {isCurrentDirectTarget && alias && alias !== displayName && (
                                    <span className="ts-12 text-[var(--c-icon)]">原名：{displayName}</span>
                                )}
                                {isCharacter && character?.wechatID && (
                                    <span className="ts-11 text-[var(--c-icon)] opacity-75">ID: {character.wechatID}</span>
                                )}
                            </div>

                            {isCharacter && character?.tags && character.tags.length > 0 && (
                                <div className="feed-profile-tags flex flex-wrap gap-1.5 mt-0.5">
                                    {character.tags.slice(0, 6).map(tag => (
                                        <span key={tag} className="feed-profile-tag">{tag}</span>
                                    ))}
                                </div>
                            )}

                            <div className="feed-profile-stats flex gap-4 ts-13 text-[var(--c-icon)] font-medium mt-0.5">
                                <span className="feed-profile-stat">
                                    <strong className="feed-profile-stat-value text-[var(--c-text-title)]">{targetStats.total}</strong> 动态
                                </span>
                                <span className="feed-profile-stat">
                                    <strong className="feed-profile-stat-value text-[var(--c-text-title)]">{targetStats.likes}</strong> 获赞
                                </span>
                                <span className="feed-profile-stat">
                                    <strong className="feed-profile-stat-value text-[var(--c-text-title)]">{targetStats.comments}</strong> 评论
                                </span>
                            </div>

                            <div className="feed-profile-signature mt-1 text-left text-[var(--c-text)]">
                                <p className={`feed-profile-bio ts-14 opacity-90 leading-[1.6] whitespace-pre-wrap break-words m-0 ${!bioExpanded && isLongBio ? "is-clamped" : ""}`}>
                                    {bioText}
                                </p>
                                {isLongBio && (
                                    <button
                                        type="button"
                                        className="feed-profile-bio-toggle"
                                        onClick={() => setBioExpanded(prev => !prev)}
                                    >
                                        <span>{bioExpanded ? "收起简介" : "展开简介"}</span>
                                        {bioExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                                    </button>
                                )}
                            </div>

                            <div className="feed-profile-actions flex items-center gap-2.5 mt-2 flex-wrap">
                                <button
                                    type="button"
                                    className="feed-profile-action-btn feed-profile-action-primary"
                                    onClick={handleOpenMomentsHomepage}
                                >
                                    <Radio size={15} strokeWidth={1.9} />
                                    <span>{isCharacter ? "进入主页朋友圈" : "我的朋友圈"}</span>
                                </button>
                                {isCharacter && character && (
                                    <button
                                        type="button"
                                        className="feed-profile-action-btn"
                                        disabled={generatingMoment}
                                        onClick={handleGenerateMoment}
                                    >
                                        <Sparkles size={15} strokeWidth={1.9} />
                                        <span>{generatingMoment ? "生成中…" : "让TA发动态"}</span>
                                    </button>
                                )}
                                {isCharacter && character && session.isGroup && (
                                    <button
                                        type="button"
                                        className="feed-profile-action-btn"
                                        onClick={() => handleOpenCharacterChat(character.id)}
                                    >
                                        <MessageCircle size={15} strokeWidth={1.9} />
                                        <span>发消息</span>
                                    </button>
                                )}
                            </div>

                            {generateHint && (
                                <div className="ts-12 text-[var(--c-icon-active)] mt-1">{generateHint}</div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="page-menu chat-info-menu !pt-0">
                    {/* 朋友圈预览入口卡片 */}
                    <div className="menu-group">
                        <button type="button" className="menu-item" onClick={handleOpenMomentsHomepage}>
                            <div className="menu-label-group">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="menu-label">{isCharacter ? "TA 的朋友圈" : "我的朋友圈"}</span>
                                    <span className="menu-desc !mt-0">{targetStats.total} 条动态</span>
                                </div>
                                {recentPhotoUrls.length > 0 ? (
                                    <div className="flex items-center gap-2 mt-2">
                                        {recentPhotoUrls.map((url, idx) => (
                                            <MomentThumb key={`${url}-${idx}`} photoUrl={url} />
                                        ))}
                                        {latestPost?.content && (
                                            <span className="menu-desc !mt-0 flex-1 line-clamp-2">
                                                {latestPost.content}
                                            </span>
                                        )}
                                    </div>
                                ) : (
                                    <span className="menu-desc">
                                        {latestPost?.content
                                            ? latestPost.content.slice(0, 48) + (latestPost.content.length > 48 ? "…" : "")
                                            : (isCharacter ? "点击进入 TA 的朋友圈主页" : "点击查看我发过的全部朋友圈")}
                                    </span>
                                )}
                            </div>
                            <div className="menu-right">
                                <ChevronRight size={16} />
                            </div>
                        </button>
                    </div>

                    {/* 主页设置 */}
                    <p className="menu-group-desc mx-2">主页设置</p>
                    <div className="menu-group">
                        {isCharacter ? (
                            <>
                                {isCurrentDirectTarget && (
                                    <button
                                        type="button"
                                        className="menu-item"
                                        onClick={() => {
                                            setAliasDraft(alias);
                                            setEditingAlias(true);
                                        }}
                                    >
                                        <MessageSquare size={18} className="text-[var(--c-icon)] shrink-0" strokeWidth={1.6} />
                                        <div className="menu-label-group">
                                            <span className="menu-label">设置备注</span>
                                        </div>
                                        <div className="menu-right">
                                            <span className="menu-desc mr-1">{alias || "无备注"}</span>
                                            <ChevronRight size={16} />
                                        </div>
                                    </button>
                                )}

                                <button
                                    type="button"
                                    className="menu-item"
                                    onClick={() => coverInputRef.current?.click()}
                                >
                                    <ImageIcon size={18} className="text-[var(--c-icon)] shrink-0" strokeWidth={1.6} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">主页封面</span>
                                        <span className="menu-desc">自定义 TA 朋友圈主页顶部背景</span>
                                    </div>
                                    <div className="menu-right">
                                        {hasCustomCover ? (
                                            <span
                                                className="menu-desc mr-2 text-[var(--c-danger)]"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    handleClearCover();
                                                }}
                                            >
                                                恢复默认
                                            </span>
                                        ) : (
                                            <span className="menu-desc mr-1">默认</span>
                                        )}
                                        <ChevronRight size={16} />
                                    </div>
                                </button>

                                <div className="menu-item">
                                    <Radio size={18} className="text-[var(--c-icon)] shrink-0" strokeWidth={1.6} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">允许自动发朋友圈</span>
                                        <span className="menu-desc">关闭后 TA 不会定时自发动态，手动“让TA发动态”仍可用</span>
                                    </div>
                                    <div className="menu-right">
                                        <Toggle checked={autoPostEnabled} onChange={handleToggleAutoPost} />
                                    </div>
                                </div>

                                {charProactiveSettings && (
                                    <div className="menu-item">
                                        <Bell size={18} className="text-[var(--c-icon)] shrink-0" strokeWidth={1.6} />
                                        <div className="menu-label-group">
                                            <span className="menu-label">允许主动联系</span>
                                            <span className="menu-desc">
                                                {!proactiveConfig.globalEnabled
                                                    ? "全局主动联系已暂停"
                                                    : charProactiveSettings.enabled
                                                        ? `${PROACTIVE_MODE_META[charProactiveSettings.mode].label}${effectiveProactiveInterval ? ` · 约${formatIntervalLabel(effectiveProactiveInterval)}` : ""}`
                                                        : "已对该角色关闭追发、冷场重连与自约"}
                                            </span>
                                        </div>
                                        <div className="menu-right">
                                            <Toggle
                                                checked={charProactiveSettings.enabled}
                                                disabled={proactiveBusy}
                                                onChange={v => void handleToggleProactive(v)}
                                            />
                                        </div>
                                    </div>
                                )}

                                {isCurrentDirectTarget && (
                                    <div className="menu-item">
                                        <Pin size={18} className="text-[var(--c-icon)] shrink-0" strokeWidth={1.6} />
                                        <div className="menu-label-group">
                                            <span className="menu-label">置顶聊天</span>
                                        </div>
                                        <div className="menu-right">
                                            <Toggle
                                                checked={isPinned}
                                                onChange={v => {
                                                    setIsPinned(v);
                                                    persistSessionPatch({ isPinned: v });
                                                }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    className="menu-item"
                                    onClick={() => {
                                        setSignatureDraft(userSignature);
                                        setEditingSignature(true);
                                    }}
                                >
                                    <PenLine size={18} className="text-[var(--c-icon)] shrink-0" strokeWidth={1.6} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">个性签名</span>
                                        <span className="menu-desc">{userSignature || "点击编写签名"}</span>
                                    </div>
                                    <div className="menu-right">
                                        <ChevronRight size={16} />
                                    </div>
                                </button>

                                <button
                                    type="button"
                                    className="menu-item"
                                    onClick={() => coverInputRef.current?.click()}
                                >
                                    <ImageIcon size={18} className="text-[var(--c-icon)] shrink-0" strokeWidth={1.6} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">我的主页封面</span>
                                        <span className="menu-desc">更换朋友圈顶部封面背景</span>
                                    </div>
                                    <div className="menu-right">
                                        {hasCustomCover ? (
                                            <span
                                                className="menu-desc mr-2 text-[var(--c-danger)]"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    handleClearCover();
                                                }}
                                            >
                                                清除
                                            </span>
                                        ) : (
                                            <span className="menu-desc mr-1">未设置</span>
                                        )}
                                        <ChevronRight size={16} />
                                    </div>
                                </button>
                            </>
                        )}

                        {onOpenChatSettings && (
                            <button type="button" className="menu-item" onClick={onOpenChatSettings}>
                                <SlidersHorizontal size={18} className="text-[var(--c-icon)] shrink-0" strokeWidth={1.6} />
                                <div className="menu-label-group">
                                    <span className="menu-label">更多聊天设置</span>
                                    <span className="menu-desc">查找聊天记录、状态栏、背景、自定义 CSS 等</span>
                                </div>
                                <div className="menu-right">
                                    <ChevronRight size={16} />
                                </div>
                            </button>
                        )}
                    </div>
                </div>
            </PageShell>

            {/* 修改备注弹窗 */}
            {editingAlias && (
                <div className="modal-overlay" onClick={() => setEditingAlias(false)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">修改备注</div>
                        <Input
                            type="text"
                            value={aliasDraft}
                            onChange={e => setAliasDraft(e.target.value)}
                            placeholder={character?.name || "输入备注名"}
                        />
                        <div className="flex gap-3 w-full">
                            <button onClick={() => setEditingAlias(false)} className="ui-btn ui-btn-ghost flex-1">取消</button>
                            <button
                                onClick={() => {
                                    setAlias(aliasDraft);
                                    persistSessionPatch({ alias: aliasDraft });
                                    setEditingAlias(false);
                                }}
                                className="ui-btn ui-btn-success flex-1"
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 修改个性签名弹窗 */}
            {editingSignature && (
                <div className="modal-overlay" onClick={() => setEditingSignature(false)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">个性签名</div>
                        <Input
                            type="text"
                            value={signatureDraft}
                            onChange={e => setSignatureDraft(e.target.value)}
                            placeholder="编写你的个性签名..."
                        />
                        <div className="flex gap-3 w-full">
                            <button onClick={() => setEditingSignature(false)} className="ui-btn ui-btn-ghost flex-1">取消</button>
                            <button
                                onClick={() => {
                                    const next = signatureDraft.trim() || "make every day count (●ˇ∀ˇ●)";
                                    setUserSignature(next);
                                    kvSet(USER_SIGNATURE_KEY, next);
                                    setEditingSignature(false);
                                    onToast?.("已更新个性签名");
                                }}
                                className="ui-btn ui-btn-success flex-1"
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 完整主页朋友圈子页面 */}
            {activeProfile && (
                <MomentsAuthorProfile
                    target={activeProfile}
                    posts={posts}
                    userCoverUrl={userCoverUrl}
                    userSignature={userSignature}
                    onBack={closeTopProfile}
                    onUpdate={refreshPosts}
                    onRequestDelete={setConfirmDeleteId}
                    onOpenCommentComposer={openCommentComposer}
                    onOpenReplyComposer={openReplyComposer}
                    onSelectAuthor={openAuthorProfile}
                    onOpenChat={handleOpenCharacterChat}
                />
            )}

            {activeComposer && (
                <div className="feed-comment-modal-layer" data-ui="modal">
                    <button
                        type="button"
                        className="feed-comment-modal-backdrop"
                        aria-label="关闭评论输入"
                        onClick={closeComposer}
                    />
                    <div
                        className="feed-comment-modal-dialog"
                        data-ui="modal-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-label={activeComposer.replyTo ? `回复 ${activeComposer.replyTo.name}` : "发表评论"}
                    >
                        <div className="feed-comment-modal-title">
                            {activeComposer.replyTo ? `回复 ${activeComposer.replyTo.name}` : "发表评论"}
                        </div>
                        <textarea
                            ref={composerInputRef}
                            value={composerText}
                            onChange={e => setComposerText(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                    e.preventDefault();
                                    submitComposer();
                                } else if (e.key === "Escape") {
                                    closeComposer();
                                }
                            }}
                            placeholder={activeComposer.replyTo ? `回复 ${activeComposer.replyTo.name}` : "说点什么吧"}
                            className="feed-comment-modal-input"
                        />
                        <div className="feed-comment-modal-actions">
                            <button
                                type="button"
                                className="feed-comment-modal-cancel"
                                onClick={closeComposer}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className="feed-comment-modal-send"
                                disabled={!composerText.trim()}
                                onClick={submitComposer}
                            >
                                发送
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确定删除这条朋友圈吗？"
                    message="删除后无法恢复，评论也会一并删除。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={handleDeleteConfirm}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </>
    );
}
