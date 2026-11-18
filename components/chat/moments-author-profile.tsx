"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { PageShell } from "@/components/ui/page-shell";
import type { MomentAuthorProfileTarget, MomentComment, MomentPost } from "@/lib/moments-types";
import { loadMomentComments } from "@/lib/moments-storage";
import { loadCharacters } from "@/lib/character-storage";
import { createOrGetSession } from "@/lib/chat-storage";
import { CHAT_OPEN_SESSION_EVENT } from "@/lib/chat-notification-events";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { kvGet, kvSet } from "@/lib/kv-db";
import { triggerImmediatePost } from "@/lib/moments-engine";
import { MomentPostCard } from "./moment-post-card";
import { MessageCircle, Sparkles, Search, X, Image as ImageIcon, ChevronDown, ChevronUp } from "lucide-react";

const PROFILE_INITIAL_POST_COUNT = 10;
const PROFILE_LOAD_MORE_COUNT = 10;
const CHAR_COVER_KEY_PREFIX = "moments_char_cover_";
const DEFAULT_MOMENT_AVATAR_SRC = "/images/default-moment-avatar.png";

type PostFilterMode = "all" | "media";

type Props = {
    target: MomentAuthorProfileTarget;
    posts: MomentPost[];
    userCoverUrl: string | null;
    userSignature: string;
    onBack: () => void;
    onUpdate: () => void;
    onRequestDelete: (postId: string) => void;
    onOpenCommentComposer: (post: MomentPost) => void;
    onOpenReplyComposer: (post: MomentPost, comment: MomentComment, replyName: string) => void;
    onSelectAuthor: (target: MomentAuthorProfileTarget) => void;
};

export function MomentsAuthorProfile({
    target,
    posts,
    userCoverUrl,
    userSignature,
    onBack,
    onUpdate,
    onRequestDelete,
    onOpenCommentComposer,
    onOpenReplyComposer,
    onSelectAuthor,
}: Props) {
    const isCharacter = target.authorType === "character";
    const targetCharacterId = isCharacter ? target.authorId : undefined;

    const character = useMemo(() => {
        if (!targetCharacterId) return null;
        return loadCharacters().find(c => c.id === targetCharacterId) ?? null;
    }, [targetCharacterId]);

    const userIdentity = useMemo(
        () => resolveUserIdentity(targetCharacterId, "chat"),
        [targetCharacterId],
    );

    const displayName = isCharacter
        ? (character?.name || "未知角色")
        : (userIdentity?.name || "我");
    const avatarUrl = isCharacter
        ? (character?.avatar ?? null)
        : (userIdentity?.avatarUrl ?? null);

    const [filterMode, setFilterMode] = useState<PostFilterMode>("all");
    const [searchQuery, setSearchQuery] = useState("");
    const [visibleCount, setVisibleCount] = useState(PROFILE_INITIAL_POST_COUNT);
    const [bioExpanded, setBioExpanded] = useState(false);
    const [headerScrolled, setHeaderScrolled] = useState(false);
    const [charCoverUrl, setCharCoverUrl] = useState<string | null>(null);
    const [generatingMoment, setGeneratingMoment] = useState(false);
    const [generateHint, setGenerateHint] = useState<string | null>(null);

    const scrollRef = useRef<HTMLDivElement>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);

    // Reset view state when switching between different profiles
    const targetKey = isCharacter ? `char:${target.authorId}` : "user";
    useEffect(() => {
        setFilterMode("all");
        setSearchQuery("");
        setVisibleCount(PROFILE_INITIAL_POST_COUNT);
        setBioExpanded(false);
        setHeaderScrolled(false);
        setGenerateHint(null);
        if (scrollRef.current) {
            scrollRef.current.scrollTop = 0;
        }
    }, [targetKey]);

    // Load per-character custom cover if set
    useEffect(() => {
        let cancelled = false;
        if (!targetCharacterId) {
            setCharCoverUrl(null);
            return;
        }
        const savedAssetId = kvGet(`${CHAR_COVER_KEY_PREFIX}${targetCharacterId}`);
        if (!savedAssetId) {
            setCharCoverUrl(null);
            return;
        }
        getChatImageFromIndexedDB(savedAssetId).then(url => {
            if (!cancelled) setCharCoverUrl(url || null);
        });
        return () => {
            cancelled = true;
        };
    }, [targetCharacterId]);

    // Track scroll for transparent -> solid header transition
    useEffect(() => {
        const bodyEl = scrollRef.current;
        if (!bodyEl) return;
        const handleScroll = () => {
            setHeaderScrolled(bodyEl.scrollTop > 160);
        };
        bodyEl.addEventListener("scroll", handleScroll, { passive: true });
        return () => bodyEl.removeEventListener("scroll", handleScroll);
    }, [targetKey]);

    // Listen for immediate post completion
    useEffect(() => {
        if (!generatingMoment) return;
        const handleDone = () => {
            setGeneratingMoment(false);
            setGenerateHint("新动态已更新");
            onUpdate();
        };
        window.addEventListener("moments-immediate-post-done", handleDone);
        return () => window.removeEventListener("moments-immediate-post-done", handleDone);
    }, [generatingMoment, onUpdate]);

    useEffect(() => {
        if (!generateHint || generatingMoment) return;
        const timer = window.setTimeout(() => setGenerateHint(null), 3200);
        return () => window.clearTimeout(timer);
    }, [generateHint, generatingMoment]);

    const authorPosts = useMemo(() => {
        return posts.filter(post => {
            if (isCharacter) {
                return post.authorType === "character" && post.authorId === targetCharacterId;
            }
            return post.authorType === "user";
        });
    }, [posts, isCharacter, targetCharacterId]);

    const stats = useMemo(() => {
        let likes = 0;
        let comments = 0;
        let media = 0;
        for (const post of authorPosts) {
            likes += post.likes.length;
            comments += loadMomentComments(post.id).length;
            if (post.photoUrl || post.photoDescription) media += 1;
        }
        return {
            total: authorPosts.length,
            likes,
            comments,
            media,
        };
    }, [authorPosts]);

    const filteredPosts = useMemo(() => {
        const keyword = searchQuery.trim().toLowerCase();
        return authorPosts.filter(post => {
            if (filterMode === "media" && !post.photoUrl && !post.photoDescription) {
                return false;
            }
            if (!keyword) return true;
            return (
                post.content.toLowerCase().includes(keyword)
                || (post.location || "").toLowerCase().includes(keyword)
                || (post.photoDescription || "").toLowerCase().includes(keyword)
            );
        });
    }, [authorPosts, filterMode, searchQuery]);

    const visiblePosts = filteredPosts.slice(0, visibleCount);
    const hasMorePosts = visibleCount < filteredPosts.length;

    const handleCoverUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !targetCharacterId) return;

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
                saveChatImageToIndexedDB(blob).then(assetId => {
                    kvSet(`${CHAR_COVER_KEY_PREFIX}${targetCharacterId}`, assetId);
                    getChatImageFromIndexedDB(assetId).then(url => {
                        if (url) setCharCoverUrl(url);
                    });
                });
            }, "image/jpeg", 0.8);
        };
        img.src = objectUrl;
        e.target.value = "";
    }, [targetCharacterId]);

    const handleOpenChat = () => {
        if (!character) return;
        const session = createOrGetSession(character.id);
        window.dispatchEvent(new CustomEvent(CHAT_OPEN_SESSION_EVENT, { detail: { sessionId: session.id } }));
    };

    const handleGenerateMoment = () => {
        if (!character || generatingMoment) return;
        setGeneratingMoment(true);
        setGenerateHint("正在让TA构思新动态…");
        triggerImmediatePost(character.id);
    };

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
    }, [isCharacter, character, userSignature]);

    const isLongBio = bioText.length > 84 || bioText.split("\n").length > 2;
    const effectiveCoverUrl = isCharacter ? charCoverUrl : userCoverUrl;

    return (
        <PageShell
            title={displayName}
            onBack={onBack}
            className={`moments-feed-page moments-profile-page absolute inset-0 z-30 ${headerScrolled ? "is-scrolled" : ""}`}
            bodyRef={scrollRef}
        >
            {/* Cover + Profile Header */}
            <div className="feed-cover-shell w-full relative mb-2">
                <div
                    onClick={isCharacter ? () => coverInputRef.current?.click() : undefined}
                    className={`feed-cover-bg absolute inset-0 w-full h-full bg-[var(--c-input)] z-0 ${isCharacter ? "cursor-pointer" : ""}`}
                    style={{
                        maskImage: "linear-gradient(to bottom, black 42%, transparent 100%)",
                        WebkitMaskImage: "linear-gradient(to bottom, black 42%, transparent 100%)",
                    }}
                >
                    {effectiveCoverUrl ? (
                        <img
                            src={effectiveCoverUrl}
                            alt=""
                            className="feed-cover-image w-full h-full object-cover"
                        />
                    ) : avatarUrl ? (
                        <img
                            src={avatarUrl}
                            alt=""
                            className="feed-profile-cover-fallback w-full h-full object-cover"
                        />
                    ) : null}
                </div>

                {isCharacter && (
                    <input
                        ref={coverInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleCoverUpload}
                        className="hidden"
                    />
                )}

                <div
                    className="feed-profile relative w-full px-5 pb-4 pointer-events-none"
                    style={{ paddingTop: "calc(var(--page-header-safe-top, 48px) + var(--page-header-content-height, 54px) + 128px)" }}
                >
                    {/* Avatar */}
                    <div className="feed-profile-avatar w-[72px] h-[72px] rounded-full border-[3px] border-[var(--c-page-body-bg)] bg-[var(--c-input)] overflow-hidden flex items-center justify-center translate-x-[2px] pointer-events-auto">
                        {avatarUrl ? (
                            <img src={avatarUrl} alt={displayName} className="feed-profile-avatar-image w-full h-full object-cover" />
                        ) : (
                            <img src={DEFAULT_MOMENT_AVATAR_SRC} alt={displayName} className="feed-default-avatar w-full h-full object-cover" />
                        )}
                    </div>

                    {/* Name, ID, Tags, Stats, Bio */}
                    <div className="feed-profile-info flex flex-col gap-1.5 mt-3 ml-[6px] pointer-events-auto">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="feed-profile-name ts-20 font-bold text-[var(--c-text-title)]">{displayName}</span>
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

                        {/* Real stats computed from posts */}
                        <div className="feed-profile-stats flex gap-4 ts-13 text-[var(--c-icon)] font-medium mt-0.5">
                            <span className="feed-profile-stat">
                                <strong className="feed-profile-stat-value text-[var(--c-text-title)]">{stats.total}</strong> 动态
                            </span>
                            <span className="feed-profile-stat">
                                <strong className="feed-profile-stat-value text-[var(--c-text-title)]">{stats.likes}</strong> 获赞
                            </span>
                            <span className="feed-profile-stat">
                                <strong className="feed-profile-stat-value text-[var(--c-text-title)]">{stats.comments}</strong> 评论
                            </span>
                        </div>

                        {/* Bio / Persona */}
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

                        {/* Character quick actions */}
                        {isCharacter && character && (
                            <div className="feed-profile-actions flex items-center gap-2.5 mt-2">
                                <button
                                    type="button"
                                    className="feed-profile-action-btn feed-profile-action-primary"
                                    onClick={handleOpenChat}
                                >
                                    <MessageCircle size={15} strokeWidth={1.9} />
                                    <span>发消息</span>
                                </button>
                                <button
                                    type="button"
                                    className="feed-profile-action-btn"
                                    disabled={generatingMoment}
                                    onClick={handleGenerateMoment}
                                >
                                    <Sparkles size={15} strokeWidth={1.9} />
                                    <span>{generatingMoment ? "生成中…" : "让TA发动态"}</span>
                                </button>
                            </div>
                        )}

                        {generateHint && (
                            <div className="ts-12 text-[var(--c-icon-active)] mt-1">{generateHint}</div>
                        )}
                    </div>
                </div>
            </div>

            {/* Filter & Search Bar */}
            {authorPosts.length > 0 && (
                <div className="feed-profile-toolbar px-4 pb-3 flex flex-col gap-2.5">
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            className={`feed-profile-filter-pill ${filterMode === "all" ? "is-active" : ""}`}
                            onClick={() => {
                                setFilterMode("all");
                                setVisibleCount(PROFILE_INITIAL_POST_COUNT);
                            }}
                        >
                            全部动态 ({stats.total})
                        </button>
                        <button
                            type="button"
                            className={`feed-profile-filter-pill ${filterMode === "media" ? "is-active" : ""}`}
                            onClick={() => {
                                setFilterMode("media");
                                setVisibleCount(PROFILE_INITIAL_POST_COUNT);
                            }}
                        >
                            <ImageIcon size={13} strokeWidth={1.8} />
                            <span>带图 ({stats.media})</span>
                        </button>
                    </div>

                    {authorPosts.length >= 3 && (
                        <div className="feed-profile-search">
                            <Search size={15} strokeWidth={1.8} className="text-[var(--c-icon)] shrink-0" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={e => {
                                    setSearchQuery(e.target.value);
                                    setVisibleCount(PROFILE_INITIAL_POST_COUNT);
                                }}
                                placeholder={`搜索${isCharacter ? "TA" : "我"}发过的动态或地点…`}
                                className="feed-profile-search-input"
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    aria-label="清空搜索"
                                    onClick={() => setSearchQuery("")}
                                    className="feed-profile-search-clear"
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Posts List */}
            {filteredPosts.length === 0 ? (
                <div className="feed-empty-state py-12 px-6 text-center text-[var(--c-icon)] ts-14">
                    {authorPosts.length === 0
                        ? (isCharacter ? "TA 还没有发过朋友圈动态" : "你还没有发过朋友圈动态")
                        : "没有符合当前筛选条件的动态"}
                </div>
            ) : (
                visiblePosts.map(post => (
                    <MomentPostCard
                        key={post.id}
                        post={post}
                        onUpdate={onUpdate}
                        onRequestDelete={onRequestDelete}
                        onOpenCommentComposer={onOpenCommentComposer}
                        onOpenReplyComposer={onOpenReplyComposer}
                        onSelectAuthor={onSelectAuthor}
                    />
                ))
            )}

            {hasMorePosts && (
                <div className="feed-load-more-row flex justify-center px-4 pt-3 pb-8">
                    <button
                        type="button"
                        className="chat-sys-msg chat-load-more-button"
                        onClick={() => setVisibleCount(c => Math.min(c + PROFILE_LOAD_MORE_COUNT, filteredPosts.length))}
                    >
                        <span>查看更多动态</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="18 15 12 9 6 15" />
                        </svg>
                    </button>
                </div>
            )}
        </PageShell>
    );
}
