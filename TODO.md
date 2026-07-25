# Pesapal Integration - Refinement Plan

## Progress Tracking

- [x] Step 0: Analyze existing codebase (all files read)
- [x] Step 1: Update `services/pesapalService.js` — Add sandbox/live environment switching
- [x] Step 2: Update `controllers/paymentController.js` — Remove duplicated functions, refactor legacy methods to use pesapalService
- [x] Step 3: Update `routes/paymentRoutes.js` — Route ordering already correct, no changes needed
- [x] Step 4: Review `server.js` — Raw body parsing for webhook is already set up, IPN is GET so no raw body needed
- [x] Step 5: Test — Syntax checks passed for all modified files
