/**
 * 生产环境管理员后台
 * 使用真实API替代localStorage
 */

const Admin = {
    apiBase: '',
    token: null,

    async init() {
        // 加载配置
        await this.loadConfig();

        // 检查认证
        this.token = localStorage.getItem('jwt_token');
        if (!this.token) {
            window.location.href = 'index.html';
            return;
        }

        // 加载数据
        await this.loadUsers();
        await this.loadCodes();

        // 应用主题
        this.applyTheme();
    },

    async loadConfig() {
        try {
            const res = await fetch('config.json');
            const config = await res.json();
            this.apiBase = `https://${config.authApi}`;
        } catch (e) {
            console.error('Failed to load config:', e);
            alert('配置加载失败');
        }
    },

    async apiCall(path, options = {}) {
        const response = await fetch(`${this.apiBase}${path}`, {
            ...options,
            headers: {
                ...options.headers,
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                alert('认证失败,请重新登录');
                window.location.href = 'index.html';
                return null;
            }
            const error = await response.json();
            throw new Error(error.error || '请求失败');
        }

        return await response.json();
    },

    async loadUsers() {
        try {
            const data = await this.apiCall('/api/users');
            if (!data) return;

            this.renderUsers(data.users);
        } catch (e) {
            console.error('Failed to load users:', e);
            alert('用户列表加载失败: ' + e.message);
        }
    },

    renderUsers(users) {
        const tbody = document.getElementById('user-table-body');

        if (!users || users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 2rem; color: var(--text-tertiary);">暂无用户</td></tr>';
            return;
        }

        tbody.innerHTML = users.map((user) => `
            <tr>
                <td>${this.escapeHtml(user.username)}</td>
                <td><span class="badge ${user.role === 'admin' ? 'badge-admin' : 'badge-user'}">${user.role === 'admin' ? '管理员' : '用户'}</span></td>
                <td>${user.quota || 0}</td>
                <td>${user.used || 0}</td>
                <td>${(user.quota || 0) - (user.used || 0)}</td>
                <td>
                    <button class="btn-secondary" style="padding: 0.5rem 1rem; margin-right: 0.5rem;" onclick="Admin.editUser(${user.id})">编辑配额</button>
                    <button class="btn-secondary" style="padding: 0.5rem 1rem; background: var(--error); color: white;" onclick="Admin.deleteUser(${user.id})">删除</button>
                </td>
            </tr>
        `).join('');
    },

    async loadCodes() {
        try {
            const data = await this.apiCall('/api/codes');
            if (!data) return;

            this.renderCodes(data.codes);
        } catch (e) {
            console.error('Failed to load codes:', e);
            alert('兑换码列表加载失败: ' + e.message);
        }
    },

    renderCodes(codes) {
        const tbody = document.getElementById('codes-table-body');

        if (!codes || codes.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem; color: var(--text-tertiary);">暂无兑换码</td></tr>';
            return;
        }

        tbody.innerHTML = codes.map(code => `
            <tr>
                <td><code style="background: var(--bg-tertiary); padding: 0.25rem 0.5rem; border-radius: 0.25rem;">${code.code}</code></td>
                <td>${code.quota}</td>
                <td>${code.used ? '<span style="color: var(--text-tertiary);">已使用</span>' : '<span style="color: var(--success);">未使用</span>'}</td>
                <td>${code.used_by || '-'}</td>
                <td>${new Date(code.created_at).toLocaleString()}</td>
            </tr>
        `).join('');
    },

    showCreateUserModal() {
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
                max-width: 500px;
            ">
                <h2 style="margin-bottom: 1.5rem; font-size: 1.5rem; font-weight: 700;">创建用户</h2>
                <form id="create-user-form">
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">用户名</label>
                        <input type="text" id="new-username" required style="
                            width: 100%;
                            padding: 0.75rem;
                            border: 1px solid var(--border-primary);
                            border-radius: var(--radius-lg);
                            background: var(--bg-secondary);
                            color: var(--text-primary);
                        ">
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">密码</label>
                        <input type="password" id="new-password" required style="
                            width: 100%;
                            padding: 0.75rem;
                            border: 1px solid var(--border-primary);
                            border-radius: var(--radius-lg);
                            background: var(--bg-secondary);
                            color: var(--text-primary);
                        ">
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">角色</label>
                        <select id="new-role" style="
                            width: 100%;
                            padding: 0.75rem;
                            border: 1px solid var(--border-primary);
                            border-radius: var(--radius-lg);
                            background: var(--bg-secondary);
                            color: var(--text-primary);
                        ">
                            <option value="user">用户</option>
                            <option value="admin">管理员</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 1.5rem;">
                        <label style="display: block; margin-bottom: 0.5rem; font-weight: 600;">初始配额</label>
                        <input type="number" id="new-quota" value="100" min="0" required style="
                            width: 100%;
                            padding: 0.75rem;
                            border: 1px solid var(--border-primary);
                            border-radius: var(--radius-lg);
                            background: var(--bg-secondary);
                            color: var(--text-primary);
                        ">
                    </div>
                    <div style="display: flex; gap: 1rem;">
                        <button type="button" onclick="this.closest('[style*=fixed]').remove()" style="
                            flex: 1;
                            padding: 0.75rem;
                            background: var(--bg-tertiary);
                            border: 1px solid var(--border-primary);
                            border-radius: var(--radius-lg);
                            font-weight: 600;
                            cursor: pointer;
                        ">取消</button>
                        <button type="submit" style="
                            flex: 1;
                            padding: 0.75rem;
                            background: var(--accent);
                            color: var(--bg-primary);
                            border: none;
                            border-radius: var(--radius-lg);
                            font-weight: 700;
                            cursor: pointer;
                        ">创建</button>
                    </div>
                </form>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('create-user-form').addEventListener('submit', async (e) => {
            e.preventDefault();

            const username = document.getElementById('new-username').value.trim();
            const password = document.getElementById('new-password').value;
            const role = document.getElementById('new-role').value;
            const quota = parseInt(document.getElementById('new-quota').value);

            try {
                // 计算密码哈希
                const hashedPassword = CryptoJS.SHA256(password).toString();

                await this.apiCall('/api/users', {
                    method: 'POST',
                    body: JSON.stringify({
                        username,
                        password: hashedPassword,
                        role,
                        quota
                    })
                });

                modal.remove();
                await this.loadUsers();
                alert('用户创建成功');
            } catch (e) {
                alert('创建失败: ' + e.message);
            }
        });
    },

    async editUser(id) {
        const newQuota = prompt('设置新配额:');

        if (newQuota !== null) {
            try {
                await this.apiCall(`/api/users/${id}`, {
                    method: 'PUT',
                    body: JSON.stringify({ quota: parseInt(newQuota) })
                });

                await this.loadUsers();
                alert('配额更新成功');
            } catch (e) {
                alert('更新失败: ' + e.message);
            }
        }
    },

    async deleteUser(id) {
        if (confirm('确定要删除此用户吗？')) {
            try {
                await this.apiCall(`/api/users/${id}`, {
                    method: 'DELETE'
                });

                await this.loadUsers();
                alert('用户删除成功');
            } catch (e) {
                alert('删除失败: ' + e.message);
            }
        }
    },

    async generateCodes(event) {
        event.preventDefault();

        const count = parseInt(document.getElementById('code-count').value);
        const quota = parseInt(document.getElementById('code-quota').value);

        try {
            const data = await this.apiCall('/api/codes', {
                method: 'POST',
                body: JSON.stringify({ count, quota })
            });

            await this.loadCodes();
            alert(`成功生成 ${count} 个兑换码`);
        } catch (e) {
            alert('生成失败: ' + e.message);
        }
    },

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

    logout() {
        localStorage.removeItem('jwt_token');
        window.location.href = 'index.html';
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

window.Admin = Admin;
window.onload = () => Admin.init();
