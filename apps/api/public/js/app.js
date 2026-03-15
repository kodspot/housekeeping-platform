/* ========================================================================
   HOUSEKEEPING — Shared Application JavaScript
   Auth, API, Toast, Nav, Retry, Utilities
   ======================================================================== */
'use strict';
window.App = (function () {
  const API = '/api';

  // ─── Org-Aware Routing ───
  var NON_ORG_PREFIXES = ['superadmin-login', 'superadmin-dashboard', 's', 'api', 'scan'];

  function getOrgSlug() {
    // Try URL path first: /kle/admin-dashboard → 'kle'
    var parts = location.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && NON_ORG_PREFIXES.indexOf(parts[0]) === -1) {
      var candidate = parts[0];
      if (/^[a-z0-9][a-z0-9-]*$/.test(candidate)) return candidate;
    }
    // Fallback to sessionStorage (set during login)
    var stored = sessionStorage.getItem('orgSlug');
    if (stored && /^[a-z0-9][a-z0-9-]*$/.test(stored)) return stored;
    return null;
  }

  function orgPath(page) {
    var slug = getOrgSlug();
    return slug ? '/' + slug + '/' + page : '/' + page;
  }

  // ─── DOM Helpers ───
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function fmtDate(s) {
    if (!s) return '—';
    return new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function fmtDateShort(s) {
    if (!s) return '—';
    return new Date(s).toLocaleDateString();
  }

  // ─── Token Management ───
  function getToken() { return sessionStorage.getItem('token'); }
  function getSupToken() { return sessionStorage.getItem('sup_token'); }

  function getUser() {
    try { return JSON.parse(sessionStorage.getItem('user') || '{}'); }
    catch { return {}; }
  }

  function getSupUser() {
    try { return JSON.parse(sessionStorage.getItem('sup_user') || '{}'); }
    catch { return {}; }
  }

  function adminHeaders(includeJson) {
    const h = { 'Authorization': 'Bearer ' + getToken() };
    if (includeJson !== false) h['Content-Type'] = 'application/json';
    const oid = sessionStorage.getItem('selectedOrgId');
    if (oid) h['X-Org-Id'] = oid;
    return h;
  }

  function supHeaders() {
    return { 'Authorization': 'Bearer ' + getSupToken() };
  }

  // ─── API Fetch with Retry ───
  function _adminLoginRedirect() {
    try { var u = JSON.parse(sessionStorage.getItem('user') || '{}'); if (u.role === 'SUPER_ADMIN') return '/superadmin-login'; } catch(e) {}
    return orgPath('admin-login');
  }

  async function apiFetch(path, opts) {
    opts = opts || {};
    const headers = { ...adminHeaders(!(opts.body instanceof FormData)), ...(opts.headers || {}) };
    if (opts.body instanceof FormData) delete headers['Content-Type'];
    const fetchOpts = { ...opts, headers };
    return _doFetch(path, fetchOpts, _adminLoginRedirect());
  }

  async function supFetch(path, opts) {
    opts = opts || {};
    const headers = { ...supHeaders(), ...(opts.headers || {}) };
    if (opts.body instanceof FormData) delete headers['Content-Type'];
    else if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
    const fetchOpts = { ...opts, headers };
    return _doFetch(path, fetchOpts, orgPath('supervisor-login'));
  }

  async function _doFetch(path, fetchOpts, loginRedirect) {
    var lastErr;
    for (var i = 0; i < 3; i++) {
      try {
        var res = await fetch(API + path, fetchOpts);
        if (res.status === 401) {
          sessionStorage.clear();
          location.href = loginRedirect;
          return null;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (i < 2) await _wait(1000 * (i + 1));
      }
    }
    toast('Network error. Please check your connection.', 'error');
    throw lastErr;
  }

  function _wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // JSON convenience
  async function apiFetchJson(path, opts) {
    var res = await apiFetch(path, opts);
    if (!res) return null;
    return res.json();
  }
  async function supFetchJson(path, opts) {
    var res = await supFetch(path, opts);
    if (!res) return null;
    return res.json();
  }

  // ─── Logout ───
  function logout() {
    var slug = getOrgSlug();
    sessionStorage.clear();
    location.href = slug ? '/' + slug + '/admin-login' : '/admin-login';
  }

  function logoutSA() {
    sessionStorage.clear();
    location.href = '/superadmin-login';
  }

  function logoutSup() {
    var slug = getOrgSlug();
    sessionStorage.removeItem('sup_token');
    sessionStorage.removeItem('sup_user');
    location.href = slug ? '/' + slug + '/supervisor-login' : '/supervisor-login';
  }

  // ─── Toast Notifications ───
  var toastWrap = null;

  function _ensureToast() {
    if (!toastWrap) {
      toastWrap = document.createElement('div');
      toastWrap.className = 'toast-wrap';
      document.body.appendChild(toastWrap);
    }
  }

  function toast(msg, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    _ensureToast();
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    var icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    el.innerHTML = '<span>' + (icons[type] || '') + '</span><span>' + esc(msg) + '</span>';
    toastWrap.appendChild(el);
    setTimeout(function () {
      el.classList.add('removing');
      setTimeout(function () { el.remove(); }, 300);
    }, duration);
  }

  // ─── Confirm Dialog ───
  function confirmDialog(msg) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay show';
      overlay.style.zIndex = '150';
      overlay.innerHTML =
        '<div class="modal" style="max-width:380px;text-align:center;animation:modalSlideIn .25s ease">' +
        '<div style="font-size:2rem;margin-bottom:.75rem">⚠️</div>' +
        '<p style="margin-bottom:1.25rem;font-size:.95rem;line-height:1.5;color:var(--text)">' + esc(msg) + '</p>' +
        '<div class="modal-actions" style="justify-content:center;border-top:none;padding-top:0">' +
        '<button class="btn btn-outline" id="_cfmNo">Cancel</button>' +
        '<button class="btn btn-danger" id="_cfmYes">Confirm</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      overlay.querySelector('#_cfmYes').onclick = function () { overlay.remove(); resolve(true); };
      overlay.querySelector('#_cfmNo').onclick = function () { overlay.remove(); resolve(false); };
      overlay.addEventListener('click', function (e) { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    });
  }

  // ─── Org Branding in Topbar ───
  function _applyOrgBrand() {
    var orgName = sessionStorage.getItem('orgName') || sessionStorage.getItem('selectedOrgName');
    if (!orgName) return;
    var brandEl = document.querySelector('.topbar-brand');
    if (!brandEl) return;
    brandEl.innerHTML = esc(orgName) + '<span class="topbar-powered"> · Kodspot</span>';
  }

  // ─── Admin Navigation ───
  var NAV_ITEMS = [
    { page: 'admin-dashboard', label: 'Dashboard' },
    { page: 'admin-analytics', label: 'Analytics' },
    { page: 'admin-locations', label: 'Locations' },
    { page: 'admin-workers', label: 'Workers' },
    { page: 'admin-supervisors', label: 'Supervisors' },
    { page: 'admin-cleaning', label: 'Cleaning' },
    { page: 'admin-tickets', label: 'Tickets' },
    { page: 'admin-audit-logs', label: 'Audit Logs' }
  ];

  function initAdmin(activePage) {
    if (!getToken()) { location.href = orgPath('admin-login'); return false; }
    var user = getUser();
    if (user.role === 'SUPER_ADMIN' && !sessionStorage.getItem('selectedOrgId')) {
      location.href = '/superadmin-dashboard'; return false;
    }

    // Show org name in topbar
    _applyOrgBrand();

    // Build nav
    var navEl = $('topbar-nav');
    if (navEl) {
      var html = '';
      for (var i = 0; i < NAV_ITEMS.length; i++) {
        var n = NAV_ITEMS[i];
        var href = orgPath(n.page);
        var cls = n.page.indexOf(activePage) !== -1 ? ' class="active"' : '';
        html += '<a href="' + href + '"' + cls + '>' + n.label + '</a>';
      }
      navEl.innerHTML = html;
    }

    // Build user menu
    _buildUserMenu(user, 'admin');

    // SA Banner
    if (user.role === 'SUPER_ADMIN') {
      var banner = $('sa-banner');
      if (banner) {
        var orgName = sessionStorage.getItem('selectedOrgName') || 'Org';
        banner.innerHTML = '<span>Viewing as Super Admin: <b>' + esc(orgName) + '</b></span><a href="/superadmin-dashboard">\u2190 Back to Super Admin</a>';
        banner.style.display = 'flex';
      }
    }

    // Mobile nav toggle
    _setupMobileNav();
    return true;
  }

  function initSupervisor() {
    if (!getSupToken()) { location.href = orgPath('supervisor-login'); return false; }
    var user = getSupUser();
    _applyOrgBrand();
    _buildUserMenu(user, 'supervisor');
    return true;
  }

  function _buildUserMenu(user, role) {
    var topRight = document.querySelector('.topbar-right');
    if (!topRight) return;
    var nameEl = $('userName');
    var logoutBtn = topRight.querySelector('.btn-ghost, [onclick*="logout"]');

    // Get initials (first letter of first & last name)
    var name = user.name || 'User';
    var parts = name.trim().split(/\s+/);
    var initials = parts.length > 1 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : parts[0].substring(0, 2).toUpperCase();

    // Build user menu wrap
    var wrap = document.createElement('div');
    wrap.className = 'user-menu-wrap';
    wrap.innerHTML =
      '<button class="user-menu-trigger" id="userMenuTrigger">' +
        '<span class="user-avatar">' + esc(initials) + '</span>' +
        '<span class="user-menu-name">' + esc(name) + '</span>' +
        '<svg class="user-menu-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>' +
      '</button>' +
      '<div class="user-menu-dropdown" id="userMenuDropdown">' +
        '<div class="user-menu-header">' +
          '<div class="user-menu-fullname">' + esc(name) + '</div>' +
          '<div class="user-menu-role">' + esc(user.role === 'SUPER_ADMIN' ? 'Super Admin' : role === 'supervisor' ? 'Supervisor' : 'Admin') + '</div>' +
        '</div>' +
        '<div class="user-menu-divider"></div>' +
        '<button class="user-menu-item user-menu-logout" id="userMenuLogout">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
          'Logout' +
        '</button>' +
      '</div>';

    // Replace old elements
    if (nameEl) nameEl.remove();
    if (logoutBtn) logoutBtn.remove();

    // Insert before notification bell (if present) or at the end
    var bellWrap = topRight.querySelector('.notif-bell-wrap');
    if (bellWrap) {
      topRight.appendChild(wrap);
    } else {
      topRight.appendChild(wrap);
    }

    // Toggle dropdown
    var trigger = wrap.querySelector('#userMenuTrigger');
    var dropdown = wrap.querySelector('#userMenuDropdown');
    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    // Close on outside click
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.user-menu-wrap')) {
        dropdown.classList.remove('open');
      }
    });

    // Logout
    var logoutEl = wrap.querySelector('#userMenuLogout');
    logoutEl.addEventListener('click', function() {
      if (role === 'supervisor') { logoutSup(); }
      else if (role === 'superadmin') { logoutSA(); }
      else { logout(); }
    });
  }

  function _setupMobileNav() {
    var toggle = $('nav-toggle');
    var navEl = $('topbar-nav');
    if (!toggle || !navEl) return;
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      navEl.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.topbar')) navEl.classList.remove('open');
    });
  }

  // ─── Loading Skeletons ───
  function showSkeleton(el, count) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    count = count || 3;
    var html = '';
    for (var i = 0; i < count; i++) {
      var w = 60 + Math.floor(Math.random() * 40);
      html += '<div class="skeleton skeleton-text" style="width:' + w + '%"></div>';
    }
    el.innerHTML = html;
  }

  function showSkeletonCards(el, count) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    count = count || 4;
    var html = '';
    for (var i = 0; i < count; i++) {
      html += '<div class="skeleton skeleton-card"></div>';
    }
    el.innerHTML = html;
  }

  function showSkeletonRows(el, count) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    count = count || 5;
    var html = '';
    for (var i = 0; i < count; i++) {
      html += '<div class="skeleton skeleton-row"></div>';
    }
    el.innerHTML = html;
  }

  // ─── Retry Queue (for offline form submissions) ───
  var retryQueue = [];

  function enqueueRetry(fn) {
    retryQueue.push(fn);
    toast('Saved for retry when back online', 'warning');
    if (navigator.onLine) _processQueue();
  }

  function _processQueue() {
    if (retryQueue.length === 0) return;
    var fn = retryQueue[0];
    fn().then(function () {
      retryQueue.shift();
      toast('Queued submission completed', 'success');
      _processQueue();
    }).catch(function () { /* will retry on next online event */ });
  }

  // Online/offline events
  window.addEventListener('online', function () {
    toast('Back online', 'success');
    _processQueue();
  });
  window.addEventListener('offline', function () {
    toast('You are offline. Submissions will be queued.', 'warning', 6000);
  });

  // ─── Error Helpers ───
  function showError(id, msg) {
    var el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    el.style.display = 'block';
  }

  function hideError(id) {
    var el = $(id);
    if (!el) return;
    el.classList.remove('show');
    el.style.display = 'none';
  }

  // ─── Modal Helpers ───
  function openModal(id) {
    var el = $(id);
    if (!el) return;
    el.classList.add('show');
    document.body.style.overflow = 'hidden';
    // Close on backdrop click
    el._backdropHandler = function (e) { if (e.target === el) closeModal(id); };
    el.addEventListener('click', el._backdropHandler);
    // Close on Escape
    el._escHandler = function (e) { if (e.key === 'Escape') closeModal(id); };
    document.addEventListener('keydown', el._escHandler);
  }
  function closeModal(id) {
    var el = $(id);
    if (!el) return;
    el.classList.remove('show');
    document.body.style.overflow = '';
    if (el._backdropHandler) { el.removeEventListener('click', el._backdropHandler); el._backdropHandler = null; }
    if (el._escHandler) { document.removeEventListener('keydown', el._escHandler); el._escHandler = null; }
  }

  // ─── Image URL with auth token ───
  function imgUrl(src) {
    if (!src) return '';
    var t = getToken() || getSupToken();
    if (!t || !src.startsWith('/images/')) return src;
    return src + (src.includes('?') ? '&' : '?') + 'token=' + t;
  }

  // ─── Notification Bell System ───
  var _notifInterval = null;
  var _notifFetcher = null; // apiFetch or supFetch
  var _notifBadgeEl = null;
  var _notifPanelEl = null;
  var _notifUnread = 0;
  var _notifPage = null; // which admin/supervisor page context

  function initNotifications(fetcher, pageContext) {
    _notifFetcher = fetcher;
    _notifPage = pageContext || null;
    // Create bell in topbar-right (before logout button)
    var topRight = document.querySelector('.topbar-right');
    if (!topRight) return;

    var bellWrap = document.createElement('div');
    bellWrap.className = 'notif-bell-wrap';
    bellWrap.innerHTML = '<button class="notif-bell" id="notifBell" aria-label="Notifications">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>' +
      '</svg><span class="notif-badge" id="notifBadge"></span></button>';
    topRight.insertBefore(bellWrap, topRight.firstChild);

    _notifBadgeEl = $('notifBadge');

    // Create dropdown panel
    _notifPanelEl = document.createElement('div');
    _notifPanelEl.className = 'notif-panel';
    _notifPanelEl.id = 'notifPanel';
    _notifPanelEl.innerHTML =
      '<div class="notif-panel-header">' +
        '<div class="notif-header-left"><b>Notifications</b><span class="notif-header-count" id="notifHeaderCount"></span></div>' +
        '<div class="notif-header-actions">' +
          '<button class="notif-action-btn" id="notifMarkAll" title="Mark all read">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
          '</button>' +
          '<button class="notif-action-btn" id="notifClearRead" title="Clear read notifications">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="notif-panel-body" id="notifList"><div class="notif-empty-state">Loading…</div></div>' +
      '<div class="notif-panel-footer" id="notifFooter" style="display:none">' +
        '<button class="notif-load-more" id="notifLoadMore">Load more</button>' +
      '</div>';
    bellWrap.appendChild(_notifPanelEl);

    // Toggle panel
    $('notifBell').addEventListener('click', function(e) {
      e.stopPropagation();
      var isOpen = _notifPanelEl.classList.toggle('open');
      if (isOpen) _loadNotifications();
    });

    // Close on outside click
    document.addEventListener('click', function(e) {
      if (_notifPanelEl && !e.target.closest('.notif-bell-wrap')) {
        _notifPanelEl.classList.remove('open');
      }
    });

    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && _notifPanelEl) _notifPanelEl.classList.remove('open');
    });

    // Mark all read
    $('notifMarkAll').addEventListener('click', async function(e) {
      e.stopPropagation();
      await _notifFetcher('/notifications/read-all', { method: 'PATCH' });
      _pollUnreadCount();
      _loadNotifications();
    });

    // Clear read
    $('notifClearRead').addEventListener('click', async function(e) {
      e.stopPropagation();
      await _notifFetcher('/notifications/clear-read', { method: 'DELETE' });
      _loadNotifications();
    });

    // Load more
    $('notifLoadMore').addEventListener('click', function(e) {
      e.stopPropagation();
      var items = document.querySelectorAll('.notif-item');
      _loadNotifications(items.length);
    });

    // Initial poll + interval (every 30s)
    _pollUnreadCount();
    _notifInterval = setInterval(_pollUnreadCount, 30000);
  }

  async function _pollUnreadCount() {
    try {
      var res = await _notifFetcher('/notifications/unread-count');
      if (!res || !res.ok) return;
      var data = await res.json();
      var prev = _notifUnread;
      _notifUnread = data.count || 0;
      _updateBadge(_notifUnread);
      // Animate bell on new notification
      if (_notifUnread > prev && prev >= 0) {
        var bell = $('notifBell');
        if (bell) { bell.classList.add('notif-bell-ring'); setTimeout(function() { bell.classList.remove('notif-bell-ring'); }, 600); }
      }
    } catch (e) { /* silent */ }
  }

  function _updateBadge(count) {
    if (!_notifBadgeEl) return;
    if (count > 0) {
      _notifBadgeEl.textContent = count > 99 ? '99+' : count;
      _notifBadgeEl.style.display = 'flex';
    } else {
      _notifBadgeEl.style.display = 'none';
    }
    // Update header count
    var hc = $('notifHeaderCount');
    if (hc) hc.textContent = count > 0 ? count + ' unread' : '';
  }

  async function _loadNotifications(offset) {
    var listEl = $('notifList');
    if (!listEl) return;
    var isAppend = offset && offset > 0;
    if (!isAppend) listEl.innerHTML = '<div class="notif-empty-state">Loading…</div>';
    try {
      var res = await _notifFetcher('/notifications?limit=20&offset=' + (offset || 0));
      if (!res || !res.ok) { if (!isAppend) listEl.innerHTML = '<div class="notif-empty-state">Could not load notifications</div>'; return; }
      var data = await res.json();
      var notifs = data.notifications || [];
      _notifUnread = data.unread || 0;
      _updateBadge(_notifUnread);

      if (!notifs.length && !isAppend) {
        listEl.innerHTML = '<div class="notif-empty-state">' +
          '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-light)" stroke-width="1.5" style="margin-bottom:.4rem"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>' +
          '<div>No notifications yet</div>' +
          '<div style="font-size:.7rem;margin-top:.15rem;color:var(--text-light)">You\'ll be notified about tickets & complaints</div>' +
          '</div>';
        $('notifFooter').style.display = 'none';
        return;
      }

      var html = isAppend ? '' : '';
      var lastDateGroup = isAppend ? (listEl.querySelector('.notif-date-group:last-of-type')?.textContent || '') : '';
      for (var i = 0; i < notifs.length; i++) {
        var n = notifs[i];
        var dateGroup = _getDateGroup(n.createdAt);
        if (dateGroup !== lastDateGroup) {
          html += '<div class="notif-date-group">' + dateGroup + '</div>';
          lastDateGroup = dateGroup;
        }
        var icon = _getNotifIcon(n.type);
        var ago = _timeAgo(n.createdAt);
        var readCls = n.isRead ? ' read' : '';
        var typeLabel = _getTypeLabel(n.type);
        html += '<div class="notif-item' + readCls + '" data-id="' + n.id + '" data-entity="' + (n.entityId || '') + '" data-type="' + (n.type || '') + '">' +
          '<div class="notif-icon-wrap"><span class="notif-icon">' + icon + '</span></div>' +
          '<div class="notif-content">' +
            '<div class="notif-item-header"><span class="notif-type-label">' + typeLabel + '</span><span class="notif-time">' + ago + '</span></div>' +
            '<div class="notif-title">' + esc(n.title) + '</div>' +
            (n.body ? '<div class="notif-body">' + esc(n.body) + '</div>' : '') +
          '</div>' +
          '<button class="notif-delete-btn" title="Delete" data-nid="' + n.id + '">&times;</button>' +
        '</div>';
      }

      if (isAppend) {
        listEl.insertAdjacentHTML('beforeend', html);
      } else {
        listEl.innerHTML = html;
      }

      // Show/hide load more
      var totalLoaded = (offset || 0) + notifs.length;
      $('notifFooter').style.display = totalLoaded < data.total ? '' : 'none';

      // Bind click handlers
      _bindNotifClicks(listEl);
    } catch (e) { if (!isAppend) listEl.innerHTML = '<div class="notif-empty-state">Error loading notifications</div>'; }
  }

  function _bindNotifClicks(listEl) {
    listEl.querySelectorAll('.notif-item').forEach(function(el) {
      if (el._bound) return;
      el._bound = true;
      el.addEventListener('click', function(e) {
        if (e.target.closest('.notif-delete-btn')) return;
        var nId = el.dataset.id;
        var entityId = el.dataset.entity;
        var type = el.dataset.type;
        if (!el.classList.contains('read')) {
          _notifFetcher('/notifications/' + nId + '/read', { method: 'PATCH' }).then(function() { _pollUnreadCount(); });
          el.classList.add('read');
        }
        // Navigate to relevant page
        if (entityId && (type === 'ticket_assigned' || type === 'ticket_resolved' || type === 'public_complaint')) {
          _notifPanelEl.classList.remove('open');
          var base = _notifPage === 'supervisor' ? orgPath('supervisor-tickets') : orgPath('admin-tickets');
          window.location.href = base;
        }
      });
      // Delete button
      var delBtn = el.querySelector('.notif-delete-btn');
      if (delBtn) {
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          var nId = delBtn.dataset.nid;
          el.style.opacity = '0'; el.style.height = '0'; el.style.padding = '0'; el.style.overflow = 'hidden';
          el.style.transition = 'all .2s ease';
          setTimeout(function() { el.remove(); }, 200);
          _notifFetcher('/notifications/' + nId, { method: 'DELETE' }).then(function() { _pollUnreadCount(); });
        });
      }
    });
  }

  function _getNotifIcon(type) {
    switch (type) {
      case 'ticket_assigned': return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>';
      case 'ticket_resolved': return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
      case 'public_complaint': return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning-text)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
      default: return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>';
    }
  }

  function _getTypeLabel(type) {
    switch (type) {
      case 'ticket_assigned': return 'Assigned';
      case 'ticket_resolved': return 'Resolved';
      case 'public_complaint': return 'Complaint';
      default: return 'Notification';
    }
  }

  function _getDateGroup(dateStr) {
    var d = new Date(dateStr);
    var today = new Date();
    today.setHours(0,0,0,0);
    var yest = new Date(today); yest.setDate(yest.getDate() - 1);
    var ts = new Date(d); ts.setHours(0,0,0,0);
    if (ts.getTime() === today.getTime()) return 'Today';
    if (ts.getTime() === yest.getTime()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function _timeAgo(dateStr) {
    var ms = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function stopNotifications() {
    if (_notifInterval) { clearInterval(_notifInterval); _notifInterval = null; }
  }

  // ─── Public API ───
  return {
    $: $, esc: esc, fmtDate: fmtDate, fmtDateShort: fmtDateShort,
    getOrgSlug: getOrgSlug, orgPath: orgPath,
    getToken: getToken, getSupToken: getSupToken, getUser: getUser, getSupUser: getSupUser,
    adminHeaders: adminHeaders, supHeaders: supHeaders,
    apiFetch: apiFetch, apiFetchJson: apiFetchJson,
    supFetch: supFetch, supFetchJson: supFetchJson,
    logout: logout, logoutSA: logoutSA, logoutSup: logoutSup,
    toast: toast, confirmDialog: confirmDialog,
    initAdmin: initAdmin, initSupervisor: initSupervisor,
    buildUserMenu: _buildUserMenu,
    initNotifications: initNotifications, stopNotifications: stopNotifications,
    showSkeleton: showSkeleton, showSkeletonCards: showSkeletonCards, showSkeletonRows: showSkeletonRows,
    showError: showError, hideError: hideError,
    openModal: openModal, closeModal: closeModal,
    enqueueRetry: enqueueRetry,
    imgUrl: imgUrl
  };
})();

// Register service worker for PWA install (desktop + mobile)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function() {});
}
