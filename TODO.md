# Nightly Validation Suite — Implementation TODO

## Phase 1: Core Framework

- [ ] Create `validation/reporters.js` — report writer + reports dir management (latest + date-stamped)
- [ ] Create `validation/context.js` — shared validation context factory
- [ ] Create `validation/runner.js` — plugin loader/executor with PASS/PARTIAL/FAIL exit codes

## Phase 2: Validators

- [ ] Create `validation/validators/providerValidator.js`
- [ ] Create `validation/validators/streamValidator.js`
- [ ] Create `validation/validators/subtitleValidator.js`
- [ ] Create `validation/validators/metadataValidator.js`
- [ ] Create `validation/validators/cacheValidator.js`
- [ ] Create `validation/validators/concurrencyValidator.js`
- [ ] Create `validation/validators/failureValidator.js`
- [ ] Create `validation/validators/searchValidator.js`
- [ ] Create `validation/validators/healthValidator.js`

## Phase 3: Aggregation

- [ ] Create `validation/readiness.js` — aggregate reports → production-readiness-report.md + .json
- [ ] Create `validation/index.js` — orchestrator entry point

## Phase 4: Wiring

- [ ] Add `validate:nightly` script to `package.json`

## Phase 5: Verification

- [ ] Syntax-check all validation files
- [ ] Run `npm run validate:nightly`
- [ ] Verify all 10 reports exist under `reports/nightly/` + `reports/latest/`
- [ ] Verify exit codes (PASS=0, PARTIAL=0+warnings, FAIL=1)
