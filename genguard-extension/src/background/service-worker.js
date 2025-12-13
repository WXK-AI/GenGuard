// GenGuard Service Worker - Simplified
// Handles extension lifecycle and optional caching

chrome.runtime.onInstalled.addListener(() => {
    console.log('[GenGuard] Extension installed');
});

// Handle messages from content scripts (optional pass-through)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[GenGuard] Message received:', message.type);

    // Content scripts now call the backend directly,
    // but we keep this for potential future features
    if (message.type === 'GET_STATUS') {
        sendResponse({ status: 'active', version: '2.0.0' });
    }

    return true; // Keep channel open for async response
});

console.log('[GenGuard] Service worker loaded');
