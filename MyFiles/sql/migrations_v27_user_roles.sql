-- migrations_v27_user_roles.sql
-- P1 (Defect 6): move the admin role off the profile row (users.is_admin) into a
-- dedicated role table, and make admin authorization check it fresh per request
-- instead of trusting a stale JWT claim.
--
-- MySQL has no Postgres RLS/SECURITY DEFINER, so enforcement is done in the
-- application layer: `utils/hasRole.js` queries this table, and middleware/auth.js
-- adminOnly uses it on every admin request.

CREATE TABLE IF NOT EXISTS user_roles (
  user_id   INT          NOT NULL,
  role      VARCHAR(16)  NOT NULL DEFAULT 'user',
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Any existing admin gets the 'admin' role (keeps behavior unchanged until a
-- role is explicitly removed).
INSERT IGNORE INTO user_roles (user_id, role)
SELECT id, 'admin' FROM users WHERE is_admin = 1;

-- Guarantee the default admin bootstrap user is an admin in the role table too.
INSERT IGNORE INTO user_roles (user_id, role)
SELECT u.id, 'admin'
FROM users u
LEFT JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin'
WHERE u.email = COALESCE(@admin_email, 'admin@anistrim.com') AND r.user_id IS NULL;