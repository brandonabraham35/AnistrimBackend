// generate-css.js - run with: node generate-css.js
const fs = require('fs');
const base = fs.readFileSync('Web/css/styles.css', 'utf8');
const more = `

@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.skeleton{background:linear-gradient(90deg,var(--bg3) 25%,var(--card) 50%,var(--bg3) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:4px}
.skeleton-card{aspect-ratio:2/3;border-radius:var(--radius)}
.skeleton-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:18px}
.skeleton-slide{height:460px}
.toast-root{position:fixed;top:80px;right:24px;z-index:9999;pointer-events:none}
.toast{padding:12px 20px;border-radius:var(--radius-sm);box-shadow:var(--shadow);transform:translateX(100%);opacity:0;transition:transform .3s,opacity .3s;max-width:360px;pointer-events:auto}
.toast.show{transform:translateX(0);opacity:1}
.toast.info{background:var(--card);border:1px solid var(--border)}
.toast.success{background:#14532d;border:1px solid var(--success);color:#bbf7d0}
.toast.error{background:#450a0a;border:1px solid var(--danger);color:#fecaca}
.site-footer{border-top:1px solid var(--border);padding:24px 0;margin-top:40px}
.footer-inner{max-width:1300px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;font-size:.82rem;color:var(--text-muted)}
.footer-links{display:flex;gap:18px}
.footer-links a{color:var(--text-dim)}
.page-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.toolbar-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.page-toolbar select{min-width:140px}
.empty-state{color:var(--text-muted);text-align:center;padding:60px 20px}
.auth-page{display:flex;justify-content:center;align-items:center;min-height:calc(100vh - 64px);padding:40px 24px}
.auth-card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:36px 32px}
.auth-card h1{font-size:1.5rem;font-weight:700;margin-bottom:8px;text-align:center}
.auth-card .form-group{margin-bottom:16px}
.auth-card label{display:block;font-size:.82rem;font-weight:600;color:var(--text-dim);margin-bottom:6px}
.auth-card input{width:100%}
.auth-card .auth-switch{text-align:center;margin-top:20px;font-size:.85rem;color:var(--text-dim)}
.auth-card .auth-switch a{color:var(--purple);font-weight:600}
.anime-detail-content{position:relative;z-index:2;display:flex;gap:28px}
.anime-detail-poster{width:220px;flex-shrink:0;border-radius:var(--radius);overflow:hidden;aspect-ratio:2/3;background:var(--bg3)}
.anime-detail-poster img{width:100%;height:100%;object-fit:cover}
.anime-detail-info h1{font-size:2rem;font-weight:800;margin-bottom:8px}
.anime-meta-tags{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.anime-meta-tag{background:var(--bg3);padding:4px 10px;border-radius:4px;font-size:.78rem;color:var(--text-dim);font-weight:500}
.anime-detail-info .description{color:var(--text-dim);line-height:1.6;margin-bottom:20px}
.anime-actions{display:flex;gap:10px;flex-wrap:wrap}
.episode-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(48px,1fr));gap:8px;margin-top:12px}
.episode-item{aspect-ratio:1;display:flex;align-items:center;justify-content:center;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:.82rem;font-weight:500;cursor:pointer}
.episode-item.active{background:var(--purple);color:#fff}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px;margin:28px 0}
.plan{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:32px 28px;text-align:center}
.plan.featured{border-color:var(--purple)}
.plan .price{font-size:2.4rem;font-weight:800;margin:16px 0}
.plan .price span{font-size:.9rem;font-weight:500;color:var(--text-muted)}
.profile-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.profile-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:24px}
.wl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px}
.history-entry{display:flex;align-items:center;gap:16px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px}
.history-thumb{width:80px;height:48px;border-radius:6px;background:var(--bg3);flex-shrink:0;overflow:hidden}
.history-thumb img{width:100%;height:100%;object-fit:cover}
.history-info .hi-title{font-weight:600;font-size:.92rem}
.history-info .hi-meta{color:var(--text-muted);font-size:.8rem;margin-top:2px}
.history-progress{width:100%;height:4px;background:var(--border);border-radius:99px;margin-top:8px;overflow:hidden}
.history-progress div{height:100%;background:linear-gradient(90deg,var(--purple),var(--accent));border-radius:99px}
@media(max-width:1024px){.home-content{grid-template-columns:1fr}.home-sidebar{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:8px}.slide-inner{height:380px}.slide-content h2{font-size:2rem}.anime-detail-content{flex-direction:column}.anime-detail-poster{width:160px}.profile-grid{grid-template-columns:1fr}}
@media(max-width:768px){.container{padding:0 16px}.nav-links a,.nav-search{display:none}.mobile-menu-btn{display:block}.slide-inner{height:320px;padding:32px 16px}.slide-content h2{font-size:1.5rem}.slider-btn{width:36px;height:36px}.anime-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}.home-sidebar{grid-template-columns:1fr}.anime-detail-poster{width:120px}.plans{grid-template-columns:1fr}.auth-card{padding:24px 20px}}
@media(max-width:480px){.anime-grid{grid-template-columns:repeat(2,1fr);gap:10px}.slide-inner{height:260px;padding:24px 12px}.slide-content h2{font-size:1.2rem}.slider-btn{display:none}.continue-card{flex:0 0 160px}}
`;
fs.writeFileSync('Web/css/styles.css', base + more);
console.log('CSS complete:', (base + more).length, 'bytes');