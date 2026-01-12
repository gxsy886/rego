/**
 * Rego - 2026 Modern AI Image Generation Platform
 * Main Application Logic
 */

const App = {
    state: {
        refImages: [],
        config: null,
        activeSession: null,
        currentParams: {
            aspectRatio: '16:9',
            resolution: '4K',
            count: 1
        }
    },

    async init() {
        console.log('🚀 Rego 2026 Initializing...');

        try {
            // 加载主题
            this.applyTheme();

            await this.loadConfiguration();

            // 初始化认证
            const isLoggedIn = await Auth.init();
            if (!isLoggedIn) {
                Auth.showLoginModal();
                return;
            }

            await this.initializeModules();
            this.setupEventListeners();
            await this.renderHistory();
            this.updateEmptyState();
            this.updateUserInfo();

            // Recover active tasks after page refresh
            this.recoverActiveTasks();

            console.log('✅ Initialization complete');
        } catch (error) {
            console.error('❌ Initialization failed:', error);
            this.showToast('平台初始化失败，请检查配置', 'error');
        }
    },

    async loadConfiguration() {
        try {
            const res = await fetch('config.json');
            let data = await res.json();

            // Decryption Logic
            if (data._encrypted && data.data) {
                try {
                    const bytes = CryptoJS.AES.decrypt(data.data, 'rego_secure_config_v1');
                    const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
                    data = JSON.parse(decryptedStr);
                    console.log('🔒 Config decrypted successfully');
                } catch (e) {
                    console.error('Config Decryption Failed:', e);
                    throw e;
                }
            }

            this.state.config = data;
        } catch (e) {
            console.warn('⚠️ Could not load config.json', e);
            this.state.config = {};
        }
    },

    async initializeModules() {
        await Storage.init();
        API.init(this.state.config);
    },

    setupEventListeners() {
        // 文件输入
        document.getElementById('file-input')?.addEventListener('change', (e) => this.handleFiles(e.target.files));

        // 生成按钮
        document.getElementById('generate-btn')?.addEventListener('click', () => this.generate());

        // 字符计数
        document.getElementById('prompt-input')?.addEventListener('input', (e) => {
            const count = e.target.value.length;
            document.getElementById('char-count').textContent = `${count} / 2000`;
        });

        // 参数选项
        this.setupParamListeners('aspect-ratio-options', 'aspectRatio');
        this.setupParamListeners('resolution-options', 'resolution');
        this.setupParamListeners('count-options', 'count');

        // 初始化参数摘要
        this.updateParamsSummary();

        // 移动端默认折叠参数区域
        if (window.innerWidth <= 480) {
            const container = document.querySelector('.params-collapsible');
            if (container) container.classList.add('collapsed');
        }

        // 拖拽上传
        this.setupDragAndDrop();
    },

    setupParamListeners(elementId, paramName) {
        const container = document.getElementById(elementId);
        if (!container) return;

        container.querySelectorAll('.param-option').forEach(btn => {
            btn.addEventListener('click', () => {
                // 移除所有active类
                container.querySelectorAll('.param-option').forEach(b => b.classList.remove('active'));
                // 添加active类到当前按钮
                btn.classList.add('active');
                // 更新状态
                this.state.currentParams[paramName] = btn.dataset.value;
                // 更新摘要显示
                this.updateParamsSummary();
            });
        });
    },

    updateParamsSummary() {
        const summary = document.getElementById('params-summary');
        if (summary) {
            const { aspectRatio, resolution, count } = this.state.currentParams;
            summary.textContent = `${aspectRatio} · ${resolution} · ${count}张`;
        }
    },

    toggleParams() {
        const container = document.querySelector('.params-collapsible');
        if (container) {
            container.classList.toggle('collapsed');
        }
    },

    setupDragAndDrop() {
        const dropZone = document.getElementById('ref-grid');
        if (!dropZone) return;

        // 防止默认拖拽行为
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            document.body.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });

        // 拖拽高亮
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => {
                dropZone.classList.add('drag-over');
            }, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => {
                dropZone.classList.remove('drag-over');
            }, false);
        });

        // 处理文件
        dropZone.addEventListener('drop', (e) => {
            const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
            if (files.length > 0) {
                this.handleFiles(files);
            } else if (e.dataTransfer.files.length > 0) {
                this.showToast('请拖入图片文件', 'warning');
            }
        }, false);
    },

    async handleFiles(files) {
        const remaining = 14 - this.state.refImages.length;
        if (files.length > remaining) {
            this.showToast(`最多只能上传 ${remaining} 张参考图`, 'warning');
            return;
        }

        const loadPromises = Array.from(files).map(file => this.loadImageFile(file));
        await Promise.all(loadPromises);
        this.renderRefGrid();
    },

    async loadImageFile(file) {
        return new Promise(async (resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                const base64 = e.target.result;

                // 检查数量限制
                if (this.state.refImages.length >= 14) {
                    this.showToast('最多添加14张参考图', 'warning');
                    resolve();
                    return;
                }

                // 创建临时占位元素显示上传进度
                const tempIndex = this.state.refImages.length;
                this.state.refImages.push({ uploading: true, progress: 0 });
                this.renderRefGrid();

                // 立即上传到B2
                try {

                    const token = Auth.getToken();
                    const config = await this.getConfig();
                    const apiBase = `https://${config.authApi}`;

                    let mimeType = 'image/png';
                    if (base64.startsWith('data:')) {
                        const match = base64.match(/^data:(image\/[a-zA-Z+]+);base64,/);
                        if (match) mimeType = match[1];
                    }

                    const response = await fetch(`${apiBase}/api/upload/image`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ image: base64, mimeType })
                    });

                    // 更新进度到70%
                    this.state.refImages[tempIndex].progress = 70;
                    this.renderRefGrid();

                    if (response.ok) {
                        const data = await response.json();
                        // 替换临时元素为实际URL
                        this.state.refImages[tempIndex] = {
                            url: data.url,
                            mimeType: mimeType,
                            name: `image${tempIndex + 1}`
                        };
                        this.renderRefGrid();
                        this.showToast('参考图上传成功', 'success');
                    } else {
                        // 获取详细错误信息
                        const errorData = await response.json().catch(() => ({}));
                        console.warn('B2 upload failed:', errorData);
                        throw new Error(errorData.error || '上传失败');
                    }
                } catch (error) {
                    console.error('Upload failed:', error);
                    // 降级：替换为base64而非push
                    this.state.refImages[tempIndex] = base64;
                    this.renderRefGrid();

                    // 显示友好提示
                    if (error.message.includes('B2') || error.message.includes('Missing')) {
                        this.showToast('B2未配置，使用本地缓存', 'warning');
                    } else {
                        this.showToast('使用本地缓存（上传失败）', 'warning');
                    }
                }

                resolve();
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    },

    renderRefGrid() {
        const grid = document.getElementById('ref-grid');
        const addButton = `
            <div class="ref-item ref-add" onclick="document.getElementById('file-input').click()">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                <span>添加</span>
            </div>
        `;

        const images = this.state.refImages.map((item, idx) => {
            // 检查是否正在上传
            if (item.uploading) {
                return `
                <div class="ref-item ref-uploading">
                    <div class="ref-upload-progress">
                        <div class="upload-progress-bar">
                            <div class="upload-progress-fill" style="width: ${item.progress}%"></div>
                        </div>
                        <div class="upload-progress-text">上传中 ${item.progress}%</div>
                    </div>
                </div>
            `;
            }

            // 支持对象格式（{url, mimeType, name}）和字符串格式（base64）
            const src = typeof item === 'object' ? item.url : item;

            return `
            <div class="ref-item" draggable="true" data-index="${idx}" 
                 ondragstart="App.handleDragStart(event)" 
                 ondragover="App.handleDragOver(event)"
                 ondrop="App.handleDrop(event)"
                 ondragend="App.handleDragEnd(event)">
                <img src="${src}" alt="Reference ${idx + 1}">
                <div class="ref-label">${idx + 1}</div>
                <div class="ref-remove" onclick="App.removeRef(${idx})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </div>
            </div>
        `;
        }).join('');

        grid.innerHTML = addButton + images;
        document.getElementById('ref-counter').textContent = `${this.state.refImages.length}/14`;
    },

    removeRef(idx) {
        this.state.refImages.splice(idx, 1);
        this.renderRefGrid();
    },

    handleDragStart(e) {
        // 使用closest确保从父容器获取data-index，而不是子元素
        const container = e.target.closest('.ref-item');
        if (!container || !container.dataset.index) return;

        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', container.innerHTML);
        this.state.draggedIndex = parseInt(container.dataset.index);
        container.style.opacity = '0.4';
    },

    handleDragOver(e) {
        if (e.preventDefault) e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        return false;
    },

    handleDrop(e) {
        if (e.stopPropagation) e.stopPropagation();
        e.preventDefault();

        const dropIndex = parseInt(e.currentTarget.dataset.index);
        const dragIndex = this.state.draggedIndex;

        // 确保索引有效
        if (dragIndex === undefined || dragIndex === dropIndex) {
            return false;
        }

        // 确保索引在有效范围内
        if (dragIndex < 0 || dragIndex >= this.state.refImages.length ||
            dropIndex < 0 || dropIndex >= this.state.refImages.length) {
            return false;
        }

        // 使用数组重排而不是splice来避免undefined问题
        const items = [...this.state.refImages];
        const [draggedItem] = items.splice(dragIndex, 1);
        items.splice(dropIndex, 0, draggedItem);
        this.state.refImages = items;

        this.renderRefGrid();

        return false;
    },

    handleDragEnd(e) {
        const container = e.target.closest('.ref-item');
        if (container) container.style.opacity = '1';
        this.state.draggedIndex = undefined;
    },

    newChat() {
        this.state.refImages = [];
        this.renderRefGrid();
        document.getElementById('prompt-input').value = '';
        document.getElementById('char-count').textContent = '0 / 2000';
        document.getElementById('result-area').innerHTML = '';
        this.updateEmptyState();
        this.toggleHistory();
    },

    async generate(customPrompt = null) {
        const prompt = customPrompt || document.getElementById('prompt-input')?.value.trim();

        if (!prompt) {
            this.showToast('请先输入提示词', 'warning');
            return;
        }

        const { aspectRatio, resolution, count } = this.state.currentParams;

        // 检查用户配额
        if (!Auth.canGenerate()) {
            this.showToast('次数不足，请使用兑换码或联系管理员', 'error');
            return;
        }

        const totalCount = parseInt(count);
        if (Auth.getRemainingQuota() < totalCount) {
            this.showToast(`剩余次数不足，需要 ${totalCount} 次，当前剩余 ${Auth.getRemainingQuota()} 次`, 'error');
            return;
        }

        const options = {
            aspectRatio,
            resolution
        };

        // 隐藏空状态
        this.updateEmptyState();

        // 并发生成
        const refImages = [...this.state.refImages];
        for (let i = 0; i < totalCount; i++) {
            this.executeGeneration(prompt, options, refImages);
        }

        // 清空输入
        if (!customPrompt) {
            document.getElementById('prompt-input').value = '';
            document.getElementById('char-count').textContent = '0 / 2000';
            this.state.refImages = [];
            this.renderRefGrid();
        }
    },

    async executeGeneration(prompt, options, refImages) {
        const cardId = this.generateUniqueId();
        this.createLoadingCard(cardId, prompt);

        try {
            // Changed: API now returns taskId immediately
            this.updateLoadingCard(cardId, '正在创建任务...', 0);
            const result = await API.generateImage(prompt, options, refImages);

            // Save taskId to localStorage for recovery
            Storage.saveActiveTask(result.taskId, {
                prompt,
                options,
                refImages,
                cardId
            });

            // Start polling task status
            this.pollTaskStatus(result.taskId, cardId, prompt, options, refImages);

        } catch (error) {
            console.error('Generation error:', error);
            this.showErrorCard(cardId, error.message);
        }
    },

    async pollTaskStatus(taskId, cardId, prompt, options, refImages) {
        let attempts = 0;
        const MAX_ATTEMPTS = 120; // 3分钟超时 (120 * 1.5s = 180s)

        const poll = async () => {
            // 超时检查
            if (attempts++ > MAX_ATTEMPTS) {
                this.showErrorCard(cardId, '任务超时，请重试');
                Storage.removeActiveTask(taskId);
                console.warn(`Task ${taskId} timed out after ${MAX_ATTEMPTS} attempts`);
                return;
            }

            try {
                const status = await API.getTaskStatus(taskId);

                if (status.status === 'completed') {
                    // Task complete, show result
                    const finalUrl = status.result.url;

                    const session = {
                        timestamp: Date.now(),
                        rawPrompt: prompt,
                        url: finalUrl,
                        storageMode: 'url',
                        options: options,
                        channel: 'Vertex AI',
                        referenceCount: refImages.length,
                        refImages: refImages.map(img => {
                            return typeof img === 'object' ? img.url : img;
                        })
                    };

                    const sessionId = await Storage.saveSession(session);
                    Storage.setSetting('last_viewed_session_id', sessionId);
                    this.updateResultCard(cardId, finalUrl, { ...session, id: sessionId });
                    this.renderHistory();

                    // Remove from active tasks
                    Storage.removeActiveTask(taskId);

                    // Consume quota
                    await Auth.consumeQuota(1);
                    this.updateUserInfo();

                    return; // Stop polling
                }

                if (status.status === 'failed') {
                    // Task failed
                    this.showErrorCard(cardId, status.error || '生成失败');
                    Storage.removeActiveTask(taskId);
                    return; // Stop polling
                }

                // Update progress
                this.updateLoadingCard(cardId, this.getProgressText(status.progress), status.progress);

                // Continue polling
                setTimeout(poll, 1500); // 1.5 second interval

            } catch (error) {
                console.error('Poll error:', error);

                // 如果超过10次错误，停止轮询
                if (attempts > 10) {
                    this.showErrorCard(cardId, '网络错误，请刷新重试');
                    Storage.removeActiveTask(taskId);
                    return;
                }

                // Retry polling on error
                setTimeout(poll, 2000);
            }
        };

        poll();
    },

    getProgressText(progress) {
        if (progress <= 25) return '正在处理请求...';
        if (progress <= 50) return '正在调用 AI 模型...';
        if (progress <= 75) return '正在上传到云存储...';
        return '即将完成...';
    },

    generateUniqueId() {
        return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    },

    async uploadRefImagesToB2(refImages, cardId) {
        const uploaded = [];
        const total = refImages.length;

        for (let i = 0; i < refImages.length; i++) {
            const img = refImages[i];

            this.updateLoadingCard(cardId, `上传参考图 ${i + 1}/${total}...`);

            try {
                const token = Auth.getToken();
                const config = await this.getConfig();
                const apiBase = `https://${config.authApi}`;

                let mimeType = 'image/png';
                if (img.startsWith('data:')) {
                    const match = img.match(/^data:(image\/[a-zA-Z+]+);base64,/);
                    if (match) mimeType = match[1];
                }

                const response = await fetch(`${apiBase}/api/upload/image`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ image: img, mimeType })
                });

                if (!response.ok) throw new Error(`上传失败: ${response.status}`);

                const data = await response.json();
                uploaded.push({
                    name: `image${i + 1}`,
                    url: data.url,
                    mimeType
                });

            } catch (error) {
                console.error(`Upload ref image ${i + 1} failed:`, error);
                // 降级：使用base64
                uploaded.push({ name: `image${i + 1}`, data: img, mimeType: 'image/png' });
            }
        }

        return uploaded;
    },

    async getConfig() {
        if (!this.state.config) {
            const res = await fetch('config.json');
            this.state.config = await res.json();
        }
        return this.state.config;
    },

    updateLoadingCard(cardId, text, progress) {
        const card = document.getElementById(cardId);
        if (!card) return;
        const textEl = card.querySelector('.loading-text');
        if (textEl) textEl.textContent = text;

        // Update progress bar if provided
        if (progress !== undefined) {
            const progressBar = card.querySelector('.progress-fill');
            const progressText = card.querySelector('.progress-percent');
            if (progressBar) progressBar.style.width = `${progress}%`;
            if (progressText) progressText.textContent = `${progress}%`;
        }
    },

    createLoadingCard(cardId, prompt) {
        const area = document.getElementById('result-area');
        const card = document.createElement('div');
        card.id = cardId;
        card.className = 'loading-card fade-in';
        card.innerHTML = `
            <div class="loading-spinner"></div>
            <div class="loading-text">AI 正在创作中...</div>
            <div class="loading-prompt">${this.escapeHtml(prompt)}</div>
            <div class="progress-container">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: 0%"></div>
                </div>
                <div class="progress-percent">0%</div>
            </div>
        `;
        area.insertBefore(card, area.firstChild);
    },

    recoverActiveTasks() {
        const tasks = Storage.getActiveTasks();
        console.log(`🔄 Recovering ${tasks.length} active tasks...`);

        for (const task of tasks) {
            const cardId = task.cardId || this.generateUniqueId();
            this.createLoadingCard(cardId, task.prompt);
            this.pollTaskStatus(task.taskId, cardId, task.prompt, task.options, task.refImages || []);
        }
    },

    showErrorCard(cardId, errorMessage) {
        const card = document.getElementById(cardId);
        if (!card) return;
        card.className = 'loading-card fade-in';
        card.innerHTML = `
            <div style="color: var(--error); font-size: 2rem; margin-bottom: 1rem;">⚠️</div>
            <div class="loading-text" style="color: var(--error);">生成失败</div>
            <div class="loading-prompt">${this.escapeHtml(errorMessage)}</div>
        `;
    },

    updateResultCard(cardId, url, data) {
        const card = document.getElementById(cardId);
        if (!card) return;
        if (!data.id && card.dataset.id) data.id = card.dataset.id;
        this.fillCard(card, url, data);
    },

    fillCard(card, url, data) {
        if (data.id) card.dataset.id = data.id;

        const escapedPrompt = this.escapeHtml(data.prompt || data.rawPrompt || '');
        const id = data.id || '';

        card.className = 'result-card';
        card.innerHTML = `
            <div class="result-img-container">
                <img src="${url}" class="result-img" alt="Generated Image" loading="lazy" onclick="window.open('${url}')">
            </div>
            <div class="result-info">
                <div class="result-prompt">${escapedPrompt}</div>
                <div class="result-meta">
                    <span class="result-channel">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="2" y1="12" x2="22" y2="12"/>
                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                        </svg>
                        ${this.escapeHtml(data.channel || 'API')}
                    </span>
                    <div class="result-actions">
                        <button class="result-action-btn" onclick="App.copyPrompt('${id}')" title="复制提示词">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                            </svg>
                            复制
                        </button>
                        <button class="result-action-btn" onclick="App.redo('${id}')" title="重新生成">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="23 4 23 10 17 10"/>
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                            </svg>
                            重绘
                        </button>
                        <button class="result-action-btn" onclick="App.edit('${id}')" title="编辑">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            编辑
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    async redo(id) {
        if (!id) return;
        try {
            const session = await Storage.getSession(id);
            if (session && session.prompt) {
                this.generate(session.prompt);
            }
        } catch (e) {
            console.error('Redo failed', e);
            this.showToast('无法获取历史记录', 'error');
        }
    },

    async edit(id) {
        if (!id) return;
        try {
            const session = await Storage.getSession(id);
            if (!session) return;

            // 恢复提示词
            const input = document.getElementById('prompt-input');
            input.value = session.prompt || session.rawPrompt || '';
            const count = input.value.length;
            document.getElementById('char-count').textContent = `${count} / 2000`;

            // 恢复参考图
            if (session.refImages && Array.isArray(session.refImages)) {
                this.state.refImages = [...session.refImages];
                this.renderRefGrid();
            } else {
                this.state.refImages = [];
                this.renderRefGrid();
            }

            input.focus();
            input.scrollIntoView({ behavior: 'smooth', block: 'center' });

        } catch (e) {
            console.error('Edit failed', e);
            this.showToast('无法加载历史记录', 'error');
        }
    },

    async copyPrompt(id) {
        if (!id) return;
        try {
            const session = await Storage.getSession(id);
            if (session && session.prompt) {
                const input = document.getElementById('prompt-input');
                input.value = session.prompt;
                const count = input.value.length;
                document.getElementById('char-count').textContent = `${count} / 2000`;
                input.focus();
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                this.showToast('提示词已复制到输入框', 'success');
            }
        } catch (e) {
            console.error('Copy failed', e);
        }
    },

    async renderHistory() {
        const list = document.getElementById('history-list');
        const items = await Storage.getHistory();

        if (!items.length) {
            list.innerHTML = `
                <div style="padding: 3rem 1.5rem; text-align: center; color: var(--neutral-400);">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin: 0 auto 1rem; opacity: 0.5;">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    <div style="font-size: 0.875rem;">暂无历史记录</div>
                </div>
            `;
            return;
        }

        // 按日期分组
        const groups = {
            '今天': [],
            '昨天': [],
            '过去 7 天': [],
            '更早': []
        };

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const yesterday = today - 86400000;
        const lastWeek = today - 86400000 * 7;

        items.forEach(item => {
            const t = item.timestamp;
            if (t >= today) groups['今天'].push(item);
            else if (t >= yesterday) groups['昨天'].push(item);
            else if (t >= lastWeek) groups['过去 7 天'].push(item);
            else groups['更早'].push(item);
        });

        let html = '';
        for (const [label, groupItems] of Object.entries(groups)) {
            if (groupItems.length === 0) continue;

            html += `<div class="history-group-label">${label}</div>`;
            html += groupItems.map(item => {
                const prompt = this.escapeHtml(item.rawPrompt || item.prompt || '无标题');
                return `
                    <div class="history-item" data-item-id="${item.id}" onclick="App.loadHistoryItemById('${item.id}')">
                        <img src="${item.url}" class="history-thumb" alt="">
                        <div class="history-info">
                            <div class="history-title">${prompt}</div>
                            <div class="history-time">${new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                        <div class="delete-history" onclick="event.stopPropagation(); App.deleteHistoryItem('${item.id}')" title="删除">×</div>
                    </div>
                `;
            }).join('');
        }

        list.innerHTML = html;

        // 高亮当前激活项
        const lastId = await Storage.getSetting('last_viewed_session_id');
        if (lastId) {
            const activeEl = list.querySelector(`.history-item[data-item-id="${lastId}"]`);
            if (activeEl) activeEl.classList.add('active');
        }
    },

    async loadHistoryItemById(id) {
        const session = await Storage.getSession(id);
        if (session) {
            this.loadHistoryItem(session);
        }
    },

    async deleteHistoryItem(id) {
        if (confirm('确定要删除此条历史记录吗？')) {
            await Storage.deleteSession(isNaN(id) ? id : Number(id));
            this.renderHistory();

            // 如果删除的是当前显示的，则清空结果区
            const currentId = await Storage.getSetting('last_viewed_session_id');
            if (currentId == id) {
                document.getElementById('result-area').innerHTML = '';
                this.updateEmptyState();
            }
        }
    },

    loadHistoryItem(item) {
        const resultArea = document.getElementById('result-area');
        resultArea.innerHTML = '';

        const card = document.createElement('div');
        card.className = 'result-card fade-in';
        this.fillCard(card, item.url, {
            id: item.id,
            channel: item.channel,
            rawPrompt: item.rawPrompt,
            prompt: item.prompt
        });
        resultArea.appendChild(card);

        // 标记为激活
        document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
        document.querySelector(`.history-item[data-item-id="${item.id}"]`)?.classList.add('active');

        Storage.setSetting('last_viewed_session_id', item.id);
        this.updateEmptyState();
    },

    updateEmptyState() {
        const resultArea = document.getElementById('result-area');
        const emptyState = document.getElementById('empty-state');
        const hasResults = resultArea.querySelector('.result-card, .loading-card');

        if (emptyState) {
            emptyState.style.display = hasResults ? 'none' : 'flex';
        }
    },

    toggleHistory() {
        const sidebar = document.getElementById('history-sidebar');
        const overlay = document.getElementById('overlay');

        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');
    },

    showToast(message, type = 'info') {
        const toast = document.createElement('div');

        // 根据类型设置背景色和字体色
        let bgColor, textColor;
        if (type === 'error') {
            bgColor = 'var(--error)';
            textColor = 'white';
        } else if (type === 'warning') {
            bgColor = 'var(--warning)';
            textColor = 'white';
        } else if (type === 'success') {
            bgColor = 'var(--success)';
            textColor = 'var(--text-primary)';
        } else {
            bgColor = 'var(--bg-tertiary)';
            textColor = 'var(--text-primary)';
        }

        toast.style.cssText = `
            position: fixed;
            top: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: ${bgColor};
            color: ${textColor};
            padding: 1rem 1.5rem;
            border-radius: var(--radius-xl);
            font-size: 0.9375rem;
            font-weight: 500;
            z-index: 10000;
            box-shadow: var(--shadow-2xl);
            animation: slideDown 0.3s var(--ease-out);
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.2s var(--ease-in)';
            setTimeout(() => toast.remove(), 200);
        }, 3000);
    },

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    // 主题切换
    toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    },

    applyTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
    },

    // 更新用户信息显示
    updateUserInfo() {
        const user = Auth.getUser();
        if (!user) return;

        const userInfo = document.getElementById('user-info');
        const userQuota = document.getElementById('user-quota');
        const userName = document.getElementById('user-name');

        userInfo.style.display = 'flex';
        userQuota.textContent = `剩余: ${Auth.getRemainingQuota()}`;
        userName.textContent = user.username;
    },

    // 兑换码功能
    async redeemCode() {
        const code = document.getElementById('redeem-code').value.trim();
        if (!code) {
            this.showToast('请输入兑换码', 'warning');
            return;
        }

        try {
            const result = await Auth.redeemCode(code);
            document.getElementById('redeem-code').value = '';
            this.updateUserInfo();
            this.showToast(`兑换成功! 获得 ${result.quota} 次使用`, 'success');
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    }
};

// 初始化应用
window.App = App;
window.onload = () => App.init();
