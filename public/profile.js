// Shared profile dropdown for both dashboard and operations pages.
// Renders a header avatar with menu (Profile / Sign out) and a Profile modal
// for editing name, email, and password.

(function() {
  function escape(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    return ((parts[0]||'')[0] + (parts[1]||'')[0] || parts[0][0]).toUpperCase();
  }

  window.ProfileDropdown = {
    /**
     * Mount the dropdown into a container element.
     * @param {HTMLElement} container
     * @param {{id,name,email,role}} user
     * @param {() => void} onProfileUpdated  optional callback after name/email change
     */
    mount(container, user, onProfileUpdated) {
      const ini = initials(user.name);
      const roleBadge = user.role === 'admin'
        ? '<span class="vs-pdrop-role admin">ADMIN</span>'
        : '<span class="vs-pdrop-role">USER</span>';

      container.innerHTML = `
        <div class="vs-profile-dropdown" id="vs-pdrop-root">
          <button class="vs-pdrop-trigger" id="vs-pdrop-trigger" type="button" aria-haspopup="true" aria-expanded="false">
            <span class="vs-pdrop-avatar">${escape(ini)}</span>
            <span class="vs-pdrop-name">${escape(user.name)}</span>
            <svg class="vs-pdrop-caret" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="vs-pdrop-menu" id="vs-pdrop-menu" role="menu" hidden>
            <div class="vs-pdrop-header">
              <div class="vs-pdrop-name-full">${escape(user.name)}</div>
              <div class="vs-pdrop-email">${escape(user.email)}</div>
              ${roleBadge}
            </div>
            <button class="vs-pdrop-item" id="vs-pdrop-profile" type="button">Profile settings</button>
            <button class="vs-pdrop-item" id="vs-pdrop-password" type="button">Change password</button>
            <div class="vs-pdrop-sep"></div>
            <button class="vs-pdrop-item vs-pdrop-signout" id="vs-pdrop-signout" type="button">Sign out</button>
          </div>
        </div>

        <div class="vs-modal" id="vs-profile-modal" hidden>
          <div class="vs-modal-backdrop"></div>
          <div class="vs-modal-dialog">
            <div class="vs-modal-head">
              <h3>Profile settings</h3>
              <button class="vs-modal-close" id="vs-profile-close" type="button" aria-label="Close">×</button>
            </div>
            <form id="vs-profile-form" class="vs-modal-body">
              <label class="vs-label">Display name</label>
              <input class="vs-input" id="vs-prof-name" type="text" required>

              <label class="vs-label" style="margin-top: 12px;">Email address</label>
              <input class="vs-input" id="vs-prof-email" type="email" required>

              <div class="vs-modal-msg" id="vs-prof-msg"></div>

              <div class="vs-modal-actions">
                <button type="button" class="vs-btn vs-btn-secondary" id="vs-prof-cancel">Cancel</button>
                <button type="submit" class="vs-btn">Save changes</button>
              </div>
            </form>
          </div>
        </div>

        <div class="vs-modal" id="vs-pw-modal" hidden>
          <div class="vs-modal-backdrop"></div>
          <div class="vs-modal-dialog">
            <div class="vs-modal-head">
              <h3>Change password</h3>
              <button class="vs-modal-close" id="vs-pw-close" type="button" aria-label="Close">×</button>
            </div>
            <form id="vs-pw-form" class="vs-modal-body">
              <label class="vs-label">Current password</label>
              <input class="vs-input" id="vs-pw-current" type="password" required>

              <label class="vs-label" style="margin-top: 12px;">New password</label>
              <input class="vs-input" id="vs-pw-new" type="password" minlength="8" required>
              <div class="vs-input-hint">At least 8 characters</div>

              <label class="vs-label" style="margin-top: 12px;">Confirm new password</label>
              <input class="vs-input" id="vs-pw-confirm" type="password" minlength="8" required>

              <div class="vs-modal-msg" id="vs-pw-msg"></div>

              <div class="vs-modal-actions">
                <button type="button" class="vs-btn vs-btn-secondary" id="vs-pw-cancel">Cancel</button>
                <button type="submit" class="vs-btn">Change password</button>
              </div>
            </form>
          </div>
        </div>
      `;

      const $ = (id) => document.getElementById(id);
      const trigger = $('vs-pdrop-trigger');
      const menu = $('vs-pdrop-menu');
      let open = false;
      const setOpen = (v) => {
        open = v;
        menu.hidden = !v;
        trigger.setAttribute('aria-expanded', v ? 'true' : 'false');
      };

      trigger.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); });
      document.addEventListener('click', (e) => {
        if (open && !$('vs-pdrop-root').contains(e.target)) setOpen(false);
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setOpen(false); });

      function showModal(id) { $(id).hidden = false; }
      function hideModal(id) { $(id).hidden = true; }

      $('vs-pdrop-profile').onclick = () => {
        setOpen(false);
        $('vs-prof-name').value = user.name;
        $('vs-prof-email').value = user.email;
        $('vs-prof-msg').textContent = '';
        showModal('vs-profile-modal');
        $('vs-prof-name').focus();
      };
      $('vs-pdrop-password').onclick = () => {
        setOpen(false);
        $('vs-pw-current').value = ''; $('vs-pw-new').value = ''; $('vs-pw-confirm').value = '';
        $('vs-pw-msg').textContent = '';
        showModal('vs-pw-modal');
        $('vs-pw-current').focus();
      };
      $('vs-pdrop-signout').onclick = async () => {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/';
      };

      // Close handlers
      $('vs-profile-close').onclick = () => hideModal('vs-profile-modal');
      $('vs-prof-cancel').onclick = () => hideModal('vs-profile-modal');
      $('vs-pw-close').onclick = () => hideModal('vs-pw-modal');
      $('vs-pw-cancel').onclick = () => hideModal('vs-pw-modal');
      document.querySelectorAll('.vs-modal-backdrop').forEach(b => {
        b.onclick = () => { b.parentElement.hidden = true; };
      });

      $('vs-profile-form').onsubmit = async (e) => {
        e.preventDefault();
        const name = $('vs-prof-name').value.trim();
        const email = $('vs-prof-email').value.trim();
        const msg = $('vs-prof-msg');
        msg.textContent = 'Saving…'; msg.className = 'vs-modal-msg';
        const r = await fetch('/api/profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email })
        });
        const d = await r.json();
        if (!r.ok) {
          msg.textContent = d.error || 'Failed to save'; msg.className = 'vs-modal-msg error';
          return;
        }
        // Update local state and trigger element
        user.name = d.user.name; user.email = d.user.email;
        document.querySelector('.vs-pdrop-avatar').textContent = initials(user.name);
        document.querySelector('.vs-pdrop-name').textContent = user.name;
        document.querySelector('.vs-pdrop-name-full').textContent = user.name;
        document.querySelector('.vs-pdrop-email').textContent = user.email;
        msg.textContent = '✓ Saved'; msg.className = 'vs-modal-msg success';
        setTimeout(() => { hideModal('vs-profile-modal'); }, 700);
        if (onProfileUpdated) onProfileUpdated(d.user);
      };

      $('vs-pw-form').onsubmit = async (e) => {
        e.preventDefault();
        const current = $('vs-pw-current').value;
        const next = $('vs-pw-new').value;
        const confirm = $('vs-pw-confirm').value;
        const msg = $('vs-pw-msg');
        if (next !== confirm) { msg.textContent = "New passwords don't match"; msg.className = 'vs-modal-msg error'; return; }
        msg.textContent = 'Changing…'; msg.className = 'vs-modal-msg';
        const r = await fetch('/api/password/change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current, next })
        });
        const d = await r.json();
        if (!r.ok) {
          msg.textContent = d.error || 'Failed'; msg.className = 'vs-modal-msg error';
          return;
        }
        msg.textContent = '✓ Password changed'; msg.className = 'vs-modal-msg success';
        setTimeout(() => { hideModal('vs-pw-modal'); }, 900);
      };
    }
  };
})();
