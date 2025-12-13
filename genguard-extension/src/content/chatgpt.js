// GenGuard Content Script for ChatGPT
// Lightweight version - uses Python backend API

(function () {
    'use strict';

    const API_BASE = 'http://localhost:5001';

    // State
    let currentAnalysis = null;
    let debounceTimer = null;
    let overlayElement = null;

    // Selectors
    const SELECTORS = {
        textArea: '#prompt-textarea, textarea[data-id="root"]',
        sendButton: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
        fileInput: 'input[type="file"]'
    };

    // Initialize
    function init() {
        console.log('[GenGuard] Initializing ChatGPT monitoring...');
        checkBackendHealth();
        waitForElement(SELECTORS.textArea).then(setupMonitoring);
    }

    // Check backend health
    async function checkBackendHealth() {
        try {
            const response = await fetch(`${API_BASE}/health`);
            if (response.ok) {
                console.log('[GenGuard] ✓ Backend connected');
            }
        } catch (e) {
            console.warn('[GenGuard] ⚠ Backend not available');
            showToast('⚠ GenGuard backend not running', 'warning');
        }
    }

    // Wait for element
    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);

            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) { observer.disconnect(); resolve(el); }
            });

            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); reject(); }, timeout);
        });
    }

    // Setup monitoring
    function setupMonitoring() {
        document.addEventListener('input', handleInput, true);
        document.addEventListener('paste', handlePaste, true);
        document.addEventListener('change', handleFileChange, true);
        console.log('[GenGuard] ChatGPT monitoring active');
    }

    // Handle input
    function handleInput(event) {
        const target = event.target;
        if (!target.matches || !target.matches(SELECTORS.textArea)) return;

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => analyzeInput(target), 300);
    }

    // Handle paste
    function handlePaste(event) {
        const items = event.clipboardData?.items;
        if (items) {
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) analyzeImageFile(file);
                }
            }
        }
        setTimeout(() => {
            const target = event.target;
            if (target.matches && target.matches(SELECTORS.textArea)) {
                analyzeInput(target);
            }
        }, 100);
    }

    // Handle file change
    function handleFileChange(event) {
        const target = event.target;
        if (!target.matches || !target.matches(SELECTORS.fileInput)) return;

        for (const file of target.files) {
            if (file.type.startsWith('image/')) {
                analyzeImageFile(file);
            } else if (file.type === 'text/plain') {
                file.text().then(text => analyzeTextWithBackend(text, file.name));
            }
        }
    }

    // Analyze image file via backend
    async function analyzeImageFile(file) {
        try {
            showToast('🔍 Running PaddleOCR...', 'info');

            const base64 = await fileToBase64(file);

            const response = await fetch(`${API_BASE}/analyze/image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: base64, filename: file.name || 'image.png' })
            });

            if (!response.ok) throw new Error('Backend error');

            const result = await response.json();

            if (result.entities && result.entities.length > 0) {
                showFileWarning(file.name || 'Image', result);
            } else {
                showToast('✅ No PII detected in image', 'success');
            }
        } catch (e) {
            console.error('[GenGuard] Image analysis error:', e);
            showToast('❌ Failed to analyze image', 'error');
        }
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // Analyze text via backend
    async function analyzeTextWithBackend(text) {
        try {
            const response = await fetch(`${API_BASE}/analyze/text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });

            if (!response.ok) throw new Error('Backend error');
            return await response.json();
        } catch (e) {
            console.error('[GenGuard] Text analysis error:', e);
            return null;
        }
    }

    // Analyze input field
    async function analyzeInput(target) {
        const text = target.value || target.innerText || '';
        if (!text.trim()) {
            removeOverlay();
            return;
        }

        try {
            const result = await analyzeTextWithBackend(text);

            if (result && result.entities && result.entities.length > 0) {
                currentAnalysis = result;
                showOverlay(result, target);
            } else {
                removeOverlay();
                currentAnalysis = null;
            }
        } catch (e) {
            console.error('[GenGuard] Analysis error:', e);
        }
    }

    // Show warning overlay
    function showOverlay(analysis, target) {
        removeOverlay();

        const container = target.closest('form') || target.parentElement;
        if (!container) return;

        overlayElement = document.createElement('div');
        overlayElement.id = 'genguard-overlay';
        overlayElement.innerHTML = `
      <style>
        #genguard-overlay {
          position: absolute; top: -85px; left: 0; right: 0;
          background: linear-gradient(135deg, rgba(30, 30, 40, 0.98), rgba(20, 20, 30, 0.98));
          backdrop-filter: blur(10px); border-radius: 12px; padding: 12px 16px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); z-index: 999998;
          font-family: system-ui, sans-serif; border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .gg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .gg-title { display: flex; align-items: center; gap: 8px; color: #fff; font-size: 13px; font-weight: 600; }
        .gg-badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
        .gg-badge.critical { background: #ef4444; color: #fff; }
        .gg-badge.high { background: #f97316; color: #fff; }
        .gg-badge.medium { background: #eab308; color: #000; }
        .gg-badge.low { background: #22c55e; color: #fff; }
        .gg-entities { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
        .gg-entity { padding: 4px 8px; background: rgba(255,255,255,0.1); border-radius: 4px; font-size: 11px; color: #e5e7eb; border-left: 3px solid #6b7280; }
        .gg-entity.critical { border-left-color: #ef4444; }
        .gg-entity.high { border-left-color: #f97316; }
        .gg-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .gg-btn { padding: 6px 14px; border: none; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; }
        .gg-btn-primary { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; }
        .gg-btn-secondary { background: rgba(255,255,255,0.1); color: #9ca3af; }
        .gg-close { background: none; border: none; color: #6b7280; cursor: pointer; font-size: 16px; }
      </style>
      <div class="gg-header">
        <div class="gg-title">
          <span>🛡️ GenGuard</span>
          <span class="gg-badge ${analysis.riskLevel}">${analysis.riskLevel.toUpperCase()} (${analysis.riskScore})</span>
        </div>
        <button class="gg-close" id="gg-close">×</button>
      </div>
      <div class="gg-entities">
        ${analysis.entities.slice(0, 5).map(e =>
            `<span class="gg-entity ${e.sensitivity}"><strong>${e.type}</strong>: ${truncate(e.text, 12)}</span>`
        ).join('')}
        ${analysis.entities.length > 5 ? `<span class="gg-entity">+${analysis.entities.length - 5} more</span>` : ''}
      </div>
      <div class="gg-actions">
        <button class="gg-btn gg-btn-secondary" id="gg-proceed">Proceed Anyway</button>
        <button class="gg-btn gg-btn-primary" id="gg-replace">🔒 Auto-Replace PII</button>
      </div>
    `;

        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        container.appendChild(overlayElement);

        document.getElementById('gg-close').onclick = removeOverlay;
        document.getElementById('gg-proceed').onclick = removeOverlay;
        document.getElementById('gg-replace').onclick = () => replaceAllPII(target);
    }

    function removeOverlay() {
        if (overlayElement) {
            overlayElement.remove();
            overlayElement = null;
        }
    }

    // Replace PII via backend
    async function replaceAllPII(target) {
        if (!currentAnalysis || !currentAnalysis.entities.length) return;

        const text = target.value || target.innerText || '';

        try {
            const response = await fetch(`${API_BASE}/replace`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: text,
                    entities: currentAnalysis.entities,
                    mode: 'placeholder'
                })
            });

            if (!response.ok) throw new Error('Replace failed');

            const result = await response.json();

            if (target.value !== undefined) {
                target.value = result.text;
            } else {
                target.innerText = result.text;
            }

            target.dispatchEvent(new Event('input', { bubbles: true }));
            removeOverlay();
            currentAnalysis = null;
            showToast('✅ PII replaced!', 'success');
        } catch (e) {
            console.error('[GenGuard] Replace error:', e);
            showToast('❌ Failed to replace PII', 'error');
        }
    }

    // Show file warning
    function showFileWarning(fileName, analysis) {
        const existing = document.getElementById('genguard-file-warning');
        if (existing) existing.remove();

        const warningDiv = document.createElement('div');
        warningDiv.id = 'genguard-file-warning';
        warningDiv.innerHTML = `
          <style>
            #genguard-file-warning {
              position: fixed; top: 20px; right: 20px; width: 350px;
              background: linear-gradient(135deg, rgba(30, 30, 40, 0.98), rgba(20, 20, 30, 0.98));
              backdrop-filter: blur(10px); border-radius: 12px; padding: 16px;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); z-index: 999999;
              font-family: system-ui, sans-serif; border: 1px solid rgba(255, 255, 255, 0.1);
              animation: ggSlideIn 0.3s ease;
            }
            @keyframes ggSlideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            .gfw-header { display: flex; justify-content: space-between; margin-bottom: 12px; }
            .gfw-title { color: #fff; font-size: 14px; font-weight: 600; }
            .gfw-badge { padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; margin-left: 8px; }
            .gfw-badge.critical { background: #ef4444; color: #fff; }
            .gfw-badge.high { background: #f97316; color: #fff; }
            .gfw-badge.medium { background: #eab308; color: #000; }
            .gfw-file { color: #9ca3af; font-size: 12px; margin-bottom: 12px; }
            .gfw-entities { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
            .gfw-entity { padding: 4px 8px; background: rgba(255,255,255,0.1); border-radius: 4px; font-size: 11px; color: #e5e7eb; }
            .gfw-actions { display: flex; gap: 8px; justify-content: flex-end; }
            .gfw-btn { padding: 8px 16px; border: none; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; }
            .gfw-btn-secondary { background: rgba(255,255,255,0.1); color: #9ca3af; }
            .gfw-close { background: none; border: none; color: #6b7280; cursor: pointer; font-size: 18px; }
          </style>
          <div class="gfw-header">
            <span class="gfw-title">🛡️ GenGuard - File Warning</span>
            <button class="gfw-close" id="gfw-close">×</button>
          </div>
          <div class="gfw-file">
            📄 <strong>${fileName}</strong>
            <span class="gfw-badge ${analysis.riskLevel}">${analysis.riskLevel.toUpperCase()} (${analysis.riskScore})</span>
          </div>
          <div class="gfw-entities">
            ${analysis.entities.slice(0, 8).map(e => `<span class="gfw-entity"><strong>${e.type}</strong>: ${truncate(e.text, 15)}</span>`).join('')}
          </div>
          <div class="gfw-actions">
            <button class="gfw-btn gfw-btn-secondary" id="gfw-dismiss">Dismiss</button>
          </div>
        `;

        document.body.appendChild(warningDiv);
        document.getElementById('gfw-close').onclick = () => warningDiv.remove();
        document.getElementById('gfw-dismiss').onclick = () => warningDiv.remove();
        setTimeout(() => warningDiv.remove(), 30000);
    }

    function truncate(text, len) {
        return text && text.length > len ? text.slice(0, len) + '...' : text || '';
    }

    function showToast(message, type) {
        const colors = { success: '#22c55e', warning: '#f59e0b', error: '#ef4444', info: '#3b82f6' };
        document.querySelectorAll('.genguard-toast').forEach(t => t.remove());
        const toast = document.createElement('div');
        toast.className = 'genguard-toast';
        toast.style.cssText = `position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; background: ${colors[type] || '#3b82f6'}; color: white; border-radius: 8px; font-family: system-ui; font-size: 14px; z-index: 999999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
