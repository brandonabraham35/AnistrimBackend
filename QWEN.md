# AniStrim Backend - Qwen Code Instructions

## Project Rules

You are working on the AniStrimBackend2 codebase.

Before modifying anything:

1. Inspect the existing project structure.
2. Understand the existing architecture and conventions.
3. Search for all relevant usages of the code being changed.
4. Never assume a database column, table, endpoint, environment variable, or function exists.
5. Verify database schema against actual SQL/migrations before changing database queries.
6. Preserve existing functionality unless the requested change explicitly requires otherwise.
7. Do not rewrite large portions of the application unnecessarily.
8. Do not modify unrelated files.
9. Prefer the smallest safe change that fixes the root cause.
10. Never hide errors by simply removing functionality.

## Database Rules

The database is authoritative.

Before changing SQL queries:

- Inspect the relevant table schema.
- Check migrations/schema files.
- Check existing repository/service queries.
- Verify column names and relationships.
- Check whether timestamps such as created_at and updated_at actually exist.
- Do not invent database columns.

If a query references a nonexistent column:

1. Identify the query.
2. Identify the table alias.
3. Inspect the actual schema.
4. Determine whether the application or database is incorrect.
5. Fix the root cause.
6. Check all other queries using the same table.
7. Test the affected endpoint.

## Debugging Rules

When an error is reported:

1. Reproduce or trace the error.
2. Locate the exact source file and line.
3. Follow the call chain.
4. Inspect related database/API/frontend code.
5. Determine the root cause.
6. Implement the smallest correct fix.
7. Run appropriate tests/checks.
8. Review the resulting Git diff.
9. Report exactly what changed and why.

Do not guess.

## Backend Rules

Before modifying an endpoint:

- Inspect the route.
- Inspect the controller.
- Inspect the service.
- Inspect the repository/data-access layer.
- Inspect validation.
- Inspect database interactions.
- Check authentication/authorization.
- Check frontend consumers if the API contract changes.

Maintain existing API contracts unless the requested change requires a breaking change.

## Frontend Rules

Before modifying frontend API calls:

- Inspect the backend endpoint.
- Verify HTTP method.
- Verify URL.
- Verify request body.
- Verify authentication requirements.
- Verify response structure.

Do not change frontend code to compensate for an incorrectly implemented backend endpoint.

## Security

Never expose:

- API keys
- passwords
- database credentials
- session secrets
- JWT secrets
- private tokens

Do not commit `.env` files or secrets.

Use existing environment variables.

## Git Rules

Before making major changes:

- Inspect `git status`.
- Review relevant existing changes.
- Do not discard user changes.
- Do not run destructive Git commands unless explicitly requested.

After changes:

- Run appropriate tests.
- Run lint/type checks when available.
- Review `git diff`.
- Summarize modified files.

## Dependency Rules

Do not install new packages unless necessary.

Before installing a dependency:

1. Check whether an existing dependency already provides the functionality.
2. Check package.json.
3. Explain why the new dependency is required.

Avoid unnecessary upgrades.

## Testing

After fixing a bug:

- Run the most relevant test first.
- Run additional tests when appropriate.
- Check application startup.
- Check the affected endpoint/function.
- Verify there are no obvious regressions.

If tests cannot be run, explain why.

## Communication

When solving a problem, report:

### Root Cause

What actually caused the problem.

### Files Changed

Every file modified.

### Fix

What was changed.

### Verification

What was tested.

### Remaining Issues

Anything that still needs attention.

Do not claim a fix is complete unless it has been verified.

## Important

Do not blindly execute commands.

Before potentially destructive operations such as:

- deleting files
- dropping database tables
- resetting databases
- force Git operations
- removing dependencies
- rewriting large sections of code

ask for confirmation first.

For normal safe development operations, proceed without unnecessary confirmation.
