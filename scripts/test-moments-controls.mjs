import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseFragment } from 'parse5';

// 使用生产模块和 API 请求函数，在隔离数据中验证完整设置与调用链。
let now = 1800000000000;
class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const nodes = new Map();
class Element {
    constructor(id = '', attrs = {}, tag = '') {
        this.id = id; this.attrs = attrs; this.tag = tag; this.listeners = {}; this.children = []; this.elements = {};
        this.value = attrs.value || ''; this.name = attrs.name || ''; this.checked = 'checked' in attrs; this.disabled = 'disabled' in attrs;
        this.hidden = true; this.dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-')).map(([k,v]) => [k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));
        this.classList = { contains: () => false }; this.style = {}; this.textContent = ''; this._html = '';
    }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    setAttribute() {} focus() {}
    set innerHTML(value) {
        this._html = value; this.children = []; this.elements = {};
        const visit = (p, parent) => {
            for (const c of p.childNodes || []) {
                if (!c.tagName) continue;
                const attrs = Object.fromEntries((c.attrs || []).map(a => [a.name,a.value]));
                const e = new Element(attrs.id, attrs, c.tagName); parent.children.push(e); if (e.id) nodes.set(e.id, e);
                if (e.name) this.elements[e.name] = e;
                visit(c,e);
                if (e.tag === 'select') { const options = e.children.filter(o => o.tag === 'option'); e.value = (options.find(o => 'selected' in o.attrs) || options[0])?.value || ''; }
                if (e.tag === 'textarea') e.value = (c.childNodes || []).filter(n=>n.nodeName==='#text').map(n=>n.value).join('');
            }
        };
        visit(parseFragment(value),this);
    }
    get innerHTML() { return this._html; }
    querySelectorAll(selector) {
        const result = [], attr = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/), wantChecked = selector.endsWith(':checked');
        const visit = parent => { for (const c of parent.children) { if (attr && attr[1] in c.attrs && (attr[2]===undefined || c.attrs[attr[1]]===attr[2]) && (!wantChecked || c.checked)) result.push(c); visit(c); } };
        visit(this); return result;
    }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
}
function element(id) { if (!nodes.has(id)) nodes.set(id,new Element(id)); return nodes.get(id); }
const db = {
    characters: [
        { id:'a',realName:'甲',persona:'经营花店',history:[],momentsSettings:{ postEnabled:true,storyEnabled:true,browseEnabled:true,interactEnabled:true,contactsEnabled:true } },
        { id:'b',realName:'乙',persona:'朋友',history:[],momentsSettings:{ interactEnabled:true } },
        { id:'fresh',realName:'新角色',history:[] },
        { id:'legacy',realName:'旧角色',history:[],momentsSettings:{postEnabled:false} },
    ],
    apiSettings:{ url:'https://example.invalid',model:'test',key:'test' },
    myPersonaPresets:[{id:'p',name:'我',avatar:''}],activePersonaId:'p',
    moments:{ settings:{interactionVisibility:'all'},contacts:[{id:'npc1',actorId:'npc_x',kind:'npc',ownerCharId:'a',name:'人脉',persona:'朋友',enabled:true,mayInteract:true,mayPost:true}],posts:[],groups:[],notifications:[],friendRequests:[],activityEvents:[] },
};
let requests = 0, response = { action:'none' }, saveSucceeds = true, pendingResponse, failRequests = 0;
const sandbox = {
    db, Date:TestDate, Intl, Math, console, AbortController,
    document:{ getElementById:element,querySelectorAll:()=>[],addEventListener() {},visibilityState:'visible' },
    setTimeout:()=>1,clearTimeout(){}, setInterval(){ throw Error('固定轮询不应被注册'); },
    saveGlobalSettings:async()=>saveSucceeds,saveCharacter:async()=>saveSucceeds,showToast:message=>{sandbox.toast=message;},switchScreen:id=>{sandbox.screen=id;},
    isApiConfigReady:config=>Boolean(config?.url && config?.model && config?.key),prepareAiProviderRequest:(_s,body,headers,endpoint)=>({body,headers,endpoint,provider:'openai'}),
    extractAiProviderResponse:data=>({content:data.choices[0].message.content}),
    getApiConfigHeaders:()=>({}),getApiConfigEndpoint:()=>'https://example.invalid',RoleApiBindings:{describe:()=>({})},
    fetch:async(_url,options)=>{
        requests++; if(pendingResponse)await pendingResponse(options.signal);
        if (failRequests > 0) { failRequests--; return { ok:false,status:503,text:async()=>'unavailable' }; }
        return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{message:{content:JSON.stringify(response)}}]})};
    },
};
sandbox.window=sandbox;
let controlsSource=fs.readFileSync(new URL('../js/modules/moments-controls.js',import.meta.url),'utf8');
controlsSource=controlsSource.replace('window.MomentsControls={','window.__controlsTest={data,wake,execute,save,readTempo,nextDue,newSchedule,inWindow}; window.MomentsControls={');
vm.runInNewContext(controlsSource,sandbox);
const core=fs.readFileSync(new URL('../js/core/api-and-image-utils.js',import.meta.url),'utf8');
vm.runInNewContext(core.slice(0,core.indexOf('async function readStreamResponse')),sandbox);
const momentsSource=fs.readFileSync(new URL('../js/modules/moments.js',import.meta.url),'utf8').replace(/\}\)\(\);\s*$/,'window.__momentsTest={generateReplies,addComment,applyActorAction,generatePost,prepareForChat,sendUserComment,viewPostForActor,interactionContextFor,showResult,state,publish};})();');
vm.runInNewContext(momentsSource,sandbox);
const policy=sandbox.MomentsControls, test=sandbox.__controlsTest, moments=sandbox.__momentsTest;
sandbox.Moments.init();
await test.wake('startup',true);
assert.equal(requests,0,'启动及能力开关不能隐含授权 API 调用');
await sandbox.Moments.prepareForChat(db.characters[0],'看看动态');
assert.equal(requests,0,'聊天前额外判断默认关闭');

// The default flow needs no scheduler or permission setup.
assert.equal(policy.settings().triggers.userPost,true);
assert.equal(policy.localPreferences('char:fresh').postEnabled,undefined,'rendering does not turn inherited defaults into local overrides');
assert.equal(policy.preferences('char:legacy').postEnabled,false,'explicit legacy choices survive the initial render');
test.data().preferences.postEnabled=false;
assert.equal(policy.preferences('char:fresh').postEnabled,false);
test.data().preferences.postEnabled=true;
assert.equal(policy.preferences().preset,'medium');
assert.equal(policy.settings().triggers.timer,true);
policy.open();
let form=element('moments-controls-form');
assert.doesNotMatch(form.innerHTML,/override\.|pairA|copyActor|requests\.|triggers\.|高级|时间窗口|统计周期/);
assert.match(form.innerHTML,/轻度/);assert.match(form.innerHTML,/重度/);assert.match(form.innerHTML,/data-tempo-slider/);
form.onchange({target:form.querySelector('[data-tempo-preset]')});
const preset=form.querySelector('[data-tempo-preset]');preset.value='heavy';form.onchange({target:preset});
assert.equal(Number(element('moments-tempo-postIntervalMs').value),15);
await test.save({preventDefault(){}});
assert.equal(policy.preferences().postIntervalMs,15*60000);
assert.equal(policy.preferences().replyDelayMs,0);
policy.open();form=element('moments-controls-form');
element('moments-tempo-postIntervalMs').value='8';form.oninput({target:element('moments-tempo-postIntervalMs')});
await test.save({preventDefault(){}});
assert.equal(policy.preferences().postIntervalMs,8*60000);
assert.equal(policy.preferences().preset,'custom');
assert.equal(policy.preferences().conversationRounds,6,'customizing a preset retains its conversation pacing');
policy.open();element('moments-tempo-postIntervalMs').value='0';await test.save({preventDefault(){}});
assert.equal(policy.preferences().postIntervalMs,8*60000,'invalid settings retain prior values');

// Individual controls live inside chat settings. Only changed items override.
sandbox.Moments.loadCharacterSettings(db.characters[0]);
assert.match(element('setting-moments-tempo').innerHTML,/跟随全局/);
assert.doesNotMatch(element('setting-moments-tempo').innerHTML,/NPC 接话/);
element('moments-role-tempo-postIntervalMs-mode').value='custom';element('moments-role-tempo-postIntervalMs').value='13';
element('moments-role-tempo-replyDelayMs-mode').value='inherit';
element('setting-moments-reply-enabled').value='off';
sandbox.Moments.saveCharacterSettings(db.characters[0]);
assert.equal(policy.preferences('char:a').postIntervalMs,13*60000);
assert.equal(policy.preferences('char:a').replyEnabled,false);
test.data().preferences.replyDelayMs=9000;
assert.equal(policy.preferences('char:a').replyDelayMs,9000);
assert.equal(policy.preferences('char:a').postIntervalMs,13*60000);
assert.equal(policy.preferences('char:b').postIntervalMs,8*60000);
policy.localPreferences('char:a').replyEnabled=true;

// Chat linkage is on for old data, inherits globally, and has one per-role override.
assert.equal(policy.preferences().chatLinked,true);
assert.equal(sandbox.Moments.isChatLinked('fresh'),true);
assert.equal(policy.localPreferences('char:fresh').chatLinked,undefined);
assert.ok(sandbox.Moments.promptForCharacter('fresh').includes('<visible_moments>'));
policy.open();form=element('moments-controls-form');
const linkSwitch=form.elements['preference.chatLinked'];
assert.equal(linkSwitch.checked,true);
assert.match(form.innerHTML,/聊天关联动态/);
linkSwitch.checked=false;await test.save({preventDefault(){}});
assert.equal(policy.preferences().chatLinked,false);
assert.equal(sandbox.screen,'moments-settings-screen');
assert.equal(sandbox.toast,'动态设置已保存');
assert.equal(sandbox.Moments.promptForCharacter('a'),'');
assert.equal(policy.settings('char:a').actions.post,true,'linkage does not change dynamic participation');
policy.localPreferences('char:fresh').chatLinked=true;
sandbox.Moments.loadCharacterSettings(db.characters[2]);
assert.equal(element('setting-moments-chat-linked').value,'on');
assert.ok(sandbox.Moments.promptForCharacter('fresh').includes('<visible_moments>'));
element('setting-moments-chat-linked').value='inherit';
sandbox.Moments.saveCharacterSettings(db.characters[2]);
assert.equal(policy.localPreferences('char:fresh').chatLinked,undefined);
assert.equal(sandbox.Moments.promptForCharacter('fresh'),'');
policy.open();form=element('moments-controls-form');
assert.equal(form.elements['preference.chatLinked'].checked,false,'reopening retains the global choice');
form.elements['preference.chatLinked'].checked=true;await test.save({preventDefault(){}});
element('setting-moments-chat-linked').value='off';
sandbox.Moments.saveCharacterSettings(db.characters[2]);
assert.equal(sandbox.Moments.promptForCharacter('fresh'),'','a role can opt out of enabled global linkage');
sandbox.Moments.loadCharacterSettings(db.characters[2]);
assert.equal(element('setting-moments-chat-linked').value,'off');
policy.open('char:fresh');await test.save({preventDefault(){}});
assert.equal(policy.localPreferences('char:fresh').chatLinked,false,'other actor controls preserve the hidden override');
policy.open();form=element('moments-controls-form');
form.elements['preference.chatLinked'].checked=false;saveSucceeds=false;
await test.save({preventDefault(){}});saveSucceeds=true;
assert.equal(policy.preferences().chatLinked,true,'failed saving restores the previous global choice');
assert.equal(sandbox.toast,'设置保存失败');
delete policy.localPreferences('char:fresh').chatLinked;

const prompts=[];
sandbox.fetchAiResponse=async(_config,body,_headers,_url,_stream,opts)=>{
    if(opts?.beforeRequest)await opts.beforeRequest();
    prompts.push(body.messages[0].content);requests++;
    if(pendingResponse)await pendingResponse(opts?.signal);
    if(failRequests){failRequests--;throw Error('网络断开');}
    const result=typeof response==='function'?response(body.messages[0].content):response;
    return typeof result==='string'?result:JSON.stringify(result);
};
function newPost(id,audience=['user','char:a','char:b','npc_x']){const p={id,kind:'post',authorId:'user',authorPersonaId:'p',text:'今天有点累，想聊聊',audienceIds:audience,likes:[],comments:[],createdAt:now};db.moments.posts.push(p);return p;}
async function settle(){for(let i=0;i<80;i++){await new Promise(setImmediate);if(!test.data().tasks.some(t=>t.status==='running'))return;}throw Error('tasks did not settle');}
db.myPersonaPresets[0].persona='用户身份设定';db.characters[0].myPersona='我们是相识多年的朋友';
db.characters[0].history=[{role:'user',content:'私聊秘密标记'},{role:'assistant',content:'我记得我们一起去看海'}];
db.characters[0].memoryJournals=[{title:'回忆',content:'共同记忆标记',isFavorited:true}];
db.characters[0].worldBookIds=['world'];db.worldBooks=[{id:'world',content:'角色世界书标记'}];
let post=newPost('auto');post.reminderIds=['char:a'];response={like:true,comment:'我陪你聊聊',replyTo:'',thought:'想陪伴'};
const before=requests;await policy.postEvent(post);await settle();
assert.equal(requests,before+3,'visible roles and NPC view directly without an extra decision request');
assert.equal(post.viewResults.length,3);assert.equal(post.comments.length,3);
assert.ok(post.seenBy['char:a']);assert.ok(post.seenBy['npc_x']);
assert.equal(test.data().tasks.filter(t=>t.type==='view'&&t.postId===post.id&&t.actorIds.includes('char:a')).length,1,'automatic view and reminder merge');
assert.ok(prompts.some(p=>p.includes('用户专门提醒你')));
const rolePrompt=prompts.find(p=>p.includes('私聊秘密标记'));
assert.match(rolePrompt,/用户身份设定|相识多年的朋友/);assert.match(rolePrompt,/共同记忆标记/);assert.match(rolePrompt,/角色世界书标记/);
const npcPrompt=prompts.find(p=>p.includes('你的身份：人脉'));
assert.doesNotMatch(npcPrompt,/私聊秘密标记|共同记忆标记|角色世界书标记/,'NPC does not inherit owner private context or unbound books');

// Closed linkage removes automatic dynamic knowledge in every prompt path, not user conversation.
test.data().preferences.chatLinked=false;
const historySnapshot=JSON.stringify(db.characters[0].history);
const activitySnapshot=JSON.stringify(db.moments.activityEvents);
assert.equal(sandbox.Moments.promptForCharacter('a'),'');
assert.match(moments.interactionContextFor('char:a',post),/私聊秘密标记/,'dynamics still remember private chat');
assert.match(moments.interactionContextFor('char:a',post),/共同记忆标记/,'dynamics still remember shared memories');
assert.equal(JSON.stringify(db.characters[0].history),historySnapshot);
assert.equal(JSON.stringify(db.moments.activityEvents),activitySnapshot);
const promptSandbox={...sandbox,
    getActiveWorldBooksContents:()=>({before:'',middle:'',after:''}),getEffectivePersona:c=>c.persona||'',
    getOnlineLogicRules:()=>'',getOnlineOutputFormats:()=>'',pad:v=>String(v).padStart(2,'0'),
};
promptSandbox.window=promptSandbox;
const uiSource=fs.readFileSync(new URL('../js/core/ui-and-content-utils.js',import.meta.url),'utf8');
const filterStart=uiSource.indexOf('function filterHistoryForAI(');
const filterEnd=uiSource.indexOf('\nfunction ',filterStart+1);
vm.runInNewContext(uiSource.slice(filterStart,filterEnd),promptSandbox);
const userMessage={role:'user',content:'我想聊聊今天的动态'};
const activityMessage={role:'system',content:'自动动态旁白标记',isMomentsActivity:true,excludeFromContext:true};
assert.deepEqual(Array.from(promptSandbox.filterHistoryForAI(db.characters[0],[activityMessage,userMessage]),m=>m.content),[userMessage.content]);
assert.deepEqual(Array.from(promptSandbox.filterHistoryForAI(db.characters[0],[activityMessage,userMessage],true),m=>m.content),[userMessage.content]);
vm.runInNewContext(fs.readFileSync(new URL('../js/modules/chat-ai/private-prompt.js',import.meta.url),'utf8'),promptSandbox);
const character={id:'a',realName:'甲',myName:'我',persona:'经营花店',history:[userMessage],memoryJournals:[]};
const oldMagic=db.magicRoom;
db.magicRoom={};
assert.doesNotMatch(promptSandbox.generatePrivateSystemPrompt(character),/<visible_moments>|MOMENT:/);
db.magicRoom={customPromptEnabled:true,customPromptTemplate:'自定义 {{角色名}} {{动态能力与已看内容}}'};
vm.runInNewContext(fs.readFileSync(new URL('../js/modules/chat-ai/prompt-studio.js',import.meta.url),'utf8'),promptSandbox);
assert.doesNotMatch(promptSandbox.generatePrivateSystemPrompt(character),/<visible_moments>|MOMENT:|\{\{动态能力与已看内容\}\}/);
db.magicRoom={};promptSandbox.PromptStudio=undefined;
character.activeNodeId='node';character.nodes=[{id:'node',name:'剧情节点',prompt:'继续剧情',readMemory:true}];
const actualHistory=db.characters[0].history;db.characters[0].history=[activityMessage,userMessage,{isNodeBoundary:true,nodeAction:'start',nodeId:'node',content:''}];
character.history=db.characters[0].history;
assert.doesNotMatch(promptSandbox.generatePrivateSystemPrompt(character),/<visible_moments>|MOMENT:|自动动态旁白标记/);
delete character.activeNodeId;
const linked={id:'alt',source:'forum',linkedCharId:'a',realName:'小号',history:[],momentsSettings:{preferences:{}}};
db.characters.push(linked);
assert.doesNotMatch(promptSandbox.generatePrivateSystemPrompt(linked),/自动动态旁白标记/);
vm.runInNewContext(fs.readFileSync(new URL('../js/modules/chat-ai/prompt-studio.js',import.meta.url),'utf8'),promptSandbox);
assert.doesNotMatch(promptSandbox.PromptStudio.buildVariables(linked,{} )['关系与功能上下文'],/自动动态旁白标记/);
db.characters.pop();db.characters[0].history=actualHistory;db.magicRoom=oldMagic;
test.data().preferences.chatLinked=true;
assert.match(sandbox.Moments.promptForCharacter('a'),/<visible_moments>/,'turning back on reuses the retained dynamic history');
response={replies:[]};await policy.postEvent(post);await settle();assert.equal(test.data().tasks.filter(t=>t.type==='view'&&t.postId===post.id).length,3,'same publication never schedules duplicate views');assert.equal(post.viewResults.length,3);
for(const task of test.data().tasks)if(task.status==='waiting')task.status='cancelled';response={like:true,comment:'我陪你聊聊',replyTo:'',thought:'想陪伴'};
moments.showResult(post.id);assert.match(element('moments-result-content').innerHTML,/查看返回详情/);assert.doesNotMatch(element('moments-result-content').innerHTML,/过段时间/);

// Viewing does not require the ability to comment; disabled actions get explanations.
for(const key of ['likeEnabled','commentEnabled','replyEnabled'])policy.localPreferences('char:b')[key]=false;
post=newPost('blocked',['user','char:b']);await policy.postEvent(post);await settle();
assert.ok(post.seenBy['char:b']);assert.equal(post.comments.length,0);
assert.equal(post.viewResults[0].status,'blocked');assert.match(post.viewResults[0].summary,/未执行|关闭/);
policy.localPreferences('char:b').watchEnabled=false;
post=newPost('no-watch',['user','char:b']);const noWatch=requests;await policy.postEvent(post);await settle();
assert.equal(requests,noWatch);assert.match(post.viewResults[0].summary,/未观看/);

// Every error appears in the same viewing history; late responses cannot write.
post=newPost('error',['user','char:a']);response='这不是 JSON';await policy.postEvent(post);await settle();
assert.equal(post.viewResults[0].status,'error');assert.match(post.viewResults[0].summary,/JSON/);
assert.equal(post.seenBy,undefined);
response={like:false,comment:'迟到回复'};post=newPost('late',['user','char:a']);
let release;pendingResponse=()=>new Promise(resolve=>{release=resolve;});
await policy.postEvent(post);await new Promise(setImmediate);
post.revision=1;release();pendingResponse=null;await settle();
assert.equal(post.comments.length,0);assert.equal(post.viewResults[0].status,'cancelled');

// Comment pacing is per actor, not delayed by the slowest NPC.
policy.localPreferences('char:b').watchEnabled=true;policy.localPreferences('char:b').replyEnabled=true;
test.data().preferences.replyDelayMs=0;test.data().preferences.npcReplyDelayMs=8000;
post=newPost('discussion');post.seenBy={'char:a':now,'char:b':now,npc_x:now};
const user=moments.addComment(post,'user','你们怎么看？');await policy.commentEvents(post,[user]);
const queued=test.data().tasks.filter(t=>t.commentId===user.id);
assert.equal(queued.length,3);
assert.equal(queued.find(t=>t.actorIds[0]==='char:a').dueAt,now);
assert.equal(queued.find(t=>t.actorIds[0]==='npc_x').dueAt,now+8000);
response={replies:[{actorId:'char:a',text:'我在这里'}]};await test.execute(queued.find(t=>t.actorIds[0]==='char:a'));
assert.equal(post.comments.filter(c=>c.replyTo===user.id&&c.authorId==='char:a').length,1);
assert.equal((await moments.applyActorAction('char:b',{type:'like',postId:post.id})).ok,false);

// NPCs without legacy flags inherit global reply participation.
const npc=db.moments.contacts[0];delete npc.preferences;delete npc.mayInteract;delete npc.mayPost;
post=newPost('npc-inherit');post.seenBy={npc_x:now};
const npcUser=moments.addComment(post,'user','聊一下？');await policy.commentEvents(post,[npcUser]);
assert.ok(test.data().tasks.some(t=>t.commentId===npcUser.id&&t.actorIds[0]==='npc_x'));

db.moments.contacts.push({id:'new-npc',actorId:'npc_new',kind:'npc',ownerCharId:'a',enabled:true,preferences:{},mayInteract:false,mayPost:false});
assert.equal(policy.preferences('npc_new').replyEnabled,true,'new NPCs follow global settings even when compatibility flags are present');
assert.equal(policy.preferences('npc_new').postEnabled,true);

// Permissions and Story expiry are checked before requesting and after responses.
post=newPost('hidden',['user','char:a']);const hiddenTask={...policy.context('userPost',['char:a'],post),type:'view'};
post.audienceIds=['user'];const hiddenRequests=requests;await test.execute(hiddenTask);assert.equal(requests,hiddenRequests);assert.equal(hiddenTask.status,'cancelled');
post=newPost('expired',['user','char:a']);post.kind='story';post.expiresAt=now-1;
assert.equal(policy.valid(policy.context('userPost',['char:a'],post)),false);
for(const task of test.data().tasks)if(task.status==='waiting')task.status='cancelled';
post=newPost('save-fail',['user','char:a']);saveSucceeds=false;const saveRequests=requests;await policy.postEvent(post);saveSucceeds=true;
assert.equal(requests,saveRequests);assert.equal(post.viewResults[0].status,'error');assert.equal(post.seenBy,undefined);

for(const task of test.data().tasks)if(task.status==='waiting')task.status='cancelled';
// Added reminders immediately revisit even an already viewed post, once per edit.
post=newPost('remind-edit',['user','char:a']);post.seenBy={'char:a':now};post.revision=1;post.reminderIds=['char:a'];response={like:false,comment:'',thought:'收到提醒'};
const reminderRequests=requests;await policy.postEvent(post,{actorIds:['char:a'],reminderIds:['char:a']});await settle();
assert.equal(requests,reminderRequests+1);assert.equal(post.viewResults[0].reminded,true);
await policy.postEvent(post,{actorIds:['char:a'],reminderIds:['char:a']});await settle();assert.equal(requests,reminderRequests+1);

// Many participants do not multiply replies into a branching request storm.
for(const task of test.data().tasks)if(task.status==='waiting')task.status='cancelled';
test.data().preferences.replyDelayMs=0;test.data().preferences.npcReplyDelayMs=0;test.data().preferences.conversationRounds=3;
policy.localPreferences('char:b').commentEnabled=true;
post=newPost('rounds');post.seenBy={'char:a':now,'char:b':now,npc_x:now};
const roundUser=moments.addComment(post,'user','大家一起来聊聊');await policy.commentEvents(post,[roundUser]);
response=prompt=>{const actor=prompt.includes('你的身份：甲')?'char:a':prompt.includes('你的身份：乙')?'char:b':'npc_x';return {replies:[{actorId:actor,text:'我想接话'}]};};
let turns=0;
while(test.data().tasks.some(t=>t.postId===post.id&&t.status==='waiting')){
    const task=test.data().tasks.find(t=>t.postId===post.id&&t.status==='waiting');await test.execute(task);assert.ok(++turns<40,'reply loop must terminate');
}
const replies=post.comments.filter(c=>c.authorId!=='user');assert.ok(replies.length>3);assert.ok(replies.length<=9);
for(const actor of ['char:a','char:b','npc_x'])for(let round=1;round<=3;round++)assert.ok(replies.filter(c=>c.authorId===actor&&c.generationRound===round).length<=1);
const resume=moments.addComment(post,'user','继续说吧',roundUser.id);await policy.commentEvents(post,[resume]);
assert.equal(test.data().tasks.filter(t=>t.commentId===resume.id).length,3,'new user comments reopen the discussion without carrying the old round cap');

// Identity changes do not change the recorded author of old posts.
const author=post.authorPersonaId;db.myPersonaPresets.push({id:'other',name:'另一身份',persona:'另一身份秘密'});db.activePersonaId='other';
assert.equal(post.authorPersonaId,author);
assert.doesNotMatch(moments.interactionContextFor('char:a',post),/另一身份秘密/);
// The actual dynamic generation request also keeps chat context while linkage is off.
test.data().preferences.chatLinked=false;
response={text:'花店今天很忙'};
const generationPromptStart=prompts.length;
assert.equal(await sandbox.Moments.generatePost('char:a','post',true),true);
assert.ok(prompts.slice(generationPromptStart).some(prompt=>prompt.includes('私聊秘密标记')));
await settle();
assert.equal(sandbox.Moments.promptForCharacter('a'),'');
console.log('Moments simple settings, presets, exact custom values, per-item overrides, automatic views, reminders, identities, NPC privacy, errors and pacing passed.');
