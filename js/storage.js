/**
 * 云端历史记录存储 for Rego
 * 使用后端 API 进行历史同步，支持多设备同步
 */
const Storage = {
    apiBase: '',

    async init() {
        // 获取 API 配置
        try {
            const res = await fetch('config.json');
            const config = await res.json();
            this.apiBase = `https://${config.authApi}`;
        } catch (e) {
            console.error('Failed to load config:', e);
        }

        // 本地设置仍使用 localStorage
        return Promise.resolve();
    },

    getToken() {
        return localStorage.getItem('jwt_token');
    },

    // ===== 设置相关 (本地存储) =====

    async setSetting(key, value) {
        localStorage.setItem(`setting_${key}`, JSON.stringify(value));
    },

    async getSetting(key) {
        const value = localStorage.getItem(`setting_${key}`);
        return value ? JSON.parse(value) : undefined;
    },

    // ===== 历史记录相关 (云端API) =====

    async saveSession(session) {
        try {
            const response = await fetch(`${this.apiBase}/api/history`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getToken()}`
                },
                body: JSON.stringify({
                    prompt: session.rawPrompt,
                    image_url: session.url,
                    options: session.options,
                    ref_images: session.refImages || []
                })
            });

            if (!response.ok) {
                throw new Error('Failed to save history');
            }

            const data = await response.json();
            return data.id || Date.now(); // 返回一个ID
        } catch (error) {
            console.error('Save session error:', error);
            // 失败时使用本地临时ID
            return Date.now();
        }
    },

    async getHistory() {
        try {
            const response = await fetch(`${this.apiBase}/api/history?limit=100`, {
                headers: {
                    'Authorization': `Bearer ${this.getToken()}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to fetch history');
            }

            const data = await response.json();

            // 转换为前端需要的格式
            return data.history.map(record => ({
                id: record.id,
                rawPrompt: record.prompt,
                url: record.image_url,
                options: record.options,
                refImages: record.ref_images,
                timestamp: record.created_at
            }));
        } catch (error) {
            console.error('Get history error:', error);
            return [];
        }
    },

    async deleteSession(id) {
        try {
            await fetch(`${this.apiBase}/api/history/${id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.getToken()}`
                }
            });
        } catch (error) {
            console.error('Delete session error:', error);
        }
    },

    async getSession(id) {
        // 从历史列表中获取
        const history = await this.getHistory();
        return history.find(session => session.id == id);
    },

    async updateSession(id, data) {
        // 暂不支持更新，可以重新保存
        console.warn('Update session not implemented in cloud storage');
    },

    // ===== 活跃任务追踪 (本地存储) =====

    saveActiveTask(taskId, taskData) {
        let tasks = this.getActiveTasks();

        // 清理超过24小时的任务
        const now = Date.now();
        tasks = tasks.filter(t => now - t.savedAt < 86400000); // 24小时

        // 限制最多20个活跃任务
        if (tasks.length >= 20) {
            tasks = tasks.slice(-19); // 保留最新的19个
        }

        tasks.push({ taskId, ...taskData, savedAt: now });
        localStorage.setItem('active_tasks', JSON.stringify(tasks));
    },

    getActiveTasks() {
        const tasks = localStorage.getItem('active_tasks');
        return tasks ? JSON.parse(tasks) : [];
    },

    removeActiveTask(taskId) {
        const tasks = this.getActiveTasks();
        const filtered = tasks.filter(t => t.taskId !== taskId);
        localStorage.setItem('active_tasks', JSON.stringify(filtered));
    }
};

window.Storage = Storage;
