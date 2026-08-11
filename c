import os, shutil, sys

os.chdir(r'c:\Users\benar\Desktop\AnistrimBackend2')

# 1. Append CSS if not present
css_path = os.path.join(os.getcwd(), 'Frontend', 'css', 'watch.css')
with open(css_path, 'r', encoding='utf-8') as f:
    content = f.read()

if 'player-sidebar' not in content:
    new_css = r'''

/* =============================================================
   NEW: Season Navigation
   ============================================================= */
.season-nav {
    display: none;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    background: rgba(10, 10, 15, 0.9);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.season-btn {
    flex: 1;
    min-width: 80px;
    padding: 0.5rem 0.75rem;
    background: rgba(56, 56, 66, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: var(--player-text);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
}

.season-btn:hover {
    background: rgba(108, 43, 217, 0.3);
    border-color: var(--player-accent);
    color: var(--player-accent-hover);
}

.season-btn.active {
    background: var(--player-accent);
    border-color: var(--player-accent);
    color: #fff;
    font-weight: 600;
}

.season-btn .season-count {
    font-size: 0.7rem;
    opacity: 0.8;
}

/* Episode Sidebar — Full-featured drawer */
.player-sidebar {
    position: fixed;
    top: 0;
    right: 0;
    width: 400px;
    max-width: 90vw;
    height: 100vh;
    background: linear-gradient(180deg, #0a0a0f 0%, #14141e 100%);
    backdrop-filter: blur(20px);
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
    z-index: 200;
    transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
}

.player-sidebar.visible {
    transform: translateX(0);
}

.sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.sidebar-title-group {
    flex: 1;
    min-width: 0;
}

.sidebar-header h3 {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0;
    color: var(--player-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.sidebar-season-info {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.8rem;
    color: var(--player-text-muted);
    margin-top: 0.25rem;
}

#close-sidebar-btn {
    width: 32px;
    height: 32px;
    font-size: 1.2rem;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--player-text);
    cursor: pointer;
    transition: all 0.2s;
}

#close-sidebar-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: var(--player-accent-hover);
}

.sidebar-episode-list {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 1rem;
}

.episode-item {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding: 0.75rem 1rem;
    cursor: pointer;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    transition: background 0.15s ease;
}

.episode-item:hover {
    background: rgba(255, 255, 255, 0.04);
}

.episode-item.current {
    background: rgba(108, 43, 217, 0.1);
    border-left: 3px solid var(--player-accent);
}

.episode-item.watched {
    opacity: 0.85;
}

.ep-thumb-wrap {
    position: relative;
    width: 60px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 4px;
    overflow: hidden;
}

.ep-thumb-wrap img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.ep-play-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
    pointer-events: none;
}

.ep-checkmark {
    position: absolute;
    bottom: 2px;
    right: 2px;
    background: var(--player-accent);
    color: #fff;
    font-size: 0.6rem;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
}

.ep-info {
    flex: 1;
    min-width: 0;
}

.ep-title-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.25rem;
}

.ep-title {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--player-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ep-badge {
    font-size: 0.65rem;
    padding: 1px 6px;
    border-radius: 3px;
    font-weight: 600;
}

.ep-badge.premium {
    background: rgba(255, 215, 0, 0.2);
    color: #ffd700;
}

.ep-badge.current-badge {
    background: var(--player-accent);
    color: #fff;
}

.ep-badge.download-badge {
    background: rgba(34, 197, 94, 0.2);
    color: #22c55e;
}

.ep-description {
    font-size: 0.72rem;
    color: var(--player-text-muted);
    line-height: 1.3;
    margin-bottom: 0.3rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.ep-meta-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--player-text-muted);
}

.ep-season-meta {
    white-space: nowrap;
}

.ep-duration {
    white-space: nowrap;
}

.ep-progress-bar {
    flex: 1;
    height: 3px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
    min-width: 50px;
}

.ep-progress-fill {
    height: 100%;
    background: var(--player-accent);
    border-radius: 2px;
    transition: width 0.2s ease;
}

.ep-progress-pct {
    white-space: nowrap;
}

/* End-of-Episode Overlay (enhanced) */
.next-ep {
    background: rgba(10, 10, 15, 0.95);
    border-radius: 12px;
    padding: 2rem;
    max-width: 380px;
    width: 90vw;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    text-align: center;
}

.next-ep-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
}

.next-ep-label {
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--player-text-muted);
}

.next-ep-countdown-badge {
    background: var(--player-accent);
    color: #fff;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9rem;
    font-weight: 700;
}

.next-ep h3 {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    color: var(--player-text);
}

.next-ep-meta {
    color: var(--player-text-muted);
    font-size: 0.85rem;
    margin-bottom: 1.25rem;
}

.next-ep-actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
}

.next-ep-primary {
    background: var(--player-accent);
    color: #fff;
    font-weight: 600;
    padding: 0.7rem;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    transition: background 0.2s;
}

.next-ep-primary:hover {
    background: var(--player-accent-hover);
}

.next-ep-actions .player-btn {
    background: rgba(255, 255, 255, 0.08);
    color: var(--player-text);
    border: 1px solid rgba(255, 255, 255, 0.12);
    padding: 0.6rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    transition: all 0.2s;
}

.next-ep-actions .player-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.2);
}

.next-ep-cancel-hint {
    display: flex;
    justify-content: center;
    padding-top: 0.5rem;
}

/* Resume Prompt Overlay */
.resume-prompt .resume-card {
    background: linear-gradient(180deg, #0a0a0f 0%, #1a1a2e 100%);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    padding: 2rem;
    max-width: 380px;
    width: 90vw;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.resume-prompt h3 {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 1rem 0;
    color: var(--player-text);
}

.resume-progress-text {
    color: var(--player-text-muted);
    font-size: 0.9rem;
    margin-bottom: 1.25rem;
    line-height: 1.5;
}

.resume-progress-pct {
    font-weight: 600;
    color: var(--player-accent);
}

.resume-saved-time {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.8rem;
}

.resume-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
}

.resume-actions .player-btn {
    flex: 1;
    padding: 0.7rem 1.25rem;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
}

#resume-continue-btn {
    background: var(--player-accent);
    color: #fff;
}

#resume-continue-btn:hover {
    background: var(--player-accent-hover);
}

#resume-restart-btn {
    background: rgba(255, 255, 255, 0.1);
    color: var(--player-text);
    border: 1px solid rgba(255, 255, 255, 0.12);
}

#resume-restart-btn:hover {
    background: rgba(255, 255, 255, 0.2);
}

/* Skip Outro Button */
#skip-outro-btn {
    background: rgba(108, 43, 217, 0.8);
    color: #fff;
    border: none;
    padding: 0.4rem 0.8rem;
    border-radius: 20px;
    font-size: 0.8rem;
    margin-left: 0.5rem;
    cursor: pointer;
    transition: background 0.2s;
}

#skip-outro-btn:hover {
    background: rgba(108, 43, 217, 0.95);
}

/* Countdown Presets */
#countdown-presets {
    padding: 0.5rem 0 0 0;
}
'''
    with open(css_path, 'a', encoding='utf-8') as f:
        f.write(new_css)
    print('CSS appended successfully')
else:
    print('CSS already present, skipping append')

# Re-sync CSS to iOS
ios_css_path = os.path.join(os.getcwd(), 'ios', 'App', 'App', 'public', 'css', 'watch.css')
os.makedirs(os.path.dirname(ios_css_path), exist_ok=True)
shutil.copy2(css_path, ios_css_path)
print('CSS re-synced to iOS')

# Verify CSS
with open(css_path, 'r', encoding='utf-8') as f:
    content = f.read()
has_new_css = 'player-sidebar' in content and 'season-nav' in content and 'next-ep' in content and 'resume-prompt' in content
print(f'CSS file size: {os.path.getsize(css_path)} bytes')
print(f'New CSS styles present: {has_new_css}')

# Verify watch.js
watch_js = os.path.join(os.getcwd(), 'Frontend', 'watch.js')
with open(watch_js, 'r', encoding='utf-8') as f:
    js_content = f.read()
new_funcs = ['switchToEpisode', 'switchSeason', 'renderEpisodeSidebar', 'buildSeasonGroups',
             'loadBatchProgress', 'showEndOverlay', 'hideEndOverlay', 'showResumePrompt',
             'startAutoplayCountdown', 'updateAutoplayUI', 'toggleEpisodeSidebar',
             'allEpisodes', 'currentSeason', 'seasonGroups', 'autoplayCountdownSeconds']
missing = [f for f in new_funcs if f not in js_content]
if missing:
    print(f'MISSING in watch.js: {missing}')
else:
    print(f'All {len(new_funcs)} new identifiers found in watch.js')
print(f'watch.js size: {os.path.getsize(watch_js)} bytes')

# Verify watch.html
watch_html = os.path.join(os.getcwd(), 'Frontend', 'watch.html')
with open(watch_html, 'r', encoding='utf-8') as f:
    html_content = f.read()
html_elements = ['season-nav', 'resume-overlay', 'next-episode-overlay', 'sidebar-season-label',
                 'next-ep-countdown-badge', 'countdown-presets', 'autoplay-panel',
                 'replay-btn', 'episode-list-btn', 'exit-player-btn', 'cancel-next-btn',
                 'resume-continue-btn', 'resume-restart-btn', 'skip-outro-btn']
missing_html = [e for e in html_elements if e not in html_content]
if missing_html:
    print(f'MISSING in watch.html: {missing_html}')
else:
    print(f'All {len(html_elements)} HTML elements found in watch.html')
print(f'watch.html size: {os.path.getsize(watch_html)} bytes')

# Clean up stray c file
stray_c = os.path.join(os.getcwd(), 'c')
if os.path.exists(stray_c) and not os.path.isdir(stray_c):
    os.remove(stray_c)
    print('Cleaned up stray c file')

# Verify backend
watch_ctrl = os.path.join(os.getcwd(), 'controllers', 'watchController.js')
with open(watch_ctrl, 'r', encoding='utf-8') as f:
    ctrl_content = f.read()
backend_funcs = ['getBatchProgress', 'resolveNextEpisode', 'getContinueWatching', 'episodeId']
missing_b = [f for f in backend_funcs if f not in ctrl_content]
if missing_b:
    print(f'MISSING in watchController.js: {missing_b}')
else:
    print(f'All {len(backend_funcs)} backend identifiers found in watchController.js')

watch_routes = os.path.join(os.getcwd(), 'routes', 'watchRoutes.js')
with open(watch_routes, 'r', encoding='utf-8') as f:
    routes_content = f.read()
route_checks = ['/progress/batch', '/next/', '/continue-watching']
missing_r = [r for r in route_checks if r not in routes_content]
if missing_r:
    print(f'MISSING in watchRoutes.js: {missing_r}')
else:
    print(f'All {len(route_checks)} routes found in watchRoutes.js')

# Verify migrations
for mig in ['sql/migrations_v19_episode_seasons.sql', 'sql/migrations_v20_watch_history_episode_id.sql']:
    p = os.path.join(os.getcwd(), mig)
    if os.path.exists(p):
        print(f'Migration present: {mig} ({os.path.getsize(p)} bytes)')
    else:
        print(f'MIGRATION MISSING: {mig}')

print()
print('=== ALL VERIFICATION COMPLETE ===')
