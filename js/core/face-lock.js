// 每个角色独立的人物参考；只对明确标记为角色本人单人图的请求生效。
(function () {
    'use strict';
    const clone = value => JSON.parse(JSON.stringify(value || {}));
    const el = id => document.getElementById(id);
    const settingKeys = { gpt: 'gptImageSettings', novelai: 'novelAiSettings', google: 'googleImageSettings', stability: 'stabilityImageSettings' };
    const referenceCache = new Map();
    let draft = null;
    let uploadTarget = null;

    function provider() {
        const active = db.activeImageProvider;
        return settingKeys[active] && db[settingKeys[active]]?.enabled ? active
            : Object.keys(settingKeys).find(key => db[settingKeys[key]]?.enabled) || '';
    }

    function supported(engine, settings = {}) {
        if (engine === 'novelai') return /^nai-diffusion-4-5-(?:full|curated)$/.test(settings.model || 'nai-diffusion-4-curated-preview');
        if (engine === 'gpt') return /^gpt-image-/.test(settings.model || 'dall-e-3');
        if (engine === 'google') return /gemini.*image/i.test(settings.model || 'gemini-3.1-flash-image');
        return false;
    }

    function parsePrompt(value) {
        const text = String(value || '');
        const markers = [...text.matchAll(/\bovo_subject_(self|other)\b/gi)].map(match => match[1].toLowerCase());
        return {
            // 有冲突或缺少主体标记时不猜人物，历史消息保持普通生图行为。
            subject: markers.length && markers.every(value => value === 'self') ? 'self' : 'other',
            prompt: text.replace(/\bovo_subject_(?:self|other)\b/gi, '').replace(/[,，]\s*[,，]/g, ', ').replace(/^[,，\s]+|[,，\s]+$/g, '').trim()
        };
    }

    function subjectInstruction() {
        return '人物参考内部标记：只有发送者本人单独出镜（自拍、单人人像）时，在 {{英文生图提示词}} 末尾加 , ovo_subject_self；风景、食物、宠物、其他人物、多人合照均加 , ovo_subject_other。标记只写在双花括号内，中文描述不出现标记。';
    }

    function messageCharacter(chat, chatType, message) {
        if (!message || message.role === 'user') return null;
        if (chatType === 'private') return chat;
        const member = chat?.members?.find(item => item.id === message.senderId);
        return (db.characters || []).find(item => item.id === member?.originalCharId) || null;
    }

    function capture(character, subject, engine = provider()) {
        const settings = clone(db[settingKeys[engine]]);
        settings._hasCharacterContext = true;
        settings._character = character ? { id: character.id, gptArtistPrompt: character.gptArtistPrompt || '', gptImageSizeOverride: character.gptImageSizeOverride || '' } : null;
        if (character?.imageFaceLock?.enabled && subject === 'self') {
            settings._faceLock = { characterId: character.id, referenceImage: character.imageFaceLock.referenceImage || '' };
        }
        if (engine === 'novelai') {
            settings._referenceSnapshot = { vibe: clone(db.novelAiVibeSettings), precise: clone(db.novelAiPreciseReferenceSettings) };
        }
        return { provider: engine, settings };
    }

    async function normalizeImage(source, signal) {
        if (!source) throw new Error('人物参考图为空，请在角色设置中上传图片');
        let blob;
        if (source instanceof Blob) blob = source;
        else {
            if (!/^(?:https?:\/\/|data:image\/)/i.test(String(source))) throw new Error('人物参考图片格式无效，请重新上传');
            const response = await fetch(source, { signal });
            if (!response.ok) throw new Error('无法读取人物参考图，请改为上传图片');
            blob = await response.blob();
        }
        if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(blob.type)) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
        // GIF 取首帧；统一为 JPEG，避免各接口格式差异和透明背景影响。
        if (blob.type === 'image/gif') blob = new Blob([blob], { type: 'image/png' });
        return compressImage(blob, { quality: 0.95, maxWidth: 1536, maxHeight: 1536 });
    }

    async function reference(settings, engine, signal) {
        const lock = settings._faceLock;
        if (!lock) return null;
        if (!supported(engine, settings)) throw new Error('当前生图模型不支持锁脸，请选择支持人物参考的模型，或关闭该角色的生图锁脸');
        if (!lock.referenceImage) throw new Error('人物参考图已丢失，请在角色设置中重新上传');
        let dataUrl = lock.referenceImage;
        if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)) {
            dataUrl = referenceCache.get(lock.referenceImage);
            if (!dataUrl) {
                dataUrl = await normalizeImage(lock.referenceImage, signal);
                if (referenceCache.size >= 4) referenceCache.delete(referenceCache.keys().next().value);
                referenceCache.set(lock.referenceImage, dataUrl);
            }
        }
        const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
        if (!match) throw new Error('人物参考图无效，请重新上传');
        return { dataUrl, mimeType: match[1], data: match[2], characterId: lock.characterId };
    }

    function renderDraft() {
        if (!draft) return;
        el('setting-face-lock-enabled').checked = draft.enabled;
        el('setting-face-lock-reference').hidden = !draft.enabled;
        const image = el('setting-face-lock-preview');
        image.hidden = !draft.referenceImage;
        if (draft.referenceImage) image.src = draft.referenceImage;
        else image.removeAttribute('src');
        el('setting-face-lock-empty').hidden = !!draft.referenceImage;
        el('setting-face-lock-change').textContent = draft.referenceImage ? '更换' : '上传参考图';
        el('setting-face-lock-change').disabled = draft.busy;
        el('setting-face-lock-enabled').disabled = draft.busy;
        const engine = provider();
        const settings = { ...db[settingKeys[engine]] };
        if (engine === 'novelai' && el('novelai-model')?.value) settings.model = el('novelai-model').value;
        el('setting-face-lock-status').textContent = draft.busy ? '正在保存参考图片…'
            : !engine ? '请先在 API 设置中启用生图服务。'
            : !supported(engine, settings) ? '当前模型不支持锁脸，请在 API 设置中选择支持人物参考的模型。'
            : engine === 'novelai' ? '锁脸图片使用角色参考，不叠加全局参考与 VIBE；参考图片可能额外计费。'
            : '当前模型可使用人物参考；第三方接口需支持图片输入，参考图片可能额外计费。';
    }

    async function setReference(source, target = draft) {
        if (!target || target.busy) return;
        target.busy = true;
        renderDraft();
        try {
            const image = await normalizeImage(source);
            if (draft !== target) return;
            target.referenceImage = image;
            showToast('参考图已选定，保存设置后生效');
        } catch (error) {
            if (draft === target) showToast(error.message || '无法读取参考图，请重新上传');
        } finally {
            target.busy = false;
            if (draft === target) renderDraft();
        }
    }

    function loadSettings(character) {
        if (!el('setting-face-lock-enabled')) return;
        draft = { characterId: character.id, enabled: !!character.imageFaceLock?.enabled, referenceImage: character.imageFaceLock?.referenceImage || '', busy: false };
        const toggle = el('setting-face-lock-enabled');
        toggle.onchange = async () => {
            if (!draft || draft.characterId !== character.id) return;
            draft.enabled = toggle.checked;
            renderDraft();
            if (draft.enabled && !draft.referenceImage) {
                const avatar = el('setting-char-avatar-preview')?.getAttribute('src') || character.avatar;
                if (avatar) await setReference(avatar);
            }
        };
        const file = el('setting-face-lock-file');
        const menu = el('setting-face-lock-source');
        el('setting-face-lock-change').onclick = () => {
            if (!draft || draft.busy) return;
            if (!draft.referenceImage) { uploadTarget = draft; file.click(); }
            else { menu.value = ''; window.openCenteredSelect(menu); }
        };
        menu.onchange = () => {
            if (menu.value === 'upload') { uploadTarget = draft; file.click(); }
            if (menu.value === 'avatar') {
                const avatar = el('setting-char-avatar-preview')?.getAttribute('src') || character.avatar;
                if (avatar) setReference(avatar);
                else showToast('当前角色没有头像，请上传参考图');
            }
            menu.value = '';
        };
        file.onchange = () => {
            if (file.files?.[0] && uploadTarget === draft) setReference(file.files[0], uploadTarget);
            file.value = '';
            uploadTarget = null;
        };
        const modelSelect = el('novelai-model');
        if (modelSelect && !modelSelect.dataset.faceLockBound) {
            modelSelect.dataset.faceLockBound = 'true';
            modelSelect.addEventListener('change', renderDraft);
        }
        renderDraft();
    }

    function saveSettings(character) {
        if (!draft || draft.characterId !== character.id) return;
        if (draft.busy) throw new Error('参考图还在处理，请稍后保存');
        if (draft.enabled && !draft.referenceImage) throw new Error('请先上传人物参考图，或关闭生图锁脸');
        character.imageFaceLock = { enabled: draft.enabled, referenceImage: draft.referenceImage };
    }

    window.OvoFaceLock = { provider, supported, parsePrompt, subjectInstruction, messageCharacter, capture, reference, loadSettings, saveSettings };
})();
