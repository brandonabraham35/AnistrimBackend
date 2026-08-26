# Admin Dashboard — Live Diagnostic Instructions

## The Situation

Multiple static code audits have confirmed that every layer of the Admin Dashboard data flow is structurally correct:
- ✅ API routes registered
- ✅ SQL queries valid
- ✅ Response envelope correct
- ✅ Frontend JavaScript correct
- ✅ DOM selectors exist
- ✅ CSS doesn't hide elements
- ✅ Script loading order correct

**But the dashboard still doesn't show data.** The only way to determine why is to run a live diagnostic in the actual browser with an authenticated admin session.

---

## How to Run the Diagnostic

### Step 1: Open the Admin Dashboard

1. Open your browser (Chrome recommended)
2. Navigate to: `https://anistrimbackend.onrender.com/admin/index.html`
3. Log in with your admin credentials
4. You should see the dashboard (even if data shows as `0` or "No data available")

### Step 2: Open Developer Tools

1. Press **F12** (or right-click → Inspect)
2. Click the **Console** tab
3. Clear any existing messages (click the 🚫 icon)

### Step 3: Run the Diagnostic Script

1. Open the file: `scripts/admin-dashboard-diagnostic.js` in a text editor
2. **Select all** (Ctrl+A) and **copy** (Ctrl+C) the entire contents
3. **Paste** (Ctrl+V) into the browser Console
4. Press **Enter**

### Step 4: Read the Output

The script will output a structured report with sections:

```
═══════════════════════════════════════════
  1. SCRIPT LOADING
═══════════════════════════════════════════

  AniStrimSession | PASS | Created
  apiRequest | PASS | Loaded
  _formatNumber | PASS | Loaded
  ...

═══════════════════════════════════════════
  2. AUTHENTICATION
═══════════════════════════════════════════

  Admin session object | PASS | Created
  Token present | PASS | YES (not printed)

═══════════════════════════════════════════
  6. LIVE API REQUEST — /api/admin/dashboard/overview
═══════════════════════════════════════════

  HTTP request | PASS | Response received
  data.overview | PASS | Present
  overview.users.total | INFO | Value: 5
  overview.content.totalAnime | INFO | Value: 12
  overview.content.totalEpisodes | INFO | Value: 47
  data.recentEpisodes | INFO | Count: 5 — first: {"id":123,...}
  ...

═══════════════════════════════════════════
  7. DOM VALUES (current textContent)
═══════════════════════════════════════════

  #stats-total-users | PASS | textContent = "5"
  #stats-total-anime | PASS | textContent = "12"
  ...

═══════════════════════════════════════════
  DIAGNOSTIC SUMMARY
═══════════════════════════════════════════

  PASS: 25
  FAIL: 0

  ✅ All checks passed. The dashboard is functioning correctly.
     If you see "0" or "No data available", the production database
     genuinely lacks content for those metrics.
```

### Step 5: Share the Results

Copy the entire console output and share it. The output will tell us exactly:

- Whether the API is returning data or zeros
- Whether the DOM is being populated correctly
- Whether any JavaScript errors are occurring
- Whether CSS is hiding elements
- Whether chart endpoints are responding

---

## What Each Result Means

### If `data.overview` is present with non-zero values AND DOM matches

**The dashboard is working correctly.** The values shown reflect the actual production database state. If numbers seem low, the database genuinely has that much data.

### If `data.overview` is present but values are 0

**The API is working but the database has minimal data.** Specifically:
- `users.total = 1` → Only the admin account exists
- `totalEpisodes = 0` → No episodes in the database
- `recentEpisodes = []` → No episodes to show
- `revenue.total = 0` → No successful payments

### If `data.overview` is MISSING (FAIL)

**The API is not returning the expected response.** This could be:
- A backend error (500 response)
- A database query failure
- An authentication issue

Check the error message shown in the diagnostic output.

### If `Token present` is FAIL

**You need to log in again.** The session has expired or was never established.

### If script globals like `apiRequest` or `_formatNumber` are NOT FOUND

**A script failed to load.** Check the Network tab for failed script requests (404, 500, or HTML error pages instead of JavaScript).

### If DOM selectors are NOT FOUND

**The HTML structure is different than expected.** This would indicate a version mismatch between the code we audited and what's actually deployed.

---

## Alternative: Manual Network Inspection

If you prefer not to run the script:

1. Open the Admin Dashboard (logged in)
2. Press F12 → **Network** tab
3. Filter by `overview`
4. Refresh the page (F5)
5. Click the `/api/admin/dashboard/overview` request
6. Check the **Response** tab
7. Look for:
   - `data.overview.users.total` — what number?
   - `data.overview.content.totalEpisodes` — what number?
   - `data.recentEpisodes` — is it an array? How many items?

This single check will tell us whether the problem is backend (API returns empty data) or frontend (API returns data but dashboard doesn't show it).

---

## Safety

The diagnostic script:
- ✅ Makes only GET requests (no data modification)
- ✅ Does NOT log, store, or transmit any tokens
- ✅ Runs entirely in your browser console
- ✅ Does NOT modify any files or database
- ✅ Uses your existing authenticated session (no new credentials needed)
