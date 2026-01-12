/**
 * 生产环境用户认证系统
 * 使用真实API而非localStorage模拟
 */

const Auth = {
    currentUser: null,
    apiBase: '', // 将从config加载

    async init() {
        // 加载配置获取API端点
        try {
            const res = await fetch('config.json');
            const config = await res.json();
            this.apiBase = `https://${config.authApi}`;
        } catch (e) {
            console.error('Failed to load config:', e);
        }

        // 尝试从 localStorage 恢复登录状态
        const token = localStorage.getItem('jwt_token');
        if (token) {
            try {
                // 验证token并获取用户信息
                const response = await fetch(`${this.apiBase}/api/auth/me`, {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    this.currentUser = data.user;
                    return true;
                }
            } catch (e) {
                console.error('Token validation failed:', e);
            }

            // Token无效,清除
            localStorage.removeItem('jwt_token');
        }

        return false;
    },

    async login(username, password) {
        try {
            // 计算密码SHA256哈希
            const hashedPassword = await this.hashPassword(password);

            // 调用登录API
            const response = await fetch(`${this.apiBase}/api/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    username,
                    password: hashedPassword
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || '登录失败');
            }

            const data = await response.json();

            // 保存token和用户信息
            localStorage.setItem('jwt_token', data.token);
            this.currentUser = data.user;

            return this.currentUser;
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    },

    async hashPassword(password) {
        // 使用CryptoJS计算SHA256
        return CryptoJS.SHA256(password).toString();
    },

    logout() {
        this.currentUser = null;
        localStorage.removeItem('jwt_token');
        // 刷新页面显示登录弹窗
        window.location.reload();
    },

    isLoggedIn() {
        return this.currentUser !== null;
    },

    isAdmin() {
        return this.currentUser && this.currentUser.role === 'admin';
    },

    getUser() {
        return this.currentUser;
    },

    getToken() {
        return localStorage.getItem('jwt_token');
    },

    async refreshQuota() {
        try {
            const response = await fetch(`${this.apiBase}/api/quota`, {
                headers: {
                    'Authorization': `Bearer ${this.getToken()}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                this.currentUser.quota = data.quota;
                this.currentUser.used = data.used;
            }
        } catch (e) {
            console.error('Failed to refresh quota:', e);
        }
    },

    getRemainingQuota() {
        if (!this.currentUser) return 0;
        return Math.max(0, this.currentUser.quota - this.currentUser.used);
    },

    canGenerate() {
        return this.getRemainingQuota() > 0;
    },

    async consumeQuota(count = 1) {
        if (!this.canGenerate()) {
            throw new Error('次数不足，请兑换或联系管理员');
        }

        try {
            const response = await fetch(`${this.apiBase}/api/quota/consume`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getToken()}`
                },
                body: JSON.stringify({ count })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || '配额消费失败');
            }

            const data = await response.json();

            // 更新本地配额
            this.currentUser.used += count;

            return data.remaining;
        } catch (error) {
            console.error('Consume quota error:', error);
            throw error;
        }
    },

    async redeemCode(code) {
        try {
            const response = await fetch(`${this.apiBase}/api/redeem`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getToken()}`
                },
                body: JSON.stringify({ code })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || '兑换失败');
            }

            const data = await response.json();

            // 刷新配额
            await this.refreshQuota();

            return {
                success: true,
                quota: data.quota,
                newTotal: this.currentUser.quota
            };
        } catch (error) {
            console.error('Redeem error:', error);
            throw error;
        }
    },

    showLoginModal() {
        // 创建登录弹窗
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        modal.innerHTML = `
            <div style="
                background: var(--bg-primary);
                border-radius: var(--radius-2xl);
                padding: 2rem;
                width: 90%;
                max-width: 400px;
                box-shadow: var(--shadow-2xl);
            ">
                <h2 style="margin-bottom: 1.5rem; font-size: 1.5rem; font-weight: 700;">登录 Rego</h2>
                <div style="margin-bottom: 1rem;">
                    <label style="display: block; margin-bottom: 0.5rem; font-size: 0.875rem; font-weight: 600;">用户名</label>
                    <input type="text" id="login-username" style="
                        width: 100%;
                        padding: 0.75rem;
                        border: 1px solid var(--border-primary);
                        border-radius: var(--radius-lg);
                        background: var(--bg-secondary);
                        color: var(--text-primary);
                        font-size: 1rem;
                    ">
                </div>
                <div style="margin-bottom: 1.5rem;">
                    <label style="display: block; margin-bottom: 0.5rem; font-size: 0.875rem; font-weight: 600;">密码</label>
                    <input type="password" id="login-password" style="
                        width: 100%;
                        padding: 0.75rem;
                        border: 1px solid var(--border-primary);
                        border-radius: var(--radius-lg);
                        background: var(--bg-secondary);
                        color: var(--text-primary);
                        font-size: 1rem;
                    " onkeypress="if(event.key==='Enter') document.getElementById('login-btn').click()">
                </div>
                <div id="login-error" style="color: var(--error); font-size: 0.875rem; margin-bottom: 1rem; display: none;"></div>
                <button id="login-btn" style="
                    width: 100%;
                    padding: 0.75rem;
                    background: var(--accent);
                    color: var(--bg-primary);
                    border: none;
                    border-radius: var(--radius-lg);
                    font-weight: 700;
                    cursor: pointer;
                    font-size: 1rem;
                ">登录</button>
            </div>
        `;

        document.body.appendChild(modal);

        // 绑定登录事件
        document.getElementById('login-btn').addEventListener('click', async () => {
            const username = document.getElementById('login-username').value.trim();
            const password = document.getElementById('login-password').value;
            const errorEl = document.getElementById('login-error');

            if (!username || !password) {
                errorEl.textContent = '请输入用户名和密码';
                errorEl.style.display = 'block';
                return;
            }

            try {
                document.getElementById('login-btn').textContent = '登录中...';
                document.getElementById('login-btn').disabled = true;

                await this.login(username, password);
                modal.remove();
                window.location.reload();
            } catch (error) {
                errorEl.textContent = error.message;
                errorEl.style.display = 'block';
                document.getElementById('login-btn').textContent = '登录';
                document.getElementById('login-btn').disabled = false;
            }
        });

        // 自动聚焦用户名输入框
        setTimeout(() => document.getElementById('login-username').focus(), 100);
    }
};

window.Auth = Auth;
