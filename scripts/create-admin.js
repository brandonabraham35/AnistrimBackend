const bcrypt = require('bcryptjs');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('--- AniStrim Admin User Creation Script ---');
console.log('This script will generate an SQL query to create or update an admin user with a securely hashed password.');

const questions = [
  'Enter admin email (e.g., admin@anistrim.com): ',
  'Enter admin name (e.g., Admin User): ',
  'Enter a secure password (will not be shown): '
];

const askQuestion = (query) => {
  return new Promise(resolve => rl.question(query, resolve));
};

const escapeSql = (str) => {
  if (str === null || str === undefined) {
    return 'NULL';
  }
  return "'" + String(str).replace(/[\\$'"]/g, "\\$&") + "'";
};

const printWarning = () => {
  console.warn(`
  =================================================================
  ==  SECURITY WARNING                                           ==
  =================================================================
  This script generates a raw SQL query. For a live application,
  NEVER construct queries this way with user input. Always use
  parameterized queries (prepared statements) to prevent SQL
  injection attacks. This script is for developer use only.
  =================================================================
  `);
};

async function main() {
  const email = await askQuestion(questions[0]);
  const name = await askQuestion(questions[1]);
  const password = await askQuestion(questions[2]);

  if (!email || !name || !password) {
    console.error('\n❌ Error: All fields are required.');
    rl.close();
    return;
  }

  console.log('\nGenerating password hash...');
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  console.log('✅ Hash generated successfully.');
  console.log(`   Hash starts with: ${passwordHash.substring(0, 10)}...`);

  const sqlQuery = `
-- =============================================================================
--  Run this SQL query in your database client to create/update the admin user.
--  WARNING: This uses REPLACE, which will delete and re-insert the row if
--           a user with the same primary key (email) exists.
-- =============================================================================
REPLACE INTO users (name, email, password_hash, is_admin, is_premium, created_at, status)
VALUES
(${escapeSql(name)}, ${escapeSql(email)}, '${passwordHash}', 1, 1, NOW(), 'active');
-- =============================================================================
`;

  console.log('\n✅ SQL Query Generated:\n');
  console.log(sqlQuery);
  printWarning();

  rl.close();
}

main();