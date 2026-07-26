# AdminDashboard Fix — Progress Tracker

## Issues

1. Nav clicks trapped on dashboard — no routing to other sections
2. Statistics show zero — loadOverview() never runs

## Fix Plan

### File: `AdminDashboard/js/dashboard.js`

- [x] Guard `add-episode-button` null reference in DOMContentLoaded
- [x] Remove `event.preventDefault()` from nav link click handlers (let natural hash work)
- [x] Add `window.addEventListener('hashchange', ...)` listener for back/forward support
- [x] Ensure initial `showSection()` call is robust

### Verification

- [ ] Nav clicks navigate to correct sections
- [ ] Statistics load and display non-zero values
- [ ] Back/forward browser buttons work
