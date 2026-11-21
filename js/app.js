/**
 * SolarClean Dashboard — ThingSpeak Integration & Dashboard Logic
 * Reads: Field 1 = Voltage, Field 2 = Current, Field 3 = Humidity, Field 4 = Ultrasonic (dust)
 */

(function () {
  'use strict';

  /* ========== Configuration ========== */
  const CONFIG = {
    // ThingSpeak credentials
    channelId: '3531242',
    readApiKey: 'VSKXXRE6IET6WPZJ',
    readUrl: 'https://api.thingspeak.com/channels/3531242/feeds.json?api_key=VSKXXRE6IET6WPZJ&results=2',
    // ThingSpeak base URL
    baseUrl: 'https://api.thingspeak.com',
    // Polling interval in ms (ThingSpeak free: min 15s)
    pollInterval: 15000,
    // Number of data points for charts
    chartPoints: 40,
    // Cleaning thresholds (defaults)
    thresholds: {
      dustDistance: 10,   // cm — below this = dirty
      humidity: 80        // % — above this = skip cleaning
    }
  };

  /* ========== ThingSpeak URL Parser Helper ========== */
  function parseThingSpeakUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return {};
    let channelId = null;
    let apiKey = null;

    const chMatch = urlStr.match(/channels\/(\d+)/i);
    if (chMatch) channelId = chMatch[1];

    const keyMatch = urlStr.match(/[?&]api_key=([A-Za-z0-9_-]+)/i);
    if (keyMatch) apiKey = keyMatch[1];

    return { channelId, apiKey };
  }

  /* ========== State ========== */
  let state = {
    voltage: null,
    current: null,
    humidity: null,
    dustDistance: null,
    power: null,
    energy: 0,
    history: { voltage: [], current: [], humidity: [], dust: [], labels: [] },
    motorStatus: 'idle',        // idle | running | cleaning
    cleaningStartedAt: null,
    autoClean: false,
    lastUpdate: null,
    online: false,
    cleaningCount: 0,
    pollTimer: null,
    charts: {}
  };

  /* ========== DOM Refs ========== */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  /* ========== Session Guard ========== */
  function requireAuth() {
    // Firebase Auth is the source of truth; do not trust a client-editable
    // sessionStorage token as proof of authentication.
    return Boolean(window.FirebaseServices &&
      window.FirebaseServices.auth &&
      window.FirebaseServices.auth.currentUser);
  }

  /* ========== Initialization ========== */
  async function init() {
    // This telemetry console is the Client dashboard. Firebase verifies the
    // authenticated user, active status and Firestore role before UI startup.
    if (!window.FirebaseServices || !(await window.FirebaseServices.requireRole('client'))) return;
    if (!requireAuth()) return;

    loadConfig();
    bindEvents();
    initCharts();
    loadClientCleaningHistory();
    initCleaningSchedules();
    const historyRefresh = $('#refresh-cleaning-history');
    if (historyRefresh) historyRefresh.addEventListener('click', loadClientCleaningHistory);

    if (CONFIG.channelId || CONFIG.readUrl) {
      fetchData();
      startPolling();
      addLog('info', 'Dashboard initialized — fetching ThingSpeak data');
    } else {
      showConfigModal();
      addLog('warn', 'No ThingSpeak credentials — configure to start');
    }
  }

  /* ========== Config persistence (localStorage) ========== */
  function loadConfig() {
    try {
      const saved = localStorage.getItem('solarclean_config');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.channelId) CONFIG.channelId = parsed.channelId;
        if (parsed.readApiKey !== undefined) CONFIG.readApiKey = parsed.readApiKey;
        if (parsed.readUrl) CONFIG.readUrl = parsed.readUrl;
        CONFIG.thresholds.dustDistance = parsed.dustDistance ?? 10;
        CONFIG.thresholds.humidity = parsed.humidityThreshold ?? 80;
      }
    } catch (e) { /* ignore */ }

    if (!CONFIG.readUrl && CONFIG.channelId) {
      CONFIG.readUrl = `${CONFIG.baseUrl}/channels/${CONFIG.channelId}/feeds.json${CONFIG.readApiKey ? '?api_key=' + CONFIG.readApiKey : ''}`;
    }

    // Reflect in inputs
    const dustInput = $('#threshold-dust');
    const humInput = $('#threshold-humidity');
    if (dustInput) dustInput.value = CONFIG.thresholds.dustDistance;
    if (humInput) humInput.value = CONFIG.thresholds.humidity;

    const displayChannel = $('#display-channel-id');
    if (displayChannel) displayChannel.textContent = CONFIG.channelId;
  }

  function saveConfig() {
    localStorage.setItem('solarclean_config', JSON.stringify({
      channelId: CONFIG.channelId,
      readApiKey: CONFIG.readApiKey,
      readUrl: CONFIG.readUrl,
      dustDistance: CONFIG.thresholds.dustDistance,
      humidityThreshold: CONFIG.thresholds.humidity
    }));
  }

  /* ========== Events ========== */
  function bindEvents() {
    // Config modal
    $('#btn-settings').addEventListener('click', showConfigModal);
    $('#config-save').addEventListener('click', handleConfigSave);
    $('#config-cancel').addEventListener('click', hideConfigModal);
    $('#config-overlay').addEventListener('click', (e) => {
      if (e.target === $('#config-overlay')) hideConfigModal();
    });

    // Bidirectional sync between Read Link and Channel ID / API Key
    const linkInput = $('#config-readlink');
    const chInput = $('#config-channel');
    const keyInput = $('#config-apikey');

    if (linkInput) {
      linkInput.addEventListener('input', () => {
        const parsed = parseThingSpeakUrl(linkInput.value.trim());
        if (parsed.channelId && chInput) chInput.value = parsed.channelId;
        if (parsed.apiKey && keyInput) keyInput.value = parsed.apiKey;
      });
    }

    function syncLinkFromInputs() {
      const ch = chInput ? chInput.value.trim() : '';
      const k = keyInput ? keyInput.value.trim() : '';
      if (linkInput && ch) {
        linkInput.value = `${CONFIG.baseUrl}/channels/${ch}/feeds.json${k ? '?api_key=' + k : ''}`;
      }
    }

    if (chInput) chInput.addEventListener('input', syncLinkFromInputs);
    if (keyInput) keyInput.addEventListener('input', syncLinkFromInputs);

    // Motor controls
    $('#btn-clean-now').addEventListener('click', triggerManualClean);
    $('#btn-stop-motor').addEventListener('click', stopMotor);

    // Threshold inputs
    $('#threshold-dust').addEventListener('change', (e) => {
      CONFIG.thresholds.dustDistance = parseFloat(e.target.value) || 10;
      saveConfig();
      addLog('info', `Dust threshold updated to ${CONFIG.thresholds.dustDistance} cm`);
      evaluateCleaning();
    });
    $('#threshold-humidity').addEventListener('change', (e) => {
      CONFIG.thresholds.humidity = parseFloat(e.target.value) || 80;
      saveConfig();
      addLog('info', `Humidity threshold updated to ${CONFIG.thresholds.humidity}%`);
      evaluateCleaning();
    });

    // Log clear
    $('#btn-clear-log').addEventListener('click', () => {
      $('#log-entries').innerHTML = '';
      addLog('info', 'Log cleared');
    });
  }

  /* ========== ThingSpeak Fetch (Modern CORS fetch with XHR fallback) ========== */
  async function fetchData() {
    if (!requireAuth()) return;

    let channelId = CONFIG.channelId;
    let apiKey = CONFIG.readApiKey;

    if (CONFIG.readUrl) {
      const parsed = parseThingSpeakUrl(CONFIG.readUrl);
      if (parsed.channelId) channelId = parsed.channelId;
      if (parsed.apiKey) apiKey = parsed.apiKey;
    }

    if (!channelId) {
      updateOnlineStatus(false);
      addLog('warn', 'Channel ID or Read URL required to fetch ThingSpeak data');
      return;
    }

    const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';
    const url = `${CONFIG.baseUrl}/channels/${channelId}/feeds.json?results=${CONFIG.chartPoints}${keyParam}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} (${response.statusText})`);
      }
      const data = await response.json();

      if (!data || !data.feeds || data.feeds.length === 0) {
        updateOnlineStatus(false);
        addLog('warn', 'Connected to ThingSpeak, but no feed records found');
        return;
      }

      processFeeds(data.feeds, data.channel);
      updateOnlineStatus(true);
      addLog('info', `Ingested ${data.feeds.length} live telemetry records from Channel ${channelId}`);
    } catch (err) {
      console.warn('Fetch error, trying XMLHttpRequest fallback:', err);
      fetchWithXHR(url, channelId);
    }
  }

  function fetchWithXHR(url, channelId) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (!data || !data.feeds || data.feeds.length === 0) {
            updateOnlineStatus(false);
            addLog('warn', 'Connected to ThingSpeak, but no feed records found');
            return;
          }
          processFeeds(data.feeds, data.channel);
          updateOnlineStatus(true);
          addLog('info', `Ingested ${data.feeds.length} live telemetry records from Channel ${channelId}`);
        } catch (e) {
          updateOnlineStatus(false);
          addLog('error', `JSON parse error from ThingSpeak: ${e.message}`);
        }
      } else {
        updateOnlineStatus(false);
        addLog('error', `ThingSpeak connection error: HTTP ${xhr.status}`);
      }
    };
    xhr.onerror = function () {
      updateOnlineStatus(false);
      addLog('error', 'Network failure connecting to ThingSpeak. Verify internet connection.');
    };
    xhr.send();
  }

  function processFeeds(feeds, channel) {
    // Reset history
    state.history = { voltage: [], current: [], humidity: [], dust: [], labels: [] };

    // Check if channel field2 was labeled Ultrasonic
    const isField2Ultrasonic = channel && channel.field2 && channel.field2.toLowerCase().includes('ultrasonic');

    feeds.forEach((feed) => {
      const v = parseFloat(feed.field1);
      const rawField2 = parseFloat(feed.field2);
      const h = parseFloat(feed.field3);
      let d = parseFloat(feed.field4);

      // Fallback: if field4 is missing but field2 is Ultrasonic test data
      if (isNaN(d) && isField2Ultrasonic && !isNaN(rawField2)) {
        d = rawField2;
      }
      const c = (isField2Ultrasonic && isNaN(parseFloat(feed.field4))) ? null : rawField2;

      const t = new Date(feed.created_at);

      state.history.voltage.push(isNaN(v) ? null : v);
      state.history.current.push(isNaN(c) ? null : c);
      state.history.humidity.push(isNaN(h) ? null : h);
      state.history.dust.push(isNaN(d) ? null : d);
      state.history.labels.push(formatTime(t));
    });

    // Latest values
    const latest = feeds[feeds.length - 1];
    state.voltage = isNaN(parseFloat(latest.field1)) ? 0 : parseFloat(latest.field1);
    
    let latestCurrent = parseFloat(latest.field2);
    if (isField2Ultrasonic && isNaN(parseFloat(latest.field4))) {
      latestCurrent = 0; // Field 2 is currently being used for ultrasonic testing
    }
    state.current = isNaN(latestCurrent) ? 0 : latestCurrent;

    state.humidity = isNaN(parseFloat(latest.field3)) ? 0 : parseFloat(latest.field3);
    
    let latestDust = parseFloat(latest.field4);
    if (isNaN(latestDust) && isField2Ultrasonic && !isNaN(parseFloat(latest.field2))) {
      latestDust = parseFloat(latest.field2);
    }
    state.dustDistance = isNaN(latestDust) ? 0 : latestDust;

    state.power = state.voltage * state.current;
    state.lastUpdate = new Date(latest.created_at);

    // Simple energy estimation (Wh)
    state.energy += (state.power * (CONFIG.pollInterval / 3600000));

    updateUI();
    updateCharts();
    evaluateCleaning();

    // Sync snapshot to Supabase PostgreSQL table
    syncTelemetryToSupabase(state.voltage, state.current, state.humidity, state.dustDistance);
  }

  /* ========== Supabase PostgreSQL Synchronization ========== */
  let lastTelemetrySaveTime = 0;

  async function syncTelemetryToSupabase(v, c, h, d) {
    const now = Date.now();
    // Throttle inserts to once per minute to stay well within free tier limits
    if (now - lastTelemetrySaveTime < 60000) return;
    lastTelemetrySaveTime = now;

    if (!window.supabase) return;
    try {
      const conf = window.SecurityDB ? window.SecurityDB.getCloudConfig() : null;
      if (!conf || !conf.url || !conf.anonKey) return;
      const client = window.supabase.createClient(conf.url, conf.anonKey);

      await client.from('sensor_telemetry_history').insert([
        {
          voltage: v,
          current: c,
          humidity: h,
          dust_distance: d,
          soiling_state: d < CONFIG.thresholds.dustDistance ? 'Soiled (Cleaning Required)' : 'Optimal',
          gateway_status: 'online'
        }
      ]);
    } catch (e) {
      console.warn('Telemetry cloud snapshot skip:', e);
    }
  }

  function escapeHistoryText(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  async function loadClientCleaningHistory() {
    const body = $('#client-cleaning-history-body');
    const status = $('#client-cleaning-history-status');
    if (!body || !window.FirebaseServices) return;
    body.innerHTML = '<tr><td colspan="6" style="padding:18px;color:var(--text-muted);">Loading…</td></tr>';
    try {
      const records = await window.FirebaseServices.getCleaningHistory(100);
      if (!records.length) {
        body.innerHTML = '<tr><td colspan="6" style="padding:18px;color:var(--text-muted);">No cleaning records found for your account yet.</td></tr>';
      } else {
        body.innerHTML = records.map(record => {
          const date = record.completedAt && record.completedAt.toDate ? record.completedAt.toDate() : null;
          const dateText = date ? date.toLocaleString() : 'Date unavailable';
          const duration = Number(record.durationSeconds);
          return `<tr><td>${escapeHistoryText(dateText)}</td><td>${escapeHistoryText(record.mode || '—')}</td><td>${escapeHistoryText(record.triggerReason || '—')}</td><td>${Number.isFinite(duration) ? duration.toFixed(1) + ' sec' : '—'}</td><td>${escapeHistoryText(record.outcome || '—')}</td><td>${record.isSimulated ? 'Simulated' : 'Hardware'}</td></tr>`;
        }).join('');
      }
      if (status) status.textContent = `Showing ${records.length} most recent record(s).`;
    } catch (error) {
      console.error('Cleaning history load failed:', error);
      body.innerHTML = '<tr><td colspan="6" style="padding:18px;color:#ffc56d;">Could not load cleaning history.</td></tr>';
      if (status) status.textContent = error.message;
    }
  }

  function initCleaningSchedules() {
    const form = $('#schedule-form');
    const list = $('#schedule-list');
    const status = $('#schedule-status');
    if (!form || !list || !window.FirebaseServices) return;
    const api = window.FirebaseServices;
    const show = message => { status.textContent = message; };
    async function refresh() {
      list.innerHTML = '<tr><td colspan="3">Loading schedules…</td></tr>';
      try {
        const records = await api.getCleaningSchedules();
        list.innerHTML = records.length ? records.map(record => {
          const when = record.scheduledFor.toDate().toLocaleString();
          const id = escapeHistoryText(record.id);
          const paused = record.status === 'paused';
          return `<tr><td>${escapeHistoryText(when)}</td><td>${paused ? 'Paused' : 'Active'}</td><td style="padding:8px;white-space:nowrap;"><button type="button" class="btn btn-secondary" data-schedule-action="toggle" data-schedule-id="${id}">${paused ? 'Resume' : 'Pause'}</button> <button type="button" class="btn btn-secondary" data-schedule-action="edit" data-schedule-id="${id}">Edit</button> <button type="button" class="btn btn-secondary" data-schedule-action="delete" data-schedule-id="${id}">Delete</button></td></tr>`;
        }).join('') : '<tr><td colspan="3">No schedules yet.</td></tr>';
        list._records = records;
        show(`${records.length} schedule(s). Cloud storage only — not connected to hardware.`);
      } catch (error) {
        list.innerHTML = '<tr><td colspan="3">Could not load schedules.</td></tr>';
        show(error.message);
      }
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const field = $('#schedule-time');
      try {
        await api.createCleaningSchedule({ scheduledFor: field.value });
        field.value = '';
        await refresh();
      } catch (error) { show(error.message); }
    });
    $('#refresh-schedules').addEventListener('click', refresh);
    list.addEventListener('click', async event => {
      const button = event.target.closest('button[data-schedule-action]');
      if (!button) return;
      const record = (list._records || []).find(item => item.id === button.dataset.scheduleId);
      if (!record) return;
      try {
        if (button.dataset.scheduleAction === 'toggle') {
          await api.updateCleaningSchedule(record.id, { status: record.status === 'paused' ? 'active' : 'paused' });
        } else if (button.dataset.scheduleAction === 'edit') {
          const value = prompt('Enter new local date and time (YYYY-MM-DDTHH:mm)',
            (() => { const d = record.scheduledFor.toDate(); const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return local.toISOString().slice(0,16); })());
          if (value === null) return;
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Use YYYY-MM-DDTHH:mm.');
          await api.updateCleaningSchedule(record.id, { scheduledFor: value });
        } else if (button.dataset.scheduleAction === 'delete') {
          if (!confirm('Delete this schedule?')) return;
          await api.deleteCleaningSchedule(record.id);
        }
        await refresh();
      } catch (error) { show(error.message); }
    });
    refresh();
  }

  async function logCleaningToFirestore(mode, dust, humidity, outcome, startedAt, completedAt) {
    if (!window.FirebaseServices || typeof window.FirebaseServices.recordCleaningHistory !== 'function') {
      addLog('warn', 'Cleaning event was not saved: Firestore history service is unavailable.');
      return;
    }
    try {
      const id = await window.FirebaseServices.recordCleaningHistory({
        mode,
        outcome,
        triggerReason: mode === 'manual' ? 'manual_request' : 'automatic_threshold',
        dustDistanceBefore: dust,
        humidityAtCleaning: humidity,
        startedAt,
        completedAt,
        durationSeconds: Math.max(0, (completedAt.getTime() - startedAt.getTime()) / 1000)
      });
      addLog('info', `Cleaning event saved to Firestore (ID: ${id}).`);
    } catch (err) {
      console.error('Could not save cleaning history to Firestore:', err);
      addLog('warn', `Cleaning event could not be saved to Firestore: ${err.message}`);
    }
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(fetchData, CONFIG.pollInterval);
  }

  /* ========== UI Updates ========== */
  function updateUI() {
    // Metric values
    animateValue($('#val-voltage'), state.voltage, 1);
    animateValue($('#val-current'), state.current, 2);
    animateValue($('#val-humidity'), state.humidity, 1);
    animateValue($('#val-dust'), state.dustDistance, 1);

    // Progress bars (normalized)
    updateBar($('#bar-voltage'), state.voltage, 25);    // max ~25V
    updateBar($('#bar-current'), state.current, 10);    // max ~10A
    updateBar($('#bar-humidity'), state.humidity, 100);
    updateBar($('#bar-dust'), Math.max(0, 30 - state.dustDistance), 30); // invert: closer = dirtier

    // Sub-labels
    $('#sub-voltage').textContent = state.voltage > 18 ? 'Optimal' : state.voltage > 12 ? 'Moderate' : 'Low';
    $('#sub-current').textContent = state.current > 5 ? 'High load' : state.current > 1 ? 'Normal' : 'Minimal';
    $('#sub-humidity').textContent = state.humidity > CONFIG.thresholds.humidity ? 'Too humid' : state.humidity > 50 ? 'Moderate' : 'Dry';
    $('#sub-dust').textContent = state.dustDistance < CONFIG.thresholds.dustDistance ? 'Dirty — clean needed' : 'Clean';

    // Power stats
    $('#stat-power').textContent = state.power.toFixed(1) + ' W';
    $('#stat-voltage-avg').textContent = average(state.history.voltage).toFixed(1) + ' V';
    $('#stat-current-avg').textContent = average(state.history.current).toFixed(1) + ' A';
    $('#stat-cleans').textContent = state.cleaningCount;

    // Last update
    if (state.lastUpdate) {
      $('#last-update').textContent = 'Updated ' + timeSince(state.lastUpdate);
    }
  }

  function updateOnlineStatus(isOnline) {
    state.online = isOnline;
    const badge = $('#status-badge');
    const dot = badge.querySelector('.status-dot');
    if (isOnline) {
      badge.className = 'status-badge online';
      badge.querySelector('span:last-child').textContent = 'LIVE';
    } else {
      badge.className = 'status-badge offline';
      badge.querySelector('span:last-child').textContent = 'OFFLINE';
    }
  }

  function animateValue(el, target, decimals) {
    if (!el) return;
    const current = parseFloat(el.textContent) || 0;
    const diff = target - current;
    const steps = 20;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      const val = current + (diff * (step / steps));
      el.textContent = val.toFixed(decimals);
      if (step >= steps) clearInterval(timer);
    }, 30);
  }

  function updateBar(el, value, max) {
    if (!el) return;
    const pct = Math.min(100, Math.max(0, (value / max) * 100));
    el.style.width = pct + '%';
  }

  /* ========== Charts (Chart.js) ========== */
  function initCharts() {
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(17,24,39,0.95)',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          titleFont: { family: 'Inter', weight: '600' },
          bodyFont: { family: 'Inter' }
        }
      },
      scales: {
        x: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks: { color: '#64748b', font: { family: 'Inter', size: 10 }, maxTicksLimit: 8 }
        },
        y: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks: { color: '#64748b', font: { family: 'Inter', size: 10 } }
        }
      },
      elements: {
        point: { radius: 0, hoverRadius: 4 },
        line: { tension: 0.35, borderWidth: 2 }
      }
    };

    // Voltage chart
    state.charts.voltage = new Chart($('#chart-voltage'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Voltage (V)',
          data: [],
          borderColor: '#f59e0b',
          backgroundColor: createGradient('#chart-voltage', '#f59e0b'),
          fill: true
        }]
      },
      options: { ...commonOptions }
    });

    // Current chart
    state.charts.current = new Chart($('#chart-current'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Current (A)',
          data: [],
          borderColor: '#3b82f6',
          backgroundColor: createGradient('#chart-current', '#3b82f6'),
          fill: true
        }]
      },
      options: { ...commonOptions }
    });

    // Humidity chart
    state.charts.humidity = new Chart($('#chart-humidity'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Humidity (%)',
          data: [],
          borderColor: '#10b981',
          backgroundColor: createGradient('#chart-humidity', '#10b981'),
          fill: true
        }]
      },
      options: { ...commonOptions }
    });

    // Dust / Ultrasonic chart
    state.charts.dust = new Chart($('#chart-dust'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Distance (cm)',
          data: [],
          borderColor: '#ef4444',
          backgroundColor: createGradient('#chart-dust', '#ef4444'),
          fill: true
        }]
      },
      options: { ...commonOptions }
    });
  }

  function createGradient(canvasSelector, hex) {
    const canvas = $(canvasSelector);
    if (!canvas) return hex;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 220);
    grad.addColorStop(0, hexToRgba(hex, 0.25));
    grad.addColorStop(1, hexToRgba(hex, 0));
    return grad;
  }

  function updateCharts() {
    const labels = state.history.labels;
    updateSingleChart(state.charts.voltage, labels, state.history.voltage);
    updateSingleChart(state.charts.current, labels, state.history.current);
    updateSingleChart(state.charts.humidity, labels, state.history.humidity);
    updateSingleChart(state.charts.dust, labels, state.history.dust);
  }

  function updateSingleChart(chart, labels, data) {
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update('none');
  }

  /* ========== Cleaning Logic ========== */
  function evaluateCleaning() {
    if (state.motorStatus === 'running' || state.motorStatus === 'cleaning') return;
    if (!state.autoClean) return;

    const dustDirty = state.dustDistance < CONFIG.thresholds.dustDistance && state.dustDistance > 0;
    const humidityOk = state.humidity < CONFIG.thresholds.humidity;

    if (dustDirty && humidityOk) {
      startCleaning('auto');
    } else if (dustDirty && !humidityOk) {
      addLog('warn', `Panel dirty (${state.dustDistance} cm) but humidity too high (${state.humidity}%) — skipping`);
    }
  }

  let activeCommandUnsubscribe = null;
  let activeCommandId = null;

  async function startCleaning(mode) {
    if (state.motorStatus !== 'idle') {
      showToast('warn', 'A cleaning request is already active.');
      return;
    }
    if (mode !== 'manual') {
      addLog('warn', 'Automatic cleaning is disabled until the hardware decision logic is commissioned.');
      return;
    }
    if (!window.FirebaseServices ||
        typeof window.FirebaseServices.queueHardwareCleaningCommand !== 'function') {
      showToast('error', 'Hardware command service is unavailable.');
      return;
    }

    const button = $('#btn-clean-now');
    button.disabled = true;
    button.textContent = 'Sending one-shot command…';
    try {
      const commandId = await window.FirebaseServices.queueHardwareCleaningCommand();
      activeCommandId = commandId;
      state.motorStatus = 'running';
      state.cleaningStartedAt = new Date();
      updateMotorUI();
      addLog('info', `One-shot cleaning command queued (ID: ${commandId}). Waiting for ESP32 acknowledgement.`);
      showToast('info', 'Cleaning request queued — waiting for the controller.');
      activeCommandUnsubscribe = window.FirebaseServices.watchHardwareCleaningCommand(
        commandId,
        command => {
          const status = String(command.status || '').toLowerCase();
          if (status === 'queued') {
            addLog('info', 'Command is queued; ESP32 has not claimed it yet.');
            return;
          }
          if (status === 'running') {
            state.motorStatus = 'cleaning';
            updateMotorUI();
            addLog('success', 'ESP32 acknowledged the command. Physical cleaning cycle started.');
            showToast('success', 'Hardware acknowledged — cleaning started.');
            return;
          }
          if (['completed', 'stopped', 'failed'].includes(status)) {
            const completedAt = new Date();
            const startedAt = state.cleaningStartedAt || completedAt;
            state.motorStatus = 'idle';
            state.cleaningStartedAt = null;
            activeCommandId = null;
            if (activeCommandUnsubscribe) activeCommandUnsubscribe();
            activeCommandUnsubscribe = null;
            updateMotorUI();
            if (status === 'completed') {
              addLog('success', 'ESP32 reported that the physical sweep completed.');
              showToast('success', 'Physical cleaning cycle completed.');
            } else {
              addLog(status === 'failed' ? 'error' : 'warn',
                `Hardware cleaning command ended: ${status}${command.result ? ' — ' + command.result : ''}`);
              showToast(status === 'failed' ? 'error' : 'info', `Cleaning ${status}.`);
            }
            // Hardware events are not written into the simulation-only history collection.
          }
        },
        error => {
          addLog('error', `Could not monitor hardware command: ${error.message}`);
          showToast('error', 'Lost command status connection. Check the hardware and refresh.');
        }
      );
    } catch (error) {
      state.motorStatus = 'idle';
      state.cleaningStartedAt = null;
      updateMotorUI();
      addLog('error', `Could not queue cleaning command: ${error.message}`);
      showToast('error', error.message);
    } finally {
      button.textContent = 'Execute Sweep Sequence';
      if (state.motorStatus === 'idle') button.disabled = false;
    }
  }

  function triggerManualClean() {
    if (state.motorStatus !== 'idle') {
      showToast('warn', 'Motor is already active or a command is pending.');
      return;
    }
    startCleaning('manual');
  }

  async function stopMotor() {
    if (!activeCommandId) {
      showToast('warn', 'There is no active hardware command to stop.');
      return;
    }
    try {
      await window.FirebaseServices.requestHardwareStop(activeCommandId);
      addLog('warn', 'Stop request sent to the ESP32. Waiting for hardware acknowledgement.');
      showToast('info', 'Stop request sent.');
    } catch (error) {
      addLog('error', `Could not send stop request: ${error.message}`);
      showToast('error', error.message);
    }
  }

  function updateMotorUI() {
    const indicator = $('#motor-indicator');
    const btnClean = $('#btn-clean-now');

    indicator.className = 'motor-status-indicator ' + state.motorStatus;
    indicator.textContent = state.motorStatus === 'idle' ? 'IDLE' : state.motorStatus === 'cleaning' ? 'CLEANING' : 'RUNNING';

    btnClean.disabled = state.motorStatus !== 'idle';
  }

  /* ========== Config Modal ========== */
  function showConfigModal() {
    const chInput = $('#config-channel');
    const keyInput = $('#config-apikey');
    const linkInput = $('#config-readlink');

    if (chInput) chInput.value = CONFIG.channelId || '';
    if (keyInput) keyInput.value = CONFIG.readApiKey || '';
    if (linkInput) {
      linkInput.value = CONFIG.readUrl || (CONFIG.channelId ? `${CONFIG.baseUrl}/channels/${CONFIG.channelId}/feeds.json${CONFIG.readApiKey ? '?api_key=' + CONFIG.readApiKey : ''}` : '');
    }
    $('#config-overlay').classList.add('visible');
  }

  function hideConfigModal() {
    $('#config-overlay').classList.remove('visible');
  }

  function handleConfigSave() {
    const linkVal = $('#config-readlink') ? $('#config-readlink').value.trim() : '';
    let chId = $('#config-channel') ? $('#config-channel').value.trim() : '';
    let apiKey = $('#config-apikey') ? $('#config-apikey').value.trim() : '';

    if (linkVal) {
      const parsed = parseThingSpeakUrl(linkVal);
      if (parsed.channelId) chId = parsed.channelId;
      if (parsed.apiKey) apiKey = parsed.apiKey;
    }

    if (!chId && !linkVal) {
      showToast('error', 'Please enter a Channel ID or a ThingSpeak Read URL');
      return;
    }

    CONFIG.channelId = chId;
    CONFIG.readApiKey = apiKey;
    CONFIG.readUrl = linkVal || (chId ? `${CONFIG.baseUrl}/channels/${chId}/feeds.json${apiKey ? '?api_key=' + apiKey : ''}` : '');

    saveConfig();
    hideConfigModal();

    const displayChannel = $('#display-channel-id');
    if (displayChannel) displayChannel.textContent = CONFIG.channelId;

    addLog('success', `ThingSpeak parameters saved: Channel ${CONFIG.channelId}`);
    showToast('success', 'Configuration saved! Reconnecting...');

    fetchData();
    startPolling();
  }

  /* ========== System Log ========== */
  function addLog(type, message) {
    const container = $('#log-entries');
    if (!container) return;

    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const now = new Date();
    entry.innerHTML = `
      <span class="log-time">${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}</span>
      <span class="log-type ${type}">${type}</span>
      <span class="log-msg">${message}</span>
    `;

    container.prepend(entry);

    // Cap at 50 entries
    while (container.children.length > 50) {
      container.removeChild(container.lastChild);
    }
  }

  /* ========== Toasts ========== */
  function showToast(type, message) {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  /* ========== Helpers ========== */
  function formatTime(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function timeSince(date) {
    const s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  function average(arr) {
    const nums = arr.filter(v => v !== null && !isNaN(v));
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* ========== Start ========== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
