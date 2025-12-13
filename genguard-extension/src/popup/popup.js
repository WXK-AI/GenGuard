// GenGuard Popup Script

const API_BASE = 'http://localhost:5000';

document.addEventListener('DOMContentLoaded', () => {
    checkBackendStatus();

    document.getElementById('test-btn').addEventListener('click', testBackend);
    document.getElementById('docs-btn').addEventListener('click', () => {
        chrome.tabs.create({ url: `${API_BASE}/docs` });
    });
});

async function checkBackendStatus() {
    const statusEl = document.getElementById('backend-status');

    try {
        const response = await fetch(`${API_BASE}/health`);
        if (response.ok) {
            const data = await response.json();
            statusEl.className = 'status-indicator connected';
            statusEl.querySelector('.text').textContent =
                `Connected (OCR: ${data.ocr_ready ? '✓' : '○'}, NER: ${data.ner_ready ? '✓' : '○'})`;
        } else {
            throw new Error('Not OK');
        }
    } catch (e) {
        statusEl.className = 'status-indicator disconnected';
        statusEl.querySelector('.text').textContent = 'Backend not running';
    }
}

async function testBackend() {
    const btn = document.getElementById('test-btn');
    btn.textContent = 'Testing...';
    btn.disabled = true;

    try {
        const response = await fetch(`${API_BASE}/analyze/text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'My IC is 990101-14-1234 and email is test@example.com'
            })
        });

        if (response.ok) {
            const data = await response.json();
            btn.textContent = `✓ Found ${data.entities.length} PII`;
            btn.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';
        } else {
            throw new Error('Backend error');
        }
    } catch (e) {
        btn.textContent = '✗ Test Failed';
        btn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
    }

    setTimeout(() => {
        btn.textContent = 'Test Backend';
        btn.style.background = '';
        btn.disabled = false;
    }, 2000);
}
