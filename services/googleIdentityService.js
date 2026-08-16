// services/googleIdentityService.js — shared Google identity resolution.
//
// Item 16: Google is authentication, not registration.
//
// Both the web GIS flow (googleVerifyController) and the native Capacitor
// redirect flow (googleAuthController) call resolveGoogleIdentity(idToken,
// intent) so the login/signup business rule is IDENTICAL everywhere:
//
//   intent='login'  → existing account only. Never creates, never silently links.
//   intent='signup' → new account only. Rejects if the email or google_id exists.
//
// The function accepts either a raw Google ID token (JWT) OR a pre-verified
// profile object (from the Capacitor OAuth userinfo endpoint). Both paths
// apply the same business rules.
//
// Returns { user, profile } on success, or throws an error with a `code` and
// `status` that the caller maps to an HTTP response.
const {
  verifyGoogleIdToken,
  findGoogleUser,
  findUserByEmail,
  createGoogleUser,
  authenticateExistingGoogleUser,
} = require('./googleUpsert');

/**
 * Resolve a Google identity for the given intent.
 * @param {string|object} idTokenOrProfile - Google ID token (JWT) or a
 *   pre-verified profile object { sub, email, email_verified, name, picture }.
 * @param {'login'|'signup'} intent - the business intent
 * @returns {Promise<{user: object, profile: object}>}
 * @throws {Error} with .code and .status for the caller to map to HTTP.
 */
async function resolveGoogleIdentity(idTokenOrProfile, intent = 'login') {
  // If a string was passed, verify it as a Google ID token.
  // If an object was passed, it's already a verified profile (Capacitor flow).
  const profile = (typeof idTokenOrProfile === 'string')
    ? await verifyGoogleIdToken(idTokenOrProfile)
    : idTokenOrProfile;

  if (!profile || !profile.email) {
    const err = new Error('Could not retrieve email from Google.');
    err.code = 'GOOGLE_EMAIL_MISSING';
    err.status = 400;
    throw err;
  }
  if (profile.email_verified === false) {
    const err = new Error('Google email is not verified.');
    err.code = 'GOOGLE_EMAIL_NOT_VERIFIED';
    err.status = 400;
    throw err;
  }

  // 1. Look up by google_id (fastest for returning Google users).
  let user = await findGoogleUser(profile.sub);

  // 2. If no google_id match, look up by the verified email.
  if (!user) {
    user = await findUserByEmail(profile.email);
  }

  if (intent === 'login') {
    // LOGIN: existing account only. Never create, never silently link.
    if (!user) {
      const err = new Error('No AniStrim account is associated with this Google account. Please create an account first.');
      err.code = 'GOOGLE_NO_ACCOUNT';
      err.status = 404;
      throw err;
    }
    if (user.auth_provider !== 'google' && !user.google_id) {
      const err = new Error('An AniStrim account already exists with this email. Please log in using your email and password.');
      err.code = 'GOOGLE_ACCOUNT_NOT_LINKED';
      err.status = 403;
      throw err;
    }
    // Status gate — suspended/deactivated/deleted users cannot log in via Google.
    if (user.status && user.status !== 'active') {
      const err = new Error('Account is not active.');
      err.code = user.status === 'suspended' ? 'ACCOUNT_SUSPENDED'
        : user.status === 'deactivated' ? 'ACCOUNT_DEACTIVATED'
        : user.status === 'deleted' ? 'ACCOUNT_DELETED'
        : 'ACCOUNT_NOT_ACTIVE';
      err.status = 403;
      throw err;
    }
    user = await authenticateExistingGoogleUser(user, profile);
    return { user, profile };
  }

  if (intent === 'signup') {
    // SIGNUP: existing account (google_id or email) rejected; new allowed.
    if (user) {
      const err = new Error('An AniStrim account already exists. Please log in instead.');
      err.code = 'ACCOUNT_ALREADY_EXISTS';
      err.status = 409;
      throw err;
    }
    user = await createGoogleUser(profile);
    return { user, profile };
  }

  const err = new Error('Invalid Google intent.');
  err.code = 'GOOGLE_INVALID_INTENT';
  err.status = 400;
  throw err;
}

module.exports = { resolveGoogleIdentity };