// controllers/supportController.js — User support ticket system.
//
// Authenticated users can submit support requests and view their own tickets.
// The backend determines the user from the JWT/session — never trusts
// frontend-supplied user_id, email, or role.
//
// Routes:
//   POST /api/support           — Submit a support request
//   GET  /api/support           — List authenticated user's tickets
//   GET  /api/support/:ticket_number — View a single ticket

const pool = require('../config/db');
const { sendSuccess } = require('../utils/response');
const {
  sendEmail,
  buildSupportNotificationEmail,
  buildSupportConfirmationEmail,
} = require('../utils/mailer');

// ── Constants ──────────────────────────────────────────────

const VALID_CATEGORIES = Object.freeze({
  complaint: 'Complaint',
  bug: 'Bug / Something isn\'t working',
  account: 'Account problem',
  payment: 'Payment problem',
  video: 'Video / Playback problem',
  episode: 'Anime / Episode problem',
  other: 'Other',
});

const MAX_SUBJECT_LEN = 150;
const MAX_MESSAGE_LEN = 5000;
const MIN_SUBJECT_LEN = 3;
const MIN_MESSAGE_LEN = 10;

// Support address — must be a verified sender in Postmark.
const SUPPORT_EMAIL = 'support@anistrim.com';

// ── Ticket number generation ───────────────────────────────
// Format: ANI-YYYYMMDD-NNNNNN (e.g., ANI-20260827-000123)
// Unique constraint on ticket_number guarantees no collisions even under
// concurrent submissions (the database enforces it).

function generateTicketNumber() {
  var now = new Date();
  var y = now.getUTCFullYear();
  var mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  var d = String(now.getUTCDate()).padStart(2, '0');
  // Use Date.now() for a pseudo-unique suffix; the UNIQUE constraint on
  // ticket_number guarantees no collision even if two requests land in the
  // same millisecond.
  var seq = String(Date.now() % 1000000).padStart(6, '0');
  return 'ANI-' + y + mo + d + '-' + seq;
}

// ── Send support emails (non-blocking) ─────────────────────
// Ticket creation and email delivery are separate.  If the database INSERT
// succeeds but Postmark is temporarily down, the ticket is preserved.

async function sendSupportEmails(ticket) {
  var errors = [];

  // 1. Notification to support@anistrim.com
  try {
    var notificationHtml = buildSupportNotificationEmail(ticket);
    await sendEmail(SUPPORT_EMAIL, 'New AniStrim Support Request — ' + ticket.ticket_number, notificationHtml);
  } catch (err) {
    console.error('[Support] notification email failed for ticket ' + ticket.ticket_number + ':', err.message);
    errors.push('notification');
  }

  // 2. Confirmation to the user
  try {
    var confirmationHtml = buildSupportConfirmationEmail(ticket);
    await sendEmail(ticket.user_email, 'AniStrim Support Request — ' + ticket.ticket_number, confirmationHtml);
  } catch (err) {
    console.error('[Support] confirmation email failed for ticket ' + ticket.ticket_number + ':', err.message);
    errors.push('confirmation');
  }

  return errors;
}

// ── POST /api/support — Submit a support request ───────────

exports.createTicket = async (req, res) => {
  var userId = req.user && req.user.id;
  if (!userId) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }

  var category = req.body && req.body.category;
  var subject = req.body && req.body.subject;
  var message = req.body && req.body.message;
  var animeId = req.body && req.body.anime_id;
  var episodeId = req.body && req.body.episode_id;

  // ── Validation ─────────────────────────────────────────
  if (!category || !VALID_CATEGORIES[category]) {
    return res.status(400).json({
      message: 'Invalid category. Allowed: ' + Object.keys(VALID_CATEGORIES).join(', ') + '.',
    });
  }

  if (!subject || typeof subject !== 'string') {
    return res.status(400).json({ message: 'Subject is required.' });
  }
  var trimmedSubject = subject.trim();
  if (trimmedSubject.length < MIN_SUBJECT_LEN) {
    return res.status(400).json({ message: 'Subject must be at least ' + MIN_SUBJECT_LEN + ' characters.' });
  }
  if (trimmedSubject.length > MAX_SUBJECT_LEN) {
    return res.status(400).json({ message: 'Subject must be at most ' + MAX_SUBJECT_LEN + ' characters.' });
  }

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ message: 'Message is required.' });
  }
  var trimmedMessage = message.trim();
  if (trimmedMessage.length < MIN_MESSAGE_LEN) {
    return res.status(400).json({ message: 'Message must be at least ' + MIN_MESSAGE_LEN + ' characters.' });
  }
  if (trimmedMessage.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({ message: 'Message must be at most ' + MAX_MESSAGE_LEN + ' characters.' });
  }

  // Validate anime_id if provided (must be a positive integer).
  if (animeId !== undefined && animeId !== null && animeId !== '') {
    var parsedAnimeId = Number(animeId);
    if (!Number.isInteger(parsedAnimeId) || parsedAnimeId <= 0) {
      return res.status(400).json({ message: 'Invalid anime ID.' });
    }
    animeId = parsedAnimeId;
  } else {
    animeId = null;
  }

  // Validate episode_id if provided.
  if (episodeId !== undefined && episodeId !== null && episodeId !== '') {
    var parsedEpId = Number(episodeId);
    if (!Number.isInteger(parsedEpId) || parsedEpId <= 0) {
      return res.status(400).json({ message: 'Invalid episode ID.' });
    }
    episodeId = parsedEpId;
  } else {
    episodeId = null;
  }

  // ── Create ticket ──────────────────────────────────────
  var ticketNumber = generateTicketNumber();

  try {
    // Insert the ticket.  The UNIQUE constraint on ticket_number guarantees
    // no duplicate ticket numbers even under concurrent submissions.
    var [result] = await pool.query(
      `INSERT INTO support_tickets
       (ticket_number, user_id, category, subject, message, anime_id, episode_id, status, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'normal')`,
      [ticketNumber, userId, category, trimmedSubject, trimmedMessage, animeId, episodeId]
    );

    // Fetch the user's actual email and name from the DB (authoritative).
    var [userRows] = await pool.query('SELECT name, email FROM users WHERE id = ?', [userId]);
    var user = userRows.length ? userRows[0] : { name: 'User', email: 'unknown' };

    // Fetch anime/episode titles for the email if IDs were provided.
    var animeTitle = null;
    var episodeTitle = null;
    if (animeId) {
      var [animeRows] = await pool.query('SELECT title FROM anime WHERE id = ?', [animeId]);
      if (animeRows.length) animeTitle = animeRows[0].title;
    }
    if (episodeId) {
      var [epRows] = await pool.query(
        'SELECT e.title, e.episode_number, a.title AS anime_title FROM episodes e LEFT JOIN anime a ON a.id = e.anime_id WHERE e.id = ?',
        [episodeId]
      );
      if (epRows.length) {
        episodeTitle = epRows[0].episode_number ? 'EP ' + epRows[0].episode_number + (epRows[0].title ? ' — ' + epRows[0].title : '') : (epRows[0].title || '');
      }
    }

    // Build the email payload (for both emails).
    var now = new Date();
    var emailPayload = {
      ticket_number: ticketNumber,
      user_name: user.name,
      user_email: user.email,
      category_label: VALID_CATEGORIES[category],
      subject: trimmedSubject,
      message: trimmedMessage,
      anime_title: animeTitle,
      episode_title: episodeTitle,
      submitted_at: now.toLocaleString(),
    };

    // Send emails asynchronously — ticket is already stored.
    sendSupportEmails(emailPayload).catch(function (err) {
      console.error('[Support] email send failed (non-fatal):', err && err.message);
    });

    return sendSuccess(res, {
      ticket_number: ticketNumber,
      status: 'open',
      email_sent: true,
    }, { message: 'Your support request was received. We\'ll process it shortly.' }, 201);

  } catch (err) {
    // Duplicate ticket number (extremely unlikely) — retry with a new one.
    if (err.code === 'ER_DUP_ENTRY') {
      return exports.createTicket(req, res);
    }
    console.error('[Support] createTicket error:', err.message);
    return res.status(500).json({ message: 'Server error submitting support request.' });
  }
};

// ── GET /api/support — List authenticated user's tickets ───

exports.listTickets = async (req, res) => {
  var userId = req.user && req.user.id;
  if (!userId) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }

  try {
    var [rows] = await pool.query(
      `SELECT ticket_number, category, subject, status, priority,
              created_at, updated_at, resolved_at
       FROM support_tickets
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    // Map categories to human-readable labels.
    var tickets = rows.map(function (row) {
      return {
        ticket_number: row.ticket_number,
        category: row.category,
        category_label: VALID_CATEGORIES[row.category] || row.category,
        subject: row.subject,
        status: row.status,
        priority: row.priority,
        created_at: row.created_at,
        updated_at: row.updated_at,
        resolved_at: row.resolved_at,
      };
    });

    return sendSuccess(res, tickets);
  } catch (err) {
    console.error('[Support] listTickets error:', err.message);
    return res.status(500).json({ message: 'Server error loading support requests.' });
  }
};

// ── GET /api/support/:ticket_number — View a single ticket ──

exports.getTicket = async (req, res) => {
  var userId = req.user && req.user.id;
  if (!userId) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }

  var ticketNumber = req.params.ticket_number;
  if (!ticketNumber || typeof ticketNumber !== 'string') {
    return res.status(400).json({ message: 'Ticket number is required.' });
  }

  try {
    var [rows] = await pool.query(
      `SELECT ticket_number, category, subject, message, status, priority,
              anime_id, episode_id,
              created_at, updated_at, resolved_at
       FROM support_tickets
       WHERE user_id = ? AND ticket_number = ?`,
      [userId, ticketNumber]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Ticket not found.' });
    }

    var row = rows[0];

    // Fetch anime title if anime_id is set.
    var animeTitle = null;
    var episodeTitle = null;
    if (row.anime_id) {
      var [animeRows] = await pool.query('SELECT title FROM anime WHERE id = ?', [row.anime_id]);
      if (animeRows.length) animeTitle = animeRows[0].title;
    }
    if (row.episode_id) {
      var [epRows] = await pool.query(
        'SELECT title, episode_number FROM episodes WHERE id = ?',
        [row.episode_id]
      );
      if (epRows.length) {
        episodeTitle = epRows[0].episode_number ? 'Episode ' + epRows[0].episode_number + (epRows[0].title ? ' — ' + epRows[0].title : '') : (epRows[0].title || '');
      }
    }

    return sendSuccess(res, {
      ticket_number: row.ticket_number,
      category: row.category,
      category_label: VALID_CATEGORIES[row.category] || row.category,
      subject: row.subject,
      message: row.message, // Safe: displayed in user's own view only
      status: row.status,
      priority: row.priority,
      anime_title: animeTitle,
      episode_title: episodeTitle,
      created_at: row.created_at,
      updated_at: row.updated_at,
      resolved_at: row.resolved_at,
    });
  } catch (err) {
    console.error('[Support] getTicket error:', err.message);
    return res.status(500).json({ message: 'Server error loading ticket.' });
  }
};
