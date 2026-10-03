import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const dataSource = read('js/data/indexed-db.js');
const storageSource = read('js/modules/storage.js');
const requestSource = read('js/modules/chat-ai/request-and-stream.js');
const image = 'data:image/png;base64,' + 'A'.repeat(180000);
const preview = 'data:image/jpeg;base64,' + 'B'.repeat(100);
const unknown = () => Object.assign(new Error('characters.bulkPut(): 1 of 1 operations failed. Errors: UnknownError: Failed to delete record from object store'), { name: 'BulkError' });
const character = id => ({ id, history: [{ id: id + '-image', content: image,
    parts: [{ type: 'image', data: image }], novelAiImageUrl: image,
    imageGenerationMeta: { originalImageUrl: image, provider: 'novelai' },
    _imageVersions: [{ imageUrl: image, metadata: { originalImageUrl: image, provider: 'novelai' } }] }] });
function harness(characters = [character('a')], groups = []) {
    const notices = [], events = [];
    let failure = null, beforeWrite = null, now = 1000, writes = 0;
    const table = records => {
        const rows = new Map(records.map(row => [row.id, structuredClone(row)]));
        return { rows, async put(row) {
            writes++;
            if (beforeWrite) await beforeWrite(row);
            if (failure) throw failure;
            rows.set(row.id, structuredClone(row));
        }, async bulkPut(records) { for (const row of records) await this.put(row); } };
    };
    const db = { characters, groups, worldBooks: [], myStickers: [] };
    const dexieDB = { characters: table(characters), groups: table(groups), worldBooks: table([]), myStickers: table([]), globalSettings: table([]) };
    class Clock extends Date { static now() { return now; } }
    const context = vm.createContext({ db, dexieDB, navigator: {}, globalSettingKeys: [], Date: Clock,
        window: { dispatchEvent: event => events.push(event), addEventListener() {} },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        console: Object.fromEntries(['log','info','debug','warn','error'].map(key => [key, () => {}])),
        setTimeout, clearTimeout, showToast: message => notices.push(message),
        fetch: async () => ({ blob: async () => ({}) }), compressImage: async () => preview });
    vm.runInContext(dataSource, context);
    return { context, db, dexieDB, notices, events, health: context.window.StorageSaveHealth,
        fail: error => { failure = error; }, before: callback => { beforeWrite = callback; },
        advance: ms => { now += ms; }, writes: () => writes };
}

// 分类依据嵌套错误类型，不依据可能误导的数据库错误文字；失败期间跨入口去重。
{
    const h = harness(); h.fail(unknown());
    assert.equal(await h.context.window.saveCharacter('a'), false);
    assert.doesNotMatch(h.notices[0], /配额不足|存储空间不足/);
    assert.equal(h.health.canRunBackground(), false);
    await vm.runInContext('saveData()', h.context);
    await h.context.window.saveCharacter('a');
    assert.equal(h.notices.length, 1);
    assert.equal(h.health.isQuotaError({ name: 'BulkError', failures: [{ name: 'QuotaExceededError' }] }), true);
    assert.equal(h.health.isQuotaError({ cause: { name: 'QuotaExceededError' } }), true);
    const circular = { name: 'UnknownError' }; circular.cause = circular;
    assert.equal(h.health.isQuotaError(circular), false);
    h.advance(31000);
    assert.equal(h.health.canRunBackground(), true);
    h.fail({ name: 'BulkError', failures: [{ name: 'QuotaExceededError' }] });
    await h.context.window.saveCharacter('a');
    assert.match(h.notices.at(-1), /配额不足/);
    h.fail(null);
    assert.equal(await vm.runInContext('saveData()', h.context), true);
    assert.equal(h.health.hasFailures(), false);
}

// 持久错误状态及真实手动重试入口。
{
    const h = harness(); let retry;
    const errorNotice = { hidden: true };
    const status = { hidden: false, querySelector: () => errorNotice }, button = { addEventListener(_type, handler) { retry = handler; } };
    const listeners = new Map();
    h.context.window.addEventListener = (type, handler) => listeners.set(type, handler);
    h.context.window.dispatchEvent = event => listeners.get(event.type)?.(event);
    h.context.document = { getElementById: id => id === 'storage-save-status' ? status : button };
    const start = storageSource.indexOf('    const saveStatus =');
    const end = storageSource.indexOf('    const screen =', start);
    vm.runInContext(storageSource.slice(start, end), h.context);
    assert.equal(status.hidden, false, '没有报错时仍显示保存按钮');
    assert.equal(errorNotice.hidden, true);
    h.fail(unknown()); await h.context.window.saveCharacter('a');
    assert.equal(errorNotice.hidden, false, '持久错误状态不能随着弹窗消失');
    await retry();
    assert.equal(errorNotice.hidden, false); assert.equal(button.disabled, false);
    h.fail(null); await retry();
    assert.equal(errorNotice.hidden, true); assert.equal(status.hidden, false); assert.equal(button.disabled, false);
    assert.equal(h.dexieDB.characters.rows.get('a').history[0].content, image);
}

// 暂停后台 API 调用，但不禁止显式保存重试；配额预警也不能连续刷屏。
{
    const h = harness(); h.fail(unknown());
    await h.context.window.saveCharacter('a');
    vm.runInContext(requestSource, h.context);
    assert.equal(await h.context.getAiReply('a', 'private', true), false);
    h.context.navigator.storage = { estimate: async () => ({ usage: 96, quota: 100 }) };
    await vm.runInContext('saveData()', h.context);
    await vm.runInContext('saveData()', h.context);
    assert.equal(h.notices.filter(message => message.includes('已使用')).length, 1);
}

// 清理失败停止后续会话、恢复媒体，不假报完成；下一次重试可以真正落盘。
{
    const h = harness([character('a'), character('b')]);
    const before = structuredClone(h.db.characters);
    h.fail(unknown());
    await assert.rejects(h.context.window.compactLegacyChatMedia(), { name: 'StorageWriteError' });
    assert.deepEqual(h.db.characters, before);
    assert.deepEqual([...h.dexieDB.characters.rows.values()], before);
    assert.equal(h.writes(), 1);
    assert.equal(h.events.some(event => event.type === 'ovo-chat-media-compacted'), false);
    h.fail(null);
    const result = await h.context.window.compactLegacyChatMedia();
    assert.equal(result.chats, 2);
    assert.ok(result.duplicateCharacters > 0);
    assert.equal(h.dexieDB.characters.rows.get('a').history[0].imageGenerationMeta.originalImageUrl, undefined);
    const writes = h.writes();
    assert.equal((await h.context.window.compactLegacyChatMedia()).chats, 0);
    assert.equal(h.writes(), writes);
}

// 执行真实按钮处理函数：压缩失败恢复图片且无第二个通用弹窗，重试成功后才报完成。
for (const type of ['private', 'group']) {
    const h = harness(type === 'private' ? [character('a')] : [], type === 'group' ? [character('a')] : []);
    const chat = (type === 'private' ? h.db.characters : h.db.groups)[0];
    const before = structuredClone(chat);
    let click;
    const button = { addEventListener(_type, handler) { click = handler; } };
    Object.assign(h.context, { document: { getElementById: () => button }, showAppConfirmDialog: async () => 'confirm',
        formatBytes: String, renderStorageChart() {}, renderStorageDetails() {}, updatePersistenceStatus() {}, colorPalette: [] });
    const start = storageSource.indexOf('    const compressAllBtn =');
    const end = storageSource.indexOf('    // 存储页控制台', start);
    vm.runInContext(storageSource.slice(start, end), h.context);
    vm.runInContext('dataStorage.getStorageInfo = async () => null', h.context);
    h.fail(unknown()); await click();
    assert.deepEqual(chat, before);
    assert.equal(button.disabled, false);
    assert.equal(h.notices.filter(message => /保存失败/.test(message)).length, 1);
    assert.equal(h.notices.some(message => /压缩完成/.test(message)), false);
    h.fail(null); await click();
    const disk = (type === 'private' ? h.dexieDB.characters : h.dexieDB.groups).rows.get('a');
    assert.equal(disk.history[0].parts[0].data, preview);
    assert.equal(disk.history[0].imageGenerationMeta.originalImageUrl, image, 'NovelAI 原图保留');
    assert.equal(h.notices.some(message => /压缩完成/.test(message)), true);
}

// 慢压缩保留并发新增消息；失败回滚不能覆盖期间更换的新图片。
{
    const h = harness(); const chat = h.db.characters[0];
    await h.context.window.editChatMedia(chat, 'private', async draft => {
        draft.history[0].parts[0].data = preview;
        chat.history.push({ id: 'new', content: '压缩期间新增消息' });
    });
    assert.equal(h.dexieDB.characters.rows.get('a').history.at(-1).id, 'new');
    h.fail(unknown());
    h.before(() => { chat.history[0].parts[0].data = 'newer-image'; });
    await assert.rejects(h.context.window.editChatMedia(chat, 'private', draft => {
        draft.history[0].parts[0].data = 'temporary-image';
    }));
    assert.equal(chat.history[0].parts[0].data, 'newer-image');
    h.before(null);
    await assert.rejects(h.context.window.editChatMedia(chat, 'private', async draft => {
        draft.history[0].parts[0].data = preview;
        chat.history[0].parts[0].data = 'concurrent-image';
    }), /处理期间已被修改/);
    assert.equal(chat.history[0].parts[0].data, 'concurrent-image');
}

// 全量写入失败后不继续执行并发请求排定的下一轮；显式重试仍可成功。
{
    const h = harness(); h.fail(unknown());
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    h.before(async () => { entered(); await gate; });
    const first = vm.runInContext('saveData()', h.context);
    await ready;
    const second = vm.runInContext('saveData()', h.context);
    release();
    assert.equal(await first, false); assert.equal(await second, false);
    assert.equal(h.writes(), 1);
    h.fail(null); h.before(null);
    assert.equal(await vm.runInContext('saveData()', h.context), true);
}

// 回复最终保存失败时，真实 finalizeReply 不清除恢复任务的回复正文。
{
    const h = harness(); let completed = false;
    h.context.window.ReplyResilience = { canFinalize: () => true, markFinalizing: async () => {}, complete: async () => { completed = true; } };
    Object.assign(h.context, { chat: h.db.characters[0], chatId: 'a', chatType: 'private', requestAbortController: null,
        replyTask: { id: 'task' }, replyOptions: {}, backgroundReason: '', apiConfig: {},
        isBackground: false, isSummary: false, isCharBlockedMonologue: false, isPhoneControlRevokeAttempt: false,
        handleAiReplyContent: async text => { h.db.characters[0].history.push({ id: 'reply', content: text }); } });
    const start = requestSource.indexOf('    const persistTargetChat =');
    const end = requestSource.indexOf('\n    if (window.StatusStorage?.isChatLocked', start);
    vm.runInContext(requestSource.slice(start, end) + '\nwindow.finishTestReply = finalizeReply;', h.context);
    h.fail(unknown());
    await assert.rejects(h.context.window.finishTestReply('保留回复'), { name: 'StorageWriteError' });
    assert.equal(completed, false);
    assert.equal(h.db.characters[0].history.at(-1).content, '保留回复');
    h.context.replyTask = null;
    h.context.handleAiReplyContent = async () => false;
    await assert.rejects(h.context.window.finishTestReply('没有恢复任务时也检查保存结果'), { name: 'StorageWriteError' });
}

// 已在内存显示的回复也必须重试落盘才能完成恢复，避免再次调用收费 API。
for (const tagged of [true, false]) {
    const h = harness(); const chat = h.db.characters[0];
    const rows = new Map();
    const task = { id: 'pending', chatId: 'a', chatType: 'private', userMessageId: 'user', state: 'interrupted', createdAt: 1, updatedAt: 1, rawPartial: '完整回复' };
    chat.history = [{ id: 'user', role: 'user' }, { id: 'answer', role: 'assistant', content: '完整回复', timestamp: 2, ...(tagged ? { replyRequestId: task.id } : {}) }];
    rows.set(task.id, structuredClone(task));
    h.dexieDB.pendingReplies = { async toArray() { return [...rows.values()].map(row => structuredClone(row)); }, async put(row) { rows.set(row.id, structuredClone(row)); } };
    let apiCalls = 0;
    h.context.getAiReply = async () => { apiCalls++; };
    vm.runInContext(read('js/modules/chat-ai/reply-resilience.js'), h.context);
    h.fail(unknown());
    await h.context.window.ReplyResilience.recoverPending();
    assert.equal(rows.get(task.id).state, 'interrupted');
    assert.equal(rows.get(task.id).rawPartial, '完整回复');
    assert.equal(apiCalls, 0);
    h.fail(null); h.advance(31000);
    await h.context.window.ReplyResilience.recoverPending();
    assert.equal(rows.get(task.id).state, 'completed');
    assert.equal(h.dexieDB.characters.rows.get('a').history[1].content, '完整回复');
    assert.equal(apiCalls, 0);
}

console.log('Storage failure tests passed: error classification, notice throttling, rollback/retry, private/group compression, concurrent edits, failed queue stop and reply recovery.');
