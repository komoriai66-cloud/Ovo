// 动态默认可用；全局节奏与角色单项覆盖共用同一份有效设置。
(function () {
    'use strict';
    const defaults = {
        triggers: {timer:true,startup:false,resume:false,chat:true,background:true,chatPrep:false,userPost:true,userComment:true,aiComment:true,view:true,friendRetry:false},
        schedule: {intervalMs:3600000},
        actions: {post:true,story:true,browse:true,interact:true,rename:true,delete:true},
        publish: {intervalMs:3600000},
        discussion: {perActor:1,delayMs:0,delayMaxMs:0,maxRounds:3,repeat:false,self:false,reopen:true,reset:true,stopOnSilence:true},
        requests: {concurrency:3,retries:0,postContent:true,image:true,voice:true},
    };
    const presets = {
        light: { label: '轻度', postIntervalMs: 4 * 3600000, replyDelayMs: 3 * 60000, npcReplyDelayMs: 5 * 60000, conversationRounds: 1 },
        medium: { label: '中度', postIntervalMs: 3600000, replyDelayMs: 60000, npcReplyDelayMs: 2 * 60000, conversationRounds: 3 },
        heavy: { label: '重度', postIntervalMs: 15 * 60000, replyDelayMs: 0, npcReplyDelayMs: 0, conversationRounds: 6 },
    };
    const preferenceDefaults = { preset: 'medium', ...presets.medium, postEnabled: true, storyEnabled: true, browseEnabled: true, watchEnabled: true, likeEnabled: true, commentEnabled: true, replyEnabled: true, contactsEnabled: true, chatLinked: true };
    const behaviorFields = [['postEnabled', '发动态'], ['storyEnabled', '发 Story'], ['watchEnabled', '发布后观看'], ['browseEnabled', '自主浏览'], ['likeEnabled', '点赞'], ['commentEnabled', '发表评论'], ['replyEnabled', '回复评论'], ['contactsEnabled', '人脉参与']];
    const tempoFields = [['postIntervalMs', '角色发动态', '分钟', 60000, 1, 240], ['replyDelayMs', '角色接话', '秒', 1000, 0, 300], ['npcReplyDelayMs', 'NPC 接话', '秒', 1000, 0, 300]];
    let adapter, timer, ticking = false, currentScope = 'global', returnScreen = 'moments-settings-screen';
    const running = new Map();
    const controllers = new Map();
    const requestTasks = new Map();
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const uid = () => 'moments_task_' + (globalThis.crypto?.randomUUID?.() || Date.now() + '_' + Math.random().toString(36).slice(2));
    const clone = value => JSON.parse(JSON.stringify(value));
    const el = id => document.getElementById(id);
    const say = message => { if (typeof showToast === 'function') showToast(message); };
    function data() {
        const m = adapter.ensure();
        if (!m.controls || typeof m.controls !== 'object') m.controls = {};
        const c = m.controls;
        c.global ||= {}; c.tasks ||= []; c.schedules ||= {}; c.requests ||= []; c.publications ||= [];
        if (!c.preferences) {
            const old = c.global;
            c.preferences = { ...preferenceDefaults };
            if (old.schedule?.intervalMs > 0) c.preferences.postIntervalMs = old.schedule.intervalMs;
            if (old.discussion?.delayMs >= 0) c.preferences.replyDelayMs = c.preferences.npcReplyDelayMs = old.discussion.delayMs;
            for (const [key, action] of [['postEnabled', 'post'], ['storyEnabled', 'story'], ['browseEnabled', 'browse']]) if (old.actions?.[action] === false) c.preferences[key] = false;
            if (old.actions?.interact === false) for (const key of ['likeEnabled','commentEnabled','replyEnabled']) c.preferences[key] = false;
            if (Object.keys(old).length) c.preferences.preset = 'custom';
            // 旧的调用权限、组合规则、限额不再左右新的简单设置。
            c.global={};c.schedules={};delete c.pairs;delete c.paused;
            for(const post of adapter.ensure().posts){delete post.controlOverrides;delete post.controlsPaused;for(const thread of Object.values(post.discussions||{})){delete thread.controlOverrides;delete thread.paused;}}
        }
        return c;
    }
    function holder(actorId) {
        const char = adapter.character(actorId);
        if (char) return char.momentsSettings ||= {};
        return adapter.ensure().contacts.find(c => c.actorId === actorId && c.kind === 'npc') || null;
    }
    function actors() { return adapter.actors().filter(actorId => holder(actorId)); }
    function root(post, comment) {
        const visited = new Set();
        while (comment?.replyTo && !visited.has(comment.id)) {
            visited.add(comment.id);
            const parent = post.comments?.find(c => c.id === comment.replyTo);
            if (!parent) break;
            comment = parent;
        }
        return comment?.discussionId || comment?.id || '';
    }
    function thread(post, comment, create = false) {
        const rootId = typeof comment === 'string' ? comment : root(post, comment);
        if (!rootId) return null;
        if (create) {
            post.discussions ||= {};
            if (!post.discussions[rootId]) {
                const existing = (post.comments || []).filter(c => !c.deletedAt && c.authorId !== 'user' && root(post, c) === rootId);
                post.discussions[rootId] = { id: rootId, startedAt: post.comments?.find(c => c.id === rootId)?.createdAt || Date.now(), rounds: 0, comments: existing.length, countedCommentIds: existing.map(c => c.id), silenceRetries: 0 };
            }
        }
        return post.discussions?.[rootId] || null;
    }
    function localPreferences(actorId) {
        const h = holder(actorId);
        if (!h) return {};
        if (!h.preferences) {
            h.preferences = {};
            const npc = !adapter.character(actorId), old = h.controls || {};
            for (const [key] of behaviorFields) {
                const legacy = npc ? ({ postEnabled: 'mayPost', storyEnabled: 'mayStory', browseEnabled: 'mayInteract', likeEnabled: 'mayInteract', commentEnabled: 'mayInteract', replyEnabled: 'mayInteract' })[key] : ({ likeEnabled: 'interactEnabled', commentEnabled: 'interactEnabled', replyEnabled: 'interactEnabled' })[key] || key;
                if (legacy && typeof h[legacy] === 'boolean') h.preferences[key] = h[legacy];
            }
            if (old.schedule?.intervalMs > 0) h.preferences.postIntervalMs = old.schedule.intervalMs;
            if (old.discussion?.delayMs >= 0) h.preferences[npc ? 'npcReplyDelayMs' : 'replyDelayMs'] = old.discussion.delayMs;
            delete h.controls; delete h.controlInheritance; delete h.controlsPaused;
        }
        return h.preferences;
    }
    function preferences(actorId = '') { return adapter ? { ...preferenceDefaults, ...data().preferences, ...(actorId ? localPreferences(actorId) : {}) } : { ...preferenceDefaults }; }
    function settings(actorId = '', post = null, discussion = null) {
        const base = clone(defaults), p = preferences(actorId), npc = actorId && !adapter.character(actorId);
        base.triggers.timer = p.postEnabled || p.storyEnabled || p.browseEnabled;
        base.triggers.userPost = base.triggers.view = p.watchEnabled;
        base.schedule.intervalMs = p.postIntervalMs;
        base.actions.post = p.postEnabled; base.actions.story = p.storyEnabled; base.actions.browse = p.browseEnabled;
        base.actions.like = p.likeEnabled; base.actions.comment = p.commentEnabled; base.actions.reply = p.replyEnabled;
        base.actions.interact = p.likeEnabled || p.commentEnabled || p.replyEnabled;
        base.publish.intervalMs = p.postIntervalMs;
        base.discussion.delayMs = base.discussion.delayMaxMs = npc ? p.npcReplyDelayMs : p.replyDelayMs;
        base.discussion.maxRounds = p.conversationRounds;
        base.discussion.self = false; base.discussion.reset = true;
        base.requests.concurrency = 3;
        return base;
    }
    function inWindow() { return true; }
    function interval(s) { return s.intervalMs; }
    function capacity(actorId='') { return settings(actorId).requests.concurrency; }
    function nextDue(s,from=Date.now()) { return from+s.intervalMs; }
    function newSchedule(s,from=Date.now()) { return {lanes:{fixed:nextDue(s,from)},nextAt:nextDue(s,from)}; }
    function allowed(actorId, source, post = null, discussion = null) {
        if (data().paused || holder(actorId)?.controlsPaused || post?.controlsPaused || discussion?.paused) return false;
        const h = holder(actorId);
        if (!h) return false;
        if (source === 'manual' || source === 'regenerate') return true;
        if (source !== 'friendRetry' && !adapter.character(actorId) && (h.enabled === false || !((db.characters||[]).find(c=>c.id===h.ownerCharId)&&preferences(adapter.actors().find(a=>adapter.character(a)?.id===h.ownerCharId)).contactsEnabled))) return false;
        const s = settings(actorId, post, discussion);
        return s.triggers[source] === true && inWindow(s.schedule);
    }
    function candidates(post, comment, candidateIds, source='userComment', task=null) {
        const t=thread(post,comment,true), target=post.comments?.find(c=>c.id===comment.replyTo);
        return candidateIds.filter(actorId=>{
            const c=settings(actorId), round=task?.round||(source==='userComment'?1:(comment.generationRound||1)+1);
            if((post.comments||[]).some(reply=>!reply.deletedAt&&reply.authorId===actorId&&root(post,reply)===t.id&&(reply.discussionGeneration||0)===(t.generation||0)&&(reply.generationRound||0)>=round))return false;
            if(!allowed(actorId,source,post,t)||!c.actions.reply||comment.authorId===actorId)return false;
            if(t.closed&&source!=='userComment')return false;
            if(c.discussion.maxRounds&&(task?.round?task.round>c.discussion.maxRounds:source==='aiComment'&&(comment.generationRound||1)>=c.discussion.maxRounds))return false;
            return !(post.comments||[]).some(reply=>!reply.deletedAt&&reply.replyTo===comment.id&&reply.authorId===actorId);
        }).sort((a,b)=>Number(b===target?.authorId||comment.mentions?.includes(b))-Number(a===target?.authorId||comment.mentions?.includes(a)));
    }
    function commentBlockReason(post,actorId,replyTo='',task=null) {
        if(actorId==='user')return '';
        const c=settings(actorId), parent=post.comments?.find(comment=>comment.id===replyTo), t=parent&&thread(post,parent,true);
        if(!(replyTo?c.actions.reply:c.actions.comment))return replyTo?'此对象设置为不回复评论':'此对象设置为不发表评论';
        if(!valid(task)||post.controlsPaused||holder(actorId)?.controlsPaused||t?.paused)return '动态或设置已变化，互动已停止';
        if(post.authorId===actorId&&!replyTo)return '不自动在自己的动态下重复自言自语';
        if(task?.source==='regenerate')return '';
        const own=(post.comments||[]).filter(comment=>comment.authorId===actorId&&!comment.deletedAt);
        if(parent&&own.some(comment=>comment.replyTo===parent.id&&(!task||comment.generationTaskId!==task.id)))return '已回复过这条评论';
        if(task&&own.some(comment=>comment.generationTaskId===task.id))return '本轮已经发表过评论';
        if(t?.closed&&task?.source!=='userComment')return '这段讨论已自然结束';
        return '';
    }
    function commentAllowed(post,actorId,replyTo='',task=null) {return !commentBlockReason(post,actorId,replyTo,task);}
    function publicationAllowed(actorId,kind,task=null) {
        if(!valid(task))return false;
        if(task?.source==='manual')return true;
        const gap=preferences(actorId).postIntervalMs;
        return ![...data().publications,...adapter.ensure().activityEvents.filter(e=>['post','story'].includes(e.type))].some(e=>e.actorId===actorId&&Date.now()-e.createdAt<gap);
    }
    function published(post) { data().publications.push({ postId: post.id, actorId: post.authorId, kind: post.kind, createdAt: post.createdAt }); }
    function valid(task) {
        if (!task) return true;
        const stored = data().tasks.find(t => t.id === task.id);
        if (stored && ['cancelled', 'paused', 'interrupted'].includes(stored.status)) return false;
        if (task.postId) {
            const post = adapter.post(task.postId), comment = post?.comments?.find(c => c.id === task.commentId);
            if (!post || post.controlsPaused || (post.kind==='story' && post.expiresAt<=Date.now()) || task.actorIds?.some(a=>adapter.visibleTo && !adapter.visibleTo(post,a)) || task.commentId && (!comment || comment.deletedAt || (comment.revision || 0) !== task.revision)) return false;
            if ((post.revision || 0) !== (task.postRevision || 0)) return false;
            const t = task.rootId && thread(post, task.rootId);
            if (t?.paused || task.discussionGeneration!==undefined && task.discussionGeneration!==(t?.generation||0)) return false;
            const rootComment = task.rootId && post.comments?.find(c => c.id === task.rootId);
            if (rootComment && (rootComment.deletedAt || (rootComment.revision || 0) !== (task.rootRevision || 0))) return false;
        }
        return !data().paused && !task.actorIds?.some(a => !holder(a) || !allowed(a, task.source, task.postId ? adapter.post(task.postId) : null, task.rootId ? adapter.post(task.postId)?.discussions?.[task.rootId] : null));
    }
    async function request(actorId, task) {
        if (!task) return; // 原有手动生成人脉、头像、申请等独立能力保持原路径。
        if (!valid(task)) throw new Error('动态任务已暂停、取消或内容已变化');
        const ids=actorId?[actorId]:task.actorIds||[],now=Date.now(),c=data();
        const entry = { id: uid(), actorIds: ids, taskId: task.id, source: task.source, postId: task.postId || '', rootId: task.rootId || '', createdAt: now };
        if (!c.tasks.some(t => t.id === task.id)) { task.direct = true; task.status = 'running'; task.createdAt = now; task.dueAt = now; c.tasks.push(task); }
        const tracked = c.tasks.find(t => t.id === task.id);
        c.requests.push(entry); tracked.requestCount = (tracked.requestCount || 0) + 1; task.requestCount = tracked.requestCount;
        if (!await adapter.persist()) { c.requests.splice(c.requests.indexOf(entry), 1); tracked.requestCount--; throw new Error('调用记录保存失败，未发送请求'); }
        renderTasks();
    }
    function chatAllowed(actorId, background = false) { return allowed(actorId, background ? 'background' : 'chat'); }
    function context(source, actorIds, post = null, comment = null) {
        const rootId = post && comment ? root(post, comment) : '';
        return { id: uid(), source, actorIds, postId: post?.id || '', postRevision: post?.revision || 0, commentId: comment?.id || '', rootId, rootRevision: post?.comments?.find(c => c.id === rootId)?.revision || 0, revision: comment?.revision || 0 };
    }
    function requestOptions(actorId, task) {
        if (!task) return null;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const set = controllers.get(task.id) || new Set(); if (controller) set.add(controller); controllers.set(task.id, set);
        requestTasks.set(task.id, task);
        return { signal: controller?.signal, isAllowed: () => valid(task), beforeRequest: () => request(actorId, task), release: error => {
            if (controller) set.delete(controller);
            if (!set.size) { controllers.delete(task.id); requestTasks.delete(task.id); }
            const tracked = data().tasks.find(t => t.id === task.id) || task;
            if (tracked.direct && !['cancelled','paused'].includes(tracked.status)) { tracked.status = error ? 'failed' : 'done'; tracked.message = error?.message || '本次请求结束'; tracked.finishedAt = Date.now(); void adapter.persist(); renderTasks(); }
        } };
    }
    function abortTask(task) { for (const controller of controllers.get(task.id) || []) controller.abort(); }
    async function enqueue(task) {
        const c = data();
        if (c.tasks.some(t => t.key === task.key && !['cancelled', 'failed', 'interrupted'].includes(t.status))) return false;
        const queued={...task,status:'waiting',createdAt:Date.now(),requestCount:0};c.tasks.push(queued);
        if(!await adapter.persist()){c.tasks.splice(c.tasks.indexOf(queued),1);say('动态任务保存失败');return false;}
        arm(); renderTasks(); return true;
    }
    async function commentEvents(post, comments, origin = null) {
        for (const comment of comments.filter(c => c && !c.deletedAt)) {
            const source = comment.authorId === 'user' ? 'userComment' : 'aiComment';
            const t = thread(post, comment, true);
            if (source === 'userComment') {
                const s = settings('', post, t).discussion;
                if (s.reopen && t.closed) { t.closed = false; t.closedReason = ''; }
                if (s.reset) { t.generation=(t.generation||0)+1; t.rounds = 0; t.comments = 0; t.startedAt = Date.now(); }
            } else {
                t.countedCommentIds ||= [];
                if (!t.countedCommentIds.includes(comment.id)) { t.comments++; t.countedCommentIds.push(comment.id); }
            }
            const ids = candidates(post, comment, adapter.replyCandidates(post), source);
            if (!ids.length) continue;
            // Independent pacing: a slow NPC must not delay a role's immediate reply.
            for(const actorId of ids){const task=context(source,[actorId],post,comment);const round=source==='userComment'?1:(comment.generationRound||origin?.round||1)+1;await enqueue({...task,type:'reply',round,discussionGeneration:t.generation||0,dueAt:Date.now()+settings(actorId).discussion.delayMs,key:source+':'+post.id+':'+comment.id+':'+task.revision+':'+actorId,parentTaskId:origin?.id||''});}
        }
        if (origin) origin.pendingComments = 0;
        await adapter.persist();
    }
    async function postEvent(post, options = {}) {
        for (const actorId of adapter.eventCandidates(post).filter(a=>!options.actorIds || options.actorIds.includes(a))) {
            const source = post.reminderIds?.includes(actorId) ? 'view' : 'userPost';
            const existing = data().tasks.find(t => t.type === 'view' && t.postId === post.id && (t.postRevision||0)===(post.revision||0) && t.actorIds.includes(actorId) && !['failed','cancelled','interrupted'].includes(t.status));
            if (existing || post.seenBy?.[actorId] && !options.reminderIds?.includes(actorId)) continue;
            if (!allowed(actorId, source, post)) { adapter.viewStatus?.(post.id, actorId, 'blocked', '未观看：此对象关闭了观看或人脉参与', null); continue; }
            const task = { ...context(source, [actorId], post), type: 'view', key: 'view:' + post.id + ':' + (post.revision||0) + ':' + actorId, dueAt: Date.now() };
            adapter.viewStatus?.(post.id, actorId, 'waiting', '等待观看', task);
            try { if (!await enqueue(task)) adapter.viewStatus?.(post.id, actorId, 'error', '观看任务保存失败', task); }
            catch (error) { adapter.viewStatus?.(post.id, actorId, 'error', '观看任务安排失败：' + error.message, task); }
        }
        await adapter.persist();
        await tick();
    }
    async function execute(task) {
        const post = task.postId && adapter.post(task.postId), comment = post?.comments?.find(c => c.id === task.commentId), t = post && task.rootId && thread(post, task.rootId);
        if (!valid(task)) { task.status = 'cancelled'; task.message = '对象、动态或评论已变化，或调用已暂停'; if(task.type==='view')adapter.viewStatus?.(task.postId,task.actorIds[0],'cancelled',task.message,task); await adapter.persist(); renderTasks(); return; }
        task.actorIds = task.actorIds.filter(a => allowed(a, task.source, post, t));
        if (task.type === 'reply') task.actorIds = candidates(post, comment, task.actorIds, task.source, task);
        if (!task.actorIds.length) { task.status = 'cancelled'; task.message = '当前设置不允许调用或讨论已达到限制'; await adapter.persist(); renderTasks(); return; }
        task.status = 'running'; task.startedAt = Date.now(); running.set(task.id, task); await adapter.persist(); renderTasks();
        try {
            if (task.type === 'reply') {
                task.round ||= 1; t.rounds = Math.max(t.rounds, task.round);
                const count = post.comments.length;
                await adapter.replies(post.id, comment.id, task);
                if (!valid(task)) return;
                const s = settings(task.actorIds[0], post, t).discussion;
                if(post.comments.length===count&&s.stopOnSilence&&!data().tasks.some(other=>other!==task&&other.rootId===task.rootId&&['waiting','running'].includes(other.status))){t.closed=true;t.closedReason='本轮无人继续接话';}
            } else if (task.type === 'view') await adapter.view(post.id, task.actorIds[0], task);
            else if (task.type === 'friend') await adapter.friend(task.requestId, task);
            else if (task.type === 'post' || task.type === 'story') {
                if (!await adapter.generate(task.actorIds[0], task.type, task)) task.message = '未发布：请查看能力开关、发布限制或 API 返回';
            } else await adapter.activity(task.actorIds[0], task);
            if (valid(task)) { task.status = 'done'; task.message ||= '本次调用已结束，行动由 AI 决定'; }
        } catch (error) {
            task.message = error.message || String(error);
            if(task.type==='view')adapter.viewStatus?.(task.postId,task.actorIds[0],'error','观看失败：'+task.message,task);
            task.status=valid(task)?'failed':'cancelled';
        } finally {
            if(task.status==='running'&&!valid(task)){task.status='cancelled';task.message='动态或设置已变化，本次操作已停止';}
            running.delete(task.id); task.finishedAt = Date.now(); await adapter.persist(); renderTasks();
        }
    }
    async function tick() {
        if (ticking) return;
        ticking = true;
        try {
            const c = data(), now = Date.now();
            for (const actorId of actors()) {
                const s = settings(actorId);
                if (!s.triggers.timer) { delete c.schedules[actorId]; continue; }
                if (c.paused || holder(actorId).controlsPaused) continue;
                const schedule = c.schedules[actorId] ||= newSchedule(s.schedule, now);
                if(schedule.nextAt<=now){
                    await enqueue({...context('timer',[actorId]),type:'activity',key:'timer:'+actorId+':'+schedule.nextAt,dueAt:now});
                    c.schedules[actorId]=newSchedule(s.schedule,now);await adapter.persist();
                }
            }
            const concurrency = capacity();
            const due = c.tasks.filter(t => t.status === 'waiting' && t.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
            for (const task of due) {
                if (c.paused || running.size >= concurrency) break;
                if (task.actorIds.some(a => holder(a)?.controlsPaused || [...running.values()].filter(t => t.actorIds.includes(a)).length >= capacity(a)) || task.rootId && [...running.values()].some(t => t.postId === task.postId && t.rootId === task.rootId)) continue;
                void execute(task).finally(arm);
            }
        } finally { ticking = false; arm(); }
    }
    function arm() {
        if (!adapter || typeof setTimeout !== 'function') return;
        if (timer) clearTimeout(timer);
        const c = data(); if (c.paused) return;
        const available = running.size < capacity();
        const times = [...c.tasks.filter(t => available && t.status === 'waiting' && !t.actorIds.some(a => holder(a)?.controlsPaused || [...running.values()].filter(r => r.actorIds.includes(a)).length >= capacity(a)) && !(t.rootId && [...running.values()].some(r => r.postId === t.postId && r.rootId === t.rootId))).map(t => t.dueAt), ...Object.entries(c.schedules).filter(([a]) => holder(a) && !holder(a).controlsPaused && settings(a).triggers.timer).map(([,s]) => s.nextAt)];
        if (times.length) timer = setTimeout(() => { void tick(); }, Math.max(0, Math.min(2147483647, Math.min(...times) - Date.now())));
    }
    async function wake() {
        const c=data(),now=Date.now();
        for(const task of c.tasks){
            if(task.status==='running'&&!running.has(task.id)){task.status='interrupted';task.message='页面中断；未自动重复请求';if(task.type==='view')adapter.viewStatus?.(task.postId,task.actorIds[0],'error','观看中断：页面关闭或刷新',task);}
            if(task.status==='waiting'&&task.dueAt<now)task.dueAt=now;
        }
        for(const actorId of actors()){
            const s=settings(actorId);
            if(s.triggers.timer&&!c.schedules[actorId])c.schedules[actorId]=newSchedule(s.schedule,now);
            if(c.schedules[actorId]?.nextAt<now){await enqueue({...context('timer',[actorId]),type:'activity',key:'resume:'+actorId+':'+c.schedules[actorId].nextAt,dueAt:now});c.schedules[actorId]=newSchedule(s.schedule,now);}
        }
        await adapter.persist();await tick();
    }
    function durationText(ms) { return ms === 0 ? '立即' : ms % 60000 === 0 ? (ms / 60000) + ' 分钟' : (ms / 1000) + ' 秒'; }
    function scopeName(scope) { return scope === 'global' ? '全局默认' : adapter.person(scope)?.name || '已删除对象'; }
    function visibleTempoFields(prefix){return prefix==='moments-role-tempo'?tempoFields.slice(0,2):currentScope==='global'?tempoFields:tempoFields.filter(([key])=>key!=='replyDelayMs');}
    function tempoHtml(values, local = null, prefix = 'moments-tempo') {
        return `<div class="moments-preset-row">${local ? '<label class="moments-field">活跃程度<select data-tempo-preset="'+prefix+'"><option value="inherit">跟随全局</option><option value="light">轻度</option><option value="medium">中度</option><option value="heavy">重度</option><option value="custom">自定义</option></select></label>' : '<label class="moments-field">活跃程度<select data-tempo-preset="'+prefix+'"><option value="light">轻度</option><option value="medium">中度</option><option value="heavy">重度</option><option value="custom">自定义</option></select></label>'}</div>` + visibleTempoFields(prefix).map(([key,originalLabel,unit,size,min,max]) => {
            let label=originalLabel;
            if(local && currentScope!=='global' && prefix==='moments-tempo' && key==='postIntervalMs')label='NPC 发动态';
            const own = !local || Object.hasOwn(local,key), value = values[key] / size;
            return `<div class="moments-tempo-item"><label class="moments-field">${label}${local ? `<select id="${prefix}-${key}-mode" data-tempo-mode="${prefix}-${key}"><option value="inherit" ${!own?'selected':''}>跟随全局 · ${durationText(preferences()[key])}</option><option value="custom" ${own?'selected':''}>单独设置</option></select>` : ''}</label><div class="moments-tempo-value"><input id="${prefix}-${key}" type="number" min="0" step="any" value="${value}" data-tempo-number="${prefix}-${key}" ${own?'':'disabled'}><span>${unit}${key==='postIntervalMs'?' / 次检查':'后接话（0 为立即）'}</span></div><input id="${prefix}-${key}-slider" class="moments-tempo-slider" type="range" min="${min}" max="${max}" step="1" value="${Math.min(max,value)}" data-tempo-slider="${prefix}-${key}" ${own?'':'disabled'}></div>`;
        }).join('') + `<p class="moments-hint">发布后直接安排观看，提醒也会立即安排观看。发帖按节奏检查，由角色决定是否分享；接话节奏作用于新评论，不推迟首次观看。滑块外的时间也可直接输入。</p><p class="moments-hint" data-tempo-summary="${prefix}"></p>`;
    }
    function tempoContainer(prefix) { return el(prefix === 'moments-tempo' ? 'moments-controls-form' : 'setting-moments-tempo'); }
    function updateTempoSummary(prefix) {
        const node = tempoContainer(prefix); if (!node) return;
        const preset = node.querySelector('[data-tempo-preset]');
        const selected = presets[preset?.value];
        const rounds=selected?.conversationRounds||(preset?.value==='inherit'?preferences().conversationRounds:Number(node.dataset.tempoRounds));
        const text = node.querySelector('[data-tempo-summary]');
        if (text) text.textContent = `连续接话最多 ${rounds} 轮，没人想接话就自然停止；用户的新评论可以继续聊。`;
    }
    function bindTempo(prefix, values) {
        const node = tempoContainer(prefix); if (!node) return;
        const select = node.querySelector('[data-tempo-preset]');
        node.dataset.tempoRounds=String(values.conversationRounds);
        const local=prefix==='moments-role-tempo'?localPreferences(node.dataset.actorId):currentScope==='global'?null:localPreferences(currentScope);
        node.dataset.tempoRoundOverride=String(!!local&&Object.hasOwn(local,'conversationRounds'));
        if (select) select.value = values.preset || 'custom';
        node.oninput = event => {
            const target = event.target, id = target.dataset.tempoSlider || target.dataset.tempoNumber;
            if (!id) return;
            const number = el(id), slider = el(id+'-slider');
            if (target.dataset.tempoSlider) number.value = target.value;
            else slider.value = Math.min(Number(slider.max || 300), Number(number.value));
            if (select) select.value = 'custom';
            updateTempoSummary(prefix);
        };
        node.onchange = event => {
            const target = event.target;
            if (target.dataset.tempoMode) {
                const id=target.dataset.tempoMode;
                if(target.value==='inherit'){const field=tempoFields.find(([key])=>id===prefix+'-'+key);el(id).value=preferences()[field[0]]/field[3];el(id+'-slider').value=el(id).value;}
                el(id).disabled=el(id+'-slider').disabled=target.value==='inherit'; if(select)select.value='custom';
            }
            if (target.dataset.tempoPreset) {
                const chosen=presets[target.value];
                if(chosen){node.dataset.tempoRounds=String(chosen.conversationRounds);node.dataset.tempoRoundOverride='true';}
                else if(target.value==='inherit'){node.dataset.tempoRounds=String(preferences().conversationRounds);node.dataset.tempoRoundOverride='false';}
                for (const [key,, ,size] of visibleTempoFields(prefix)) {
                    const id=prefix+'-'+key, mode=el(id+'-mode');
                    if(mode)mode.value=chosen?'custom':target.value==='inherit'?'inherit':mode.value;
                    if(chosen){el(id).value=chosen[key]/size;el(id+'-slider').value=chosen[key]/size;}
                    else if(target.value==='inherit'){el(id).value=preferences()[key]/size;el(id+'-slider').value=el(id).value;}
                    el(id).disabled=el(id+'-slider').disabled=!!mode&&mode.value==='inherit';
                }
            }
            updateTempoSummary(prefix);
        };
        updateTempoSummary(prefix);
    }
    function readTempo(prefix, local = false) {
        const node=tempoContainer(prefix);if(!node?.querySelector('[data-tempo-preset]'))return {};
        const selected=node?.querySelector('[data-tempo-preset]')?.value || 'custom';
        const result={};
        if (!local || selected !== 'inherit') { result.preset=selected; if(presets[selected])result.conversationRounds=presets[selected].conversationRounds; else if(!local||node.dataset.tempoRoundOverride==='true')result.conversationRounds=Number(node.dataset.tempoRounds); }
        for(const [key,label,,size,min] of visibleTempoFields(prefix)){
            if(local && el(prefix+'-'+key+'-mode')?.value==='inherit')continue;
            const raw=el(prefix+'-'+key)?.value, value=Number(raw);
            if(raw===''||!Number.isFinite(value*size)||value*size>Number.MAX_SAFE_INTEGER||value<0||key==='postIntervalMs'&&value===0)throw new Error(label+'请填写'+(min?'大于 0':'不小于 0')+'的有效时间');
            result[key]=value*size;
        }
        return result;
    }
    function renderActorSettings(actorId) {
        const container=el('setting-moments-tempo');if(!container)return;
        const values=preferences(actorId), local=localPreferences(actorId);
        container.dataset.actorId=actorId;
        container.innerHTML=tempoHtml(values,local,'moments-role-tempo');
        bindTempo('moments-role-tempo',{...values,preset:local.preset || (tempoFields.some(([key])=>Object.hasOwn(local,key))?'custom':'inherit')});
    }
    function readActorSettings(actorId) {
        const local={...localPreferences(actorId)};
        for(const key of ['preset','postIntervalMs','replyDelayMs','npcReplyDelayMs','conversationRounds'])delete local[key];
        return {...local,...readTempo('moments-role-tempo',true)};
    }
    function open(scope='global', back='moments-settings-screen') {
        if(!adapter)return;
        currentScope=scope;returnScreen=back;
        const local=scope==='global'?null:localPreferences(scope), values=preferences(scope==='global'?'':scope);
        const behaviors=behaviorFields.filter(([key])=>scope==='global'||key!=='contactsEnabled').map(([key,label])=>`<label class="moments-field">${label}<select name="preference.${key}">${local?'<option value="inherit" '+(!Object.hasOwn(local,key)?'selected':'')+'>跟随全局</option>':''}<option value="on" ${(local?local[key]:values[key])===true?'selected':''}>允许</option><option value="off" ${(local?local[key]:values[key])===false?'selected':''}>${key==='watchEnabled'?'不观看':key==='contactsEnabled'?'不让人脉参与':'不'+label}</option></select></label>`).join('');
        const chatLink=scope==='global'?`<div class="moments-chat-link-setting"><span>聊天关联动态</span><label class="kkt-switch"><input type="checkbox" name="preference.chatLinked" aria-label="聊天关联动态" aria-describedby="moments-chat-link-hint" ${values.chatLinked!==false?'checked':''}><span class="kkt-slider"></span></label></div><p class="moments-hint" id="moments-chat-link-hint">关闭后，聊天不再自动注入动态内容与能力提示词；动态仍会参考聊天记录。</p>`:'';
        el('moments-controls-form').innerHTML=`<section class="moments-settings-card"><h2>${scope==='global'?'动态活跃度':esc(scopeName(scope))+'的动态'}</h2>${tempoHtml(values,local)}</section><section class="moments-settings-card"><h2>${scope==='global'?'默认参与方式':'参与方式'}</h2><div class="moments-behavior-grid">${behaviors}</div><p class="moments-hint">角色的单独设置在聊天设置里修改；未单独设置的项目跟随这里。</p>${chatLink}</section><div class="moments-inline-actions"><button type="submit" class="moments-primary-btn">保存</button><button type="button" data-control-action="back">返回</button></div>`;
        bindTempo('moments-tempo',{...values,preset:local?(local.preset||'inherit'):values.preset});
        el('moments-controls-title').textContent=scope==='global'?'全局动态设置':scopeName(scope)+'的动态';
        el('moments-controls-pause').hidden=true;
        el('moments-controls-manual').innerHTML='';
        renderTasks();switchScreen('moments-controls-screen');
    }
    async function persistScope(scope) {const char=adapter.character(scope);return char?saveCharacter(char.id):adapter.persist();}
    function inScope(task,scope) {return scope==='global'||task.actorIds.includes(scope);}
    async function reschedule(scope='global') {
        for(const actorId of actors())if(scope==='global'||scope===actorId){const s=settings(actorId);if(s.triggers.timer)data().schedules[actorId]=newSchedule(s.schedule);else delete data().schedules[actorId];}
        arm();await adapter.persist();
    }
    async function save(event) {
        event.preventDefault();
        const local=currentScope!=='global', previous=clone(local?localPreferences(currentScope):data().preferences);
        try{
            const next=readTempo('moments-tempo',local), form=el('moments-controls-form');
            for(const [key] of behaviorFields){const v=form.elements['preference.'+key]?.value;if(v==='on'||v==='off')next[key]=v==='on';}
            if(!local)next.chatLinked=form.elements['preference.chatLinked'].checked;
            else if(Object.hasOwn(previous,'chatLinked'))next.chatLinked=previous.chatLinked;
            if(local)holder(currentScope).preferences=next;else data().preferences={...preferenceDefaults,...next};
            if(!await persistScope(currentScope))throw new Error('设置保存失败');
            await reschedule(currentScope);say('动态设置已保存');switchScreen(returnScreen);
        }catch(error){if(local)holder(currentScope).preferences=previous;else data().preferences=previous;say(error.message||'保存失败');}
    }
    function renderTasks() {
        const node=el('moments-controls-tasks');if(!node||!adapter)return;
        const failed=data().tasks.filter(t=>inScope(t,currentScope)&&['failed','interrupted'].includes(t.status)).slice(-10).reverse();
        node.innerHTML=failed.length?`<details class="moments-settings-card"><summary>最近未完成的动态操作（${failed.length}）</summary>${failed.map(t=>`<p class="moments-hint">${esc(t.actorIds.map(scopeName).join('、'))}：${esc(t.message||'操作中断')}</p>`).join('')}</details>`:'';
    }
    async function pauseScope(scope) {
        if(scope==='global')data().paused=!data().paused;else if(holder(scope))holder(scope).controlsPaused=!holder(scope).controlsPaused;
        for(const task of running.values())if(inScope(task,scope)){task.status='cancelled';abortTask(task);}
        await persistScope(scope);await adapter.persist();arm();
    }
    function init(a) {
        adapter=a;data();
        el('moments-controls-form')?.addEventListener('submit',save);
        el('moments-controls-screen')?.addEventListener('click',event=>{if(event.target.closest('[data-control-action="back"]'))switchScreen(returnScreen);});
        el('moments-controls-back')?.addEventListener('click',()=>switchScreen(returnScreen));
        if(typeof document.addEventListener==='function')document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void wake('resume').catch(error=>console.error('动态恢复失败',error));});
        void wake('startup',true).catch(error=>console.error('动态调度恢复失败',error));
    }
    window.MomentsControls={init,open,settings,preferences,localPreferences,renderActorSettings,readActorSettings,reschedule,allowed,candidates,commentAllowed,publicationAllowed,published,valid,request,requestOptions,chatAllowed,context,commentEvents,postEvent,pauseScope,thread,root,enqueue,tick,commentBlockReason};
})();
