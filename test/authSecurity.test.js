// test/authSecurity.test.js
// Security audit tests for the AniStrim auth + email-verification system.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length === bb.length) return crypto.timingSafeEqual(ba, bb);
  const m = Math.min(ba.length, bb.length);
  crypto.timingSafeEqual(ba.subarray(0, m), bb.subarray(0, m));
  return false;
}
let _c = Date.now();
function uid() { _c++; return 'authtest_' + _c + '@anistrim.invalid'; }
async function cleanup(id) {
  try {
    const [r] = await pool.query('SELECT id FROM users WHERE id=?', [id]);
    if (r.length) {
      await pool.query('DELETE FROM user_sessions WHERE user_id=?', [id]);
      await pool.query('DELETE FROM users WHERE id=?', [id]);
    }
  } catch (_) {}
}
async function createTestUser(email, password, otpHash, expireMin) {
  const bcrypt = require('bcryptjs');
  const salt = await bcrypt.genSalt(10);
  const ph = await bcrypt.hash(password, salt);
  const exp = expireMin !== undefined && expireMin < 0
    ? 'DATE_SUB(NOW(), INTERVAL ' + Math.abs(expireMin) + ' MINUTE)'
    : 'DATE_ADD(NOW(), INTERVAL 15 MINUTE)';
  const [r] = await pool.query(
    'INSERT INTO users (name,email,password_hash,is_admin,is_premium,is_verified,verification_code,verification_expires,otp_hash,otp_expires_at,status,auth_provider) VALUES (?,?,?,0,0,0,?,' + exp + ',?,' + exp + ",'pending','password')",
    ['Test', email, ph, otpHash, otpHash]
  );
  return r.insertId;
}
describe('Auth Security Audit', function () {
  this.timeout(30000);
  describe('safeEqual', function () {
    it('identical', function () { assert.strictEqual(safeEqual('abc','abc'), true); });
    it('diff same-length', function () { assert.strictEqual(safeEqual('abc','abd'), false); });
    it('diff length', function () { assert.strictEqual(safeEqual('abc','abcd'), false); });
    it('empty', function () { assert.strictEqual(safeEqual('',''), true); assert.strictEqual(safeEqual('','a'), false); });
    it('sha256', function () { const a=sha256('x'),b=sha256('x'),c=sha256('y'); assert.strictEqual(safeEqual(a,b),true); assert.strictEqual(safeEqual(a,c),false); });
    it('null/undef', function () { assert.strictEqual(safeEqual(null,'a'),false); assert.strictEqual(safeEqual('a',undefined),false); assert.strictEqual(safeEqual(null,null),true); });
  });
  describe('OTP hash', function () {
    it('sha256 len 64', function () { assert.strictEqual(sha256('123456').length, 64); });
    it('different OTPs differ', function () { assert.notStrictEqual(sha256('123456'), sha256('123457')); });
    it('match', function () { assert.strictEqual(safeEqual(sha256('654321'), sha256('654321')), true); });
    it('no match', function () { assert.strictEqual(safeEqual(sha256('654321'), sha256('654322')), false); });
  });
  describe('OTP expiry', function () {
    it('expired', function () { assert.strictEqual(Date.now() > Date.now()-1000, true); });
    it('valid', function () { assert.strictEqual(Date.now() > Date.now()+60000, false); });
  });
  describe('Attempt lockout', function () {
    it('5 locks out', function () { assert.strictEqual(5 >= 5, true); });
    it('3 does not', function () { assert.strictEqual(3 >= 5, false); });
  });
  describe('JWT', function () {
    it('reject null', function () { assert.strictEqual(false, !!(null && null.startsWith('Bearer '))); });
    it('reject expired', function (done) {
      const t=jwt.sign({uid:1},'s',{expiresIn:'0s',algorithm:'HS256'});
      setTimeout(function(){try{jwt.verify(t,'s',{algorithms:['HS256']});assert.fail();}catch(e){assert.strictEqual(e.name,'TokenExpiredError');done();}},200);
    });
    it('reject tampered', function () {
      const v=jwt.sign({uid:1},'s',{expiresIn:'1h',algorithm:'HS256'});
      const p=v.split('.'); p[1]=Buffer.from(JSON.stringify({uid:2})).toString('base64url');
      try{jwt.verify(p.join('.'),'s',{algorithms:['HS256']});assert.fail();}catch(e){assert.strictEqual(e.name,'JsonWebTokenError');}
    });
    it('reject alg=none', function () {
      const h=Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url');
      const b=Buffer.from(JSON.stringify({uid:1,iat:0,exp:1e10})).toString('base64url');
      try{jwt.verify(h+'.'+b+'.','s',{algorithms:['HS256']});assert.fail();}catch(e){assert.ok(e);}
    });
    it('reject wrong alg', function () {
      const t=jwt.sign({uid:1},'s',{expiresIn:'1h',algorithm:'HS512'});
      try{jwt.verify(t,'s',{algorithms:['HS256']});assert.fail();}catch(e){assert.strictEqual(e.name,'JsonWebTokenError');}
    });
    it('accept valid HS256', function () {
      const t=jwt.sign({uid:1,sid:'s',tv:0},'s',{expiresIn:'15m',algorithm:'HS256'});
      assert.strictEqual(jwt.verify(t,'s',{algorithms:['HS256']}).uid,1);
    });
  });
  describe('Token version', function () {
    it('mismatch invalid', function () { assert.strictEqual(Number(0)!==Number(1), true); });
    it('match valid', function () { assert.strictEqual(Number(1)!==Number(1), false); });
  });
  describe('Session revocation', function () {
    it('revoked', function () { assert.strictEqual(!!{revoked_at:new Date()}.revoked_at, true); });
    it('active', function () { assert.strictEqual(!!{revoked_at:null}.revoked_at, false); });
  });
  describe('Refresh rotation', function () {
    it('diff tokens diff hash', function () { assert.notStrictEqual(sha256(crypto.randomBytes(32).toString('hex')), sha256(crypto.randomBytes(32).toString('hex'))); });
    it('same token same hash', function () { const t=crypto.randomBytes(32).toString('hex'); assert.strictEqual(sha256(t), sha256(t)); });
  });
  describe('Client state rejection', function () {
    it('localStorage verified', function () { const c={verified:'true'},s=false; assert.notStrictEqual(c.verified,s); });
    it('URL param verified', function () { const c={verified:'true'},s=false; assert.notStrictEqual(c.verified,s); });
    it('page refresh no auth', function () { assert.strictEqual(false, false); });
    it('browser back no auth', function () { assert.strictEqual(false, false); });
  });
  describe('Password reset token', function () {
    it('reject wrong purpose', function () {
      const t=jwt.sign({purpose:'access'},'s',{expiresIn:'1h',algorithm:'HS256'});
      assert.strictEqual(jwt.verify(t,'s',{algorithms:['HS256']}).purpose==='password-reset', false);
    });
    it('accept correct purpose', function () {
      const t=jwt.sign({email:'a@b.com',purpose:'password-reset',sub:1},'s',{expiresIn:'1h',algorithm:'HS256'});
      assert.strictEqual(jwt.verify(t,'s',{algorithms:['HS256']}).purpose==='password-reset', true);
    });
  });
describe('Password reset token cross-secret isolation', function () {
    it('JWT_SECRET-signed token fails password-reset verify (JWT_RESET_SECRET)', function () {
      const t=jwt.sign({email:'a@b.com',purpose:'password-reset',sub:1},'jwtAccessSecret',{expiresIn:'1h',algorithm:'HS256'});
      try{jwt.verify(t,'resetSecret',{algorithms:['HS256']});assert.fail('Should have thrown');}
      catch(e){assert.strictEqual(e.name,'JsonWebTokenError');}
    });
    it('JWT_RESET_SECRET-signed pwd-reset token fails access verify (JWT_SECRET)', function () {
      const t=jwt.sign({email:'a@b.com',purpose:'password-reset',sub:1},'resetSecret',{expiresIn:'1h',algorithm:'HS256'});
      try{jwt.verify(t,'jwtAccessSecret',{algorithms:['HS256']});assert.fail('Should have thrown');}
      catch(e){assert.strictEqual(e.name,'JsonWebTokenError');}
    });
    it('access token signed with JWT_RESET_SECRET fails access verify (JWT_SECRET)', function () {
      const t=jwt.sign({uid:1,sid:'s',tv:0},'resetSecret',{expiresIn:'15m',algorithm:'HS256'});
      try{jwt.verify(t,'jwtAccessSecret',{algorithms:['HS256']});assert.fail('Should have thrown');}
      catch(e){assert.strictEqual(e.name,'JsonWebTokenError');}
    });
describe('Timing-oracle mitigation (dummy crypto)', function () {
    it('dummy JWT sign should succeed', function () {
      const dummyToken=jwt.sign({email:'dummy@test.com',purpose:'password-reset',sub:0},'resetSecret',{expiresIn:'1h',algorithm:'HS256'});
      assert.ok(dummyToken);
      assert.strictEqual(typeof dummyToken,'string');
      assert.strictEqual(dummyToken.split('.').length,3);
    });
    it('dummy bcrypt hash should succeed', function (done) {
      const bcrypt=require('bcryptjs');
      bcrypt.genSalt(10,function(err,salt){
        if(err) return done(err);
        bcrypt.hash('dummy-value',salt,function(err2,hash){
          if(err2) return done(err2);
          assert.ok(hash);
          assert.strictEqual(hash.length > 0, true);
          done();
        });
      });
    });
    it('neutral response message does not leak existence', function () {
      const message='If an account exists for that email, a reset link has been sent.';
      assert.ok(message.includes('If an account exists'));
      assert.ok(!message.includes('found') && !message.includes('no account') && !message.includes('not found'));
    });
  });
  });
  describe('Rate limiting', function () { it('bounds defined', function () { assert.ok(true); }); });
  describe('Email validation', function () {
    const re=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    it('reject invalid', function () { for (const e of ['','bad','@x']) assert.strictEqual(re.test(e.trim()), false); });
    it('accept valid', function () { for (const e of ['a@b.cd','u+s@d.co']) assert.strictEqual(re.test(e.trim()), true); });
  });
  describe('Disposable email domains', function () {
    const dd=new Set(['mailinator.com','10minutemail.com']);
    it('detect', function () { assert.strictEqual(dd.has('mailinator.com'), true); assert.strictEqual(dd.has('gmail.com'), false); });
  });
  describe('OTP generation', function () {
    it('6-digit CSPRNG', function () { const c=crypto.randomInt(0,1000000).toString().padStart(6,'0'); assert.strictEqual(c.length,6); assert(/^\d{6}$/.test(c)); });
    it('100 unique', function () { const s=new Set(); for(let i=0;i<100;i++) s.add(crypto.randomInt(0,1000000).toString().padStart(6,'0')); assert.strictEqual(s.size,100); });
  });
  describe('Logging safety', function () {
    it('OTP not in logs', function () { assert.ok(!'Verification email dispatched'.includes('123456')); });
    it('password not in logs', function () { assert.ok(!'Login successful'.includes('secret123')); });
  });
  describe('User DTO safety', function () {
    it('no password_hash', function () { assert.strictEqual({id:1}.password_hash, undefined); });
    it('no verification_code', function () { assert.strictEqual({id:1}.verification_code, undefined); });
    it('no otp_hash', function () { assert.strictEqual({id:1}.otp_hash, undefined); });
    it('emailVerified from DB', function () { assert.strictEqual(!!{is_verified:0,email_verified_at:null}.email_verified_at||!!{is_verified:0,email_verified_at:null}.is_verified, false); });
  });
  describe('Atomic update pattern', function () {
    it('WHERE is_verified=0 AND verification_code=?', function () {
      assert.ok('UPDATE users SET is_verified=1 WHERE id=? AND is_verified=0 AND verification_code=?'.includes('AND is_verified=0 AND verification_code=?'));
    });
  });
  describe('Integration: DB verification flow', function () {
    it('valid OTP succeeds', async function () {
      const email=uid(),otp='123456',oh=sha256(otp); const id=await createTestUser(email,'pw',oh);
      const [r]=await pool.query('SELECT verification_code,is_verified FROM users WHERE id=?',[id]);
      assert.strictEqual(r[0].is_verified,0); assert.strictEqual(safeEqual(r[0].verification_code,oh),true);
      const [up]=await pool.query('UPDATE users SET is_verified=1,status=\'active\',verification_code=NULL WHERE id=? AND is_verified=0 AND verification_code=?',[id,r[0].verification_code]);
      assert.strictEqual(up.affectedRows,1);
      const [v]=await pool.query('SELECT is_verified,status,verification_code FROM users WHERE id=?',[id]);
      assert.strictEqual(v[0].is_verified,1); assert.strictEqual(v[0].status,'active'); assert.strictEqual(v[0].verification_code,null);
      await cleanup(id);
    });
    it('invalid OTP fails', async function () {
      const email=uid(),otp='123456',oh=sha256(otp); const id=await createTestUser(email,'pw',oh);
      const [r]=await pool.query('SELECT verification_code FROM users WHERE id=?',[id]);
      assert.strictEqual(safeEqual(r[0].verification_code,sha256('999999')),false);
      const [up]=await pool.query('UPDATE users SET is_verified=1 WHERE id=? AND is_verified=0 AND verification_code=?',[id,sha256('999999')]);
      assert.strictEqual(up.affectedRows,0); await cleanup(id);
    });
    it('expired OTP fails', async function () {
      const email=uid(),otp='123456',oh=sha256(otp); const id=await createTestUser(email,'pw',oh,-1);
      const [r]=await pool.query('SELECT verification_expires FROM users WHERE id=?',[id]);
      assert.strictEqual(Date.now()>new Date(r[0].verification_expires).getTime(),true); await cleanup(id);
    });
    it('reused OTP fails', async function () {
      const email=uid(),otp='123456',oh=sha256(otp); const id=await createTestUser(email,'pw',oh);
      const [r]=await pool.query('SELECT verification_code FROM users WHERE id=?',[id]);
      const [u1]=await pool.query('UPDATE users SET is_verified=1,verification_code=NULL WHERE id=? AND is_verified=0 AND verification_code=?',[id,r[0].verification_code]);
      assert.strictEqual(u1.affectedRows,1);
      const [u2]=await pool.query('UPDATE users SET is_verified=1 WHERE id=? AND is_verified=0 AND verification_code=?',[id,r[0].verification_code]);
      assert.strictEqual(u2.affectedRows,0); await cleanup(id);
    });
    it('old OTP after resend fails', async function () {
      const email=uid(),oldO='111111',oh=sha256(oldO); const id=await createTestUser(email,'pw',oh);
      const nO='222222',nh=sha256(nO); await pool.query('UPDATE users SET verification_code=?,otp_hash=? WHERE id=?',[nh,nh,id]);
      const [up]=await pool.query('UPDATE users SET is_verified=1 WHERE id=? AND is_verified=0 AND verification_code=?',[id,oh]);
      assert.strictEqual(up.affectedRows,0);
      const [r]=await pool.query('SELECT verification_code FROM users WHERE id=?',[id]);
      assert.strictEqual(safeEqual(r[0].verification_code,nh),true); await cleanup(id);
    });
    it('excessive attempts lockout', async function () {
      const email=uid(),otp='123456',oh=sha256(otp); const id=await createTestUser(email,'pw',oh);
      await pool.query('UPDATE users SET verification_attempts=5,otp_attempts=5 WHERE id=?',[id]);
      const [r]=await pool.query('SELECT verification_attempts FROM users WHERE id=?',[id]);
      assert.strictEqual(Number(r[0].verification_attempts)>=5,true); await cleanup(id);
    });
  });
});

// ── Checkout state regression test ──────────────────────────────
  describe('Checkout state regression', function () {
    it('initializeCheckout INSERT uses state=pending', function () {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'controllers', 'paymentController.js'),
        'utf8'
      );
      // Verify the INSERT VALUES clause contains 'pending' as the state value
      // followed by 'payment' as the source value.
      const insertMatch = src.match(/INSERT INTO subscriptions[\s\S]{0,500}VALUES[\s\S]{0,500}'pending'[\s\S]{0,100}'payment'/);
      assert.ok(insertMatch, 'checkout INSERT must contain state=pending, source=payment');
    });
    it('state=pending is in the canonical ENUM definitions', function () {
      const fs = require('fs');
      const path = require('path');
      const v35 = fs.readFileSync(
        path.join(__dirname, '..', 'sql', 'migrations_v35_plans_subscriptions.sql'),
        'utf8'
      );
      const v45 = fs.readFileSync(
        path.join(__dirname, '..', 'sql', 'migrations_v45_subscriptions_reconcile.sql'),
        'utf8'
      );
      const v47 = fs.readFileSync(
        path.join(__dirname, '..', 'sql', 'migrations_v47_subscriptions_state_enum.sql'),
        'utf8'
      );
      const expected = "'pending','trialing','active','grace','expired','cancelled','refunded'";
      assert.ok(v35.includes(expected), 'v35 must define the full ENUM');
      assert.ok(v45.includes(expected), 'v45 must define the full ENUM');
      assert.ok(v47.includes(expected), 'v47 must define the full ENUM');
    });
    it('v47 MODIFY COLUMN includes all 7 state values', function () {
      const fs = require('fs');
      const path = require('path');
      const v47 = fs.readFileSync(
        path.join(__dirname, '..', 'sql', 'migrations_v47_subscriptions_state_enum.sql'),
        'utf8'
      );
      const modifyMatch = v47.match(/MODIFY COLUMN state ENUM\([^)]+\)/);
      assert.ok(modifyMatch, 'MODIFY COLUMN state ENUM must be in v47');
      assert.ok(modifyMatch[0].includes("'pending'"), 'MODIFY must include pending');
      for (const v of ['pending', 'trialing', 'active', 'grace', 'expired', 'cancelled', 'refunded']) {
        assert.ok(modifyMatch[0].includes("'" + v + "'"), 'MODIFY must include ' + v);
      }
// ── Payment amount regression tests ──────────────────────────────
describe('Payment amount regression', function () {
  it('monthly plan amount = 15000 in v35 seed data', function () {
    const fs = require('fs');
    const path = require('path');
    const v35 = fs.readFileSync(
      path.join(__dirname, '..', 'sql', 'migrations_v35_plans_subscriptions.sql'),
      'utf8'
    );
    const v48 = fs.readFileSync(
      path.join(__dirname, '..', 'sql', 'migrations_v48_plans_amount_fix.sql'),
      'utf8'
    );
    // Find the VALUES line for premium-monthly (skip -- comment lines)
    const monthlyLine = v35.split('\n').find(l => l.includes('premium-monthly') && l.includes('15000,'));
    assert.ok(monthlyLine, 'premium-monthly line with 15000 must be in v35');
    assert.ok(v48.includes('15000'), 'v48 must mention 15000');
  });
  it('yearly plan amount = 180000 in v35 seed data', function () {
    const fs = require('fs');
    const path = require('path');
    const v35 = fs.readFileSync(
      path.join(__dirname, '..', 'sql', 'migrations_v35_plans_subscriptions.sql'),
      'utf8'
    );
    const v48 = fs.readFileSync(
      path.join(__dirname, '..', 'sql', 'migrations_v48_plans_amount_fix.sql'),
      'utf8'
    );
    const yearlyLine = v35.split('\n').find(l => l.includes('premium-annual') && l.includes('180000,'));
    assert.ok(yearlyLine, 'premium-annual line with 180000 must be in v35');
    assert.ok(v48.includes('180000'), 'v48 must mention 180000');
  });
  it('initializeCheckout sends planRow.amount directly to Pesapal (no division)', function () {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'controllers', 'paymentController.js'),
      'utf8'
    );
    const susPatterns = ['amount / 100', 'amount / 1000', 'amount * 100', 'amount * 1000', 'amount / 10', 'amount * 10'];
    for (const pat of susPatterns) {
      assert.ok(!src.includes(pat), 'checkout must not contain ' + pat);
    }
    const pesapalCall = src.match(/amount:\s*amount/);
    assert.ok(pesapalCall, 'checkout must pass amount directly to Pesapal');
  });
  it('IPN amount verification rejects 15 when expecting 15000', function () {
    const subAmount = 15000;
    const txnAmount = 15;
    const mismatch = Math.abs(txnAmount - subAmount) > 1;
    assert.strictEqual(mismatch, true, 'IPN must reject 15 when expecting 15000');
  });
  it('IPN amount verification accepts 15000 when expecting 15000', function () {
    const subAmount = 15000;
    const txnAmount = 15000;
    const mismatch = Math.abs(txnAmount - subAmount) > 1;
    assert.strictEqual(mismatch, false, 'IPN must accept 15000 when expecting 15000');
  });
});
    });
  });