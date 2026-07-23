// upgrade.js — Pesapal Payment
// Monthly: UGX 15,000 | Yearly: UGX 180,000
let selectedPlan = 'monthly';

function selectPlan(plan) {
  if (plan !== 'monthly' && plan !== 'yearly') return;
  selectedPlan = plan;
  console.log('Plan selected:', selectedPlan);

  document.querySelectorAll('.plan-option').forEach(el => {
    const isSelected = el.dataset.plan === plan;
    el.classList.toggle('selected', isSelected);
    el.style.borderColor = isSelected ? 'var(--purple)' : 'var(--border)';
    el.style.opacity = isSelected ? '1' : '0.75';
  });
}
window.selectPlan = selectPlan;

async function handleUpgrade() {
  if (!State.isLoggedIn) { window.location.href = 'login.html'; return; }
  if (State.isPremium) { alert('You are already a Premium member! 👑'); return; }

  const btn = document.getElementById('upgrade-btn');
  console.log('Upgrading with plan:', selectedPlan);

  btn.textContent = 'Processing...';
  btn.disabled = true;

  try {
    const { ok, data } = await apiFetch('/api/payments/initiate', {
      method: 'POST',
      body: JSON.stringify({ plan: selectedPlan })
    });

    if (ok && data.payment_link) {
      localStorage.setItem('pending_tx_ref', data.tx_ref);
      window.location.href = data.payment_link;
    } else {
      alert(data.message || 'Could not start payment. Please try again.');
      btn.textContent = 'Confirm Upgrade';
      btn.disabled = false;
    }
  } catch (e) {
    console.error('Payment error:', e);
    alert('Server error. Please try again.');
    btn.textContent = 'Confirm Upgrade';
    btn.disabled = false;
  }
}
window.handleUpgrade = handleUpgrade;

document.addEventListener('DOMContentLoaded', () => {
  selectPlan('monthly');

  if (State.isPremium) {
    const btn = document.getElementById('upgrade-btn');
    if (btn) {
      btn.textContent = 'Already Premium ✓';
      btn.style.background = 'rgba(255,255,255,0.1)';
      btn.style.cursor = 'default';
      btn.disabled = true;
    }
  }
});
