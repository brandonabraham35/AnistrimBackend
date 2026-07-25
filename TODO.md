# TODO: Pesapal Subscription & Payment Verification System

## Status: ✅ Complete

### ✅ Completed Steps

- [x] **Step 1**: Created `sql/migrations_v15_subscriptions.sql` — New `subscriptions` table with `id`, `user_id`, `reference`, `amount`, `currency`, `status`, `plan`, `order_tracking_id`, `payment_method`, `paid_at`, `expires_at`, `created_at`. Users table already has `is_premium` and `premium_expires_at`.

- [x] **Step 2**: Created `services/pesapalService.js` — Clean encapsulation of Pesapal API 3.0:
  - `getToken()` — OAuth 2.0 token from `/api/Auth/RequestToken`
  - `registerIPN(url)` — Registers webhook endpoint, returns IPN ID
  - `submitOrder(orderData)` — Submits order, returns `redirect_url` + `order_tracking_id`
  - `getTransactionStatus(orderTrackingId)` — Queries transaction status
  - `isPaymentCompleted(status)` — Helper to check if payment is COMPLETED/SUCCESS

- [x] **Step 3**: Updated `controllers/paymentController.js` — Added:
  - `initializeCheckout` — Authenticates with Pesapal, registers IPN, submits order, saves PENDING subscription record to `subscriptions` table, returns redirect URL
  - `handlePesapalIPN` — Public webhook handler: receives `OrderTrackingId` & `OrderMerchantReference` via GET query params, verifies with Pesapal, updates `subscriptions.status='COMPLETED'`, sets `users.is_premium=1`, `users.premium_expires_at=NOW()+30/365days`
  - All legacy endpoints preserved for backward compatibility

- [x] **Step 4**: Updated `routes/paymentRoutes.js` — Added:
  - `POST /checkout` → `initializeCheckout` (protected by `auth.protect`)
  - `GET /ipn-listener` → `handlePesapalIPN` (public, no auth)
  - All legacy routes preserved

### Notes for Deployment

1. **Run the SQL migration** in MySQL:

   ```sql
   SOURCE sql/migrations_v15_subscriptions.sql;
   ```

2. **Ensure `.env` has these variables**:

   ```
   PESAPAL_CONSUMER_KEY=your_key_here
   PESAPAL_CONSUMER_SECRET=your_secret_here
   PESAPAL_IPN_ID=optional_if_reusing_existing
   BACKEND_URL=https://your-backend-url.com
   ```

3. **Frontend Compatibility**:
   - The existing `upgrade.js` calls `POST /api/payments/initiate` (legacy) — still works
   - To use the new flow, update frontend to call `POST /api/payments/checkout` instead
   - The callback route `GET /api/payments/callback` still handles post-payment redirects
   - IPN listener is at `GET /api/payments/ipn-listener`

4. **IPN Webhook Registration**:
   - Register `https://your-backend.com/api/payments/ipn-listener` in Pesapal dashboard
   - Or let the system auto-register on first checkout via `registerIPN()`
   - Save returned IPN ID as `PESAPAL_IPN_ID` in `.env` to reuse
