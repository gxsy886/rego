/**
 * Custom Image Generation API for Rego
 * Uses domain from config.json and custom request format
 */
const API = {
    domain: '',

    init(config) {
        // 从config中获取图片生成API域名
        this.domain = config.imageApi || config.domain || '';
        if (!this.domain) {
            console.warn("⚠️ No imageApi configured in config.json");
        }
    },

    async generateImage(prompt, options = {}, referenceImages = []) {
        if (!this.domain) {
            throw new Error("图片生成API域名未配置，请在 config.json 中设置 imageApi 字段");
        }

        // 构建请求URL
        const apiUrl = `https://${this.domain}/generate`;

        // Map resolution to imageSize format ('1K', '2K', '4K')
        let imageSize = '4K'; // Default 4K
        if (options.resolution) {
            if (options.resolution === '1024x1024' || options.resolution === '1K') imageSize = '1K';
            if (options.resolution === '2048x2048' || options.resolution === '2K') imageSize = '2K';
            if (options.resolution === '4K') imageSize = '4K';
        }

        // 构建images数组 - 支持URL和base64两种格式
        const images = referenceImages.map((img, index) => {
            // 对象格式（从uploadRefImagesToB2返回）
            if (typeof img === 'object' && img !== null) {
                // 优先使用URL
                if (img.url) {
                    return {
                        name: img.name || `image${index + 1}`,
                        mimeType: img.mimeType || 'image/png',
                        uri: img.url  // 使用url字段
                    };
                }
                // 降级使用data
                if (img.data) {
                    return {
                        name: img.name || `image${index + 1}`,
                        mimeType: img.mimeType || 'image/png',
                        data: img.data
                    };
                }
            }

            // 字符串格式（传统base64）
            const match = img.match(/^data:(image\/[a-zA-Z+]+);base64,/);
            const mimeType = match ? match[1] : "image/png";
            return {
                name: `image${index + 1}`,
                mimeType: mimeType,
                data: img
            };
        });

        // 构建请求体
        const requestBody = {
            prompt: prompt,
            aspectRatio: (options.aspectRatio && options.aspectRatio !== 'auto') ? options.aspectRatio : "16:9",
            imageSize: imageSize,
            images: images
        };

        console.log("🚀 Sending request to:", apiUrl);
        console.log("📦 Request body:", { ...requestBody, images: `[${images.length} images]` });

        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        // Changed: API now returns taskId immediately (202 status)
        if (!res.ok && res.status !== 202) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || err.message || `API Error: ${res.status}`);
        }

        const data = await res.json();

        // New format: API returns taskId and initial progress
        if (data.taskId) {
            console.log("✅ Task created:", data.taskId, "Progress:", data.progress + "%");
            return {
                taskId: data.taskId,
                status: data.status || 'pending',
                progress: data.progress || 25,
                prompt
            };
        }

        throw new Error("API未返回taskId");
    },

    async getTaskStatus(taskId) {
        if (!this.domain) {
            throw new Error("图片生成API域名未配置");
        }

        const apiUrl = `https://${this.domain}/task/${taskId}`;

        const res = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Task query failed: ${res.status}`);
        }

        return await res.json();
    }
};
window.API = API;
