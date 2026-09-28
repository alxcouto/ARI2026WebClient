/**
 * ARI 2026 LiveSpeech MLX TX - Embedded Web Client Helper Script
 * Automatic container discovery, isolated iFrame injection, theme parameter passing,
 * and background Matomo telemetry bridge.
 */
(function() {
    'use strict';

    // Determine base URL from embed.js script source location
    function getBaseUrl() {
        if (document.currentScript && document.currentScript.src) {
            const src = document.currentScript.src;
            return src.substring(0, src.lastIndexOf('/'));
        }
        return '.';
    }

    const baseUrl = getBaseUrl();

    // ==============================================================================
    // Matomo Bridge
    // ==============================================================================
    // The LiveSpeech iframe sends player events here via window.postMessage,
    // and this script forwards them to window._paq on the host page.
    const liveSpeechFrames = new Map();
    const mediaTrackers = new Map();

    function numberOrZero(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    function getContentName(data, container) {
        const sessionKey = data.session_key || container.getAttribute('data-session') || '';
        const broadcastId = data.broadcast_id || container.getAttribute('data-broadcast-id') || '';
        const customTitle = container.getAttribute('data-matomo-title');
        if (customTitle) return customTitle;
        if (sessionKey && broadcastId && sessionKey !== broadcastId) return `${sessionKey} | ${broadcastId}`;
        return sessionKey || broadcastId || 'ARI 2026 Live Video';
    }

    function trackStandardEvent(data, container) {
        const paq = window._paq = window._paq || [];
        const contentName = getContentName(data, container);
        const position = Math.round(numberOrZero(data.progress));

        if (data.action === 'progress' || data.action === 'buffering') return;

        if (data.action === 'impression') {
            paq.push(['trackEvent', 'LiveSpeech Video', 'Impression', contentName]);
            return;
        }
        if (data.action === 'play') {
            paq.push(['trackEvent', 'LiveSpeech Video', 'Play', contentName, position]);
            return;
        }
        if (data.action === 'pause') {
            paq.push(['trackEvent', 'LiveSpeech Video', 'Pause', contentName, position]);
            return;
        }
        if (data.action === 'finish') {
            paq.push(['trackEvent', 'LiveSpeech Video', 'Finish', contentName, position]);
            return;
        }
        if (data.action === 'milestone') {
            paq.push(['trackEvent', 'LiveSpeech Video', `Milestone ${data.milestone}%`, contentName, Number(data.milestone) || 0]);
            return;
        }

        if (data.action === 'language_change') {
            paq.push(['trackEvent', 'LiveSpeech Accessibility', 'Language Change', `${contentName} | ${data.language || data.selected_language || 'Unknown'}`, position]);
            return;
        }
        if (data.action === 'subtitles_on' || data.action === 'subtitles_off') {
            paq.push(['trackEvent', 'LiveSpeech Accessibility', data.action === 'subtitles_on' ? 'Subtitles On' : 'Subtitles Off', contentName, position]);
            return;
        }
        if (data.action === 'tts_on' || data.action === 'tts_off') {
            paq.push(['trackEvent', 'LiveSpeech Accessibility', data.action === 'tts_on' ? 'TTS On' : 'TTS Off', contentName, position]);
            return;
        }

        const controlActions = {
            mute: 'Mute',
            unmute: 'Unmute',
            volume_change: 'Volume Change',
            fullscreen_enter: 'Fullscreen Enter',
            fullscreen_exit: 'Fullscreen Exit'
        };
        if (controlActions[data.action]) {
            const value = data.action === 'volume_change' ? Math.round(numberOrZero(data.volume)) : position;
            paq.push(['trackEvent', 'LiveSpeech Controls', controlActions[data.action], contentName, value]);
        }
    }

    function createMediaTracker(data, container) {
        if (!window.Matomo || !Matomo.MediaAnalytics || !Matomo.MediaAnalytics.MediaTracker) return null;

        const MA = Matomo.MediaAnalytics;
        const broadcastId = data.broadcast_id || container.getAttribute('data-broadcast-id') || container.getAttribute('data-session') || 'unknown';
        const resource = `https://www.youtube.com/watch?v=${encodeURIComponent(broadcastId)}`;
        const tracker = new MA.MediaTracker('livespeech', MA.mediaType.VIDEO, resource);
        tracker.setMediaTitle(getContentName(data, container));
        tracker.setWidth(container.clientWidth || 0);
        tracker.setHeight(container.clientHeight || 0);

        const state = { tracker, impressionSent: false, buffering: false };
        mediaTrackers.set(container, state);
        return state;
    }

    function forwardToMediaAnalytics(data, container, retryCount = 0) {
        let state = mediaTrackers.get(container);
        if (!state) state = createMediaTracker(data, container);

        if (!state) {
            if (retryCount < 10) {
                setTimeout(() => forwardToMediaAnalytics(data, container, retryCount + 1), 300);
            }
            return;
        }

        const tracker = state.tracker;
        const progress = numberOrZero(data.progress);
        const duration = numberOrZero(data.duration);

        tracker.setMediaProgressInSeconds(progress);
        if (duration > 0) tracker.setMediaTotalLengthInSeconds(duration);
        tracker.setWidth(container.clientWidth || 0);
        tracker.setHeight(container.clientHeight || 0);

        if (data.action === 'impression' && !state.impressionSent) {
            state.impressionSent = true;
            tracker.trackUpdate();
        } else if (data.action === 'buffering') {
            if (!state.buffering) {
                state.buffering = true;
                tracker.seekStart();
            }
        } else if (data.action === 'play') {
            if (state.buffering) {
                state.buffering = false;
                tracker.seekFinish();
            }
            tracker.play();
        } else if (data.action === 'pause') {
            tracker.pause();
        } else if (data.action === 'finish') {
            tracker.finish();
        } else if (data.action === 'progress') {
            tracker.update();
        } else if (data.action === 'fullscreen_enter') {
            tracker.setFullscreen(true);
            tracker.update();
        } else if (data.action === 'fullscreen_exit') {
            tracker.setFullscreen(false);
            tracker.update();
        }
    }

    window.addEventListener('message', function(event) {
        const data = event.data;
        if (!data || data.type !== 'livespeech:analytics' || data.version !== 2) return;

        // Security: only accept messages from iframe windows created by this embed.js
        const container = liveSpeechFrames.get(event.source);
        if (!container) return;

        trackStandardEvent(data, container);
        forwardToMediaAnalytics(data, container);

        try {
            window.dispatchEvent(new CustomEvent('livespeech:analytics', {
                detail: { data: data, container: container, contentName: getContentName(data, container) }
            }));
        } catch (e) {}
    });

    function initEmbeds() {
        const containers = document.querySelectorAll('[data-broadcast-id], [data-session], .livespeech-embed');
        
        containers.forEach(function(container) {
            if (container.getAttribute('data-ls-embedded') === 'true') {
                return; // Already initialized
            }

            const broadcastId = container.getAttribute('data-broadcast-id') || container.getAttribute('data-session') || '';
            const theme = container.getAttribute('data-theme') || 'dark';

            if (!broadcastId) {
                console.warn('[LiveSpeech Embed] Container missing data-session attribute:', container);
                return;
            }

            container.setAttribute('data-ls-embedded', 'true');

            // Default height styling if not specified
            if (!container.style.height && !container.classList.contains('custom-height')) {
                container.style.height = '650px';
            }
            container.style.width = container.style.width || '100%';
            container.style.position = 'relative';
            container.style.overflow = 'hidden';

            // Create isolated iFrame pointing directly to index.html at root
            const iframe = document.createElement('iframe');
            const targetUrl = `${baseUrl}/index.html?session=${encodeURIComponent(broadcastId)}&theme=${encodeURIComponent(theme)}`;
            
            iframe.src = targetUrl;
            iframe.style.cssText = 'width: 100%; height: 100%; border: none; overflow: hidden; display: block;';
            iframe.allow = 'autoplay; encrypted-media; fullscreen';
            iframe.setAttribute('allowfullscreen', 'true');
            iframe.title = `ARI 2026 Live Player - ${broadcastId}`;

            container.innerHTML = '';
            container.appendChild(iframe);

            if (iframe.contentWindow) liveSpeechFrames.set(iframe.contentWindow, container);
            iframe.addEventListener('load', function() {
                if (iframe.contentWindow) liveSpeechFrames.set(iframe.contentWindow, container);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEmbeds);
    } else {
        initEmbeds();
    }

    if (typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(function(mutations) {
            let shouldInit = false;
            mutations.forEach(function(mutation) {
                if (mutation.addedNodes && mutation.addedNodes.length > 0) {
                    shouldInit = true;
                }
            });
            if (shouldInit) {
                initEmbeds();
            }
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });
    }
})();
