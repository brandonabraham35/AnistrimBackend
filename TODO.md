# TODO: Import Modal Enhancements

## Done

- [x] Updated API base URL in `api.js` to Render production URL
- [x] Updated `connectionLimit` in `config/db.js` from 10 to 4

## Completed

- [x] **dashboard.js**: Rewrite `renderKitsuSearchResults()` - added "Import All Results" button, individual button changes to "✅ Imported" (green, disabled, no refresh), sequential `for...of` for Import All
- [x] **anime.js**: Same rewrite for `renderKitsuResults()`
- [x] **dashboard.html**: Added CSS for `.imported-btn` and `.import-all-btn` styles
