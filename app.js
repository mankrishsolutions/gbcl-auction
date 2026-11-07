/**
 * GBCL AUCTION DAY MANAGER - LOGIC ENGINE
 * Connected to Cloudflare Worker API -> Google Apps Script / Drive / Sheets
 */

// 1. CONFIGURATION
const CONFIG = {
  // Your Cloudflare Worker URL:
  WORKER_API_URL: 'https://gbcl-auction-api.mankrishsolutions.workers.dev'
};

// 2. STATE STORAGE
let state = {
  players: [],
  teams: [],
  results: [],
  logs: [],
  activePlayer: null
};

// 3. API CALL VIA CLOUDFLARE WORKER
async function apiRequest(endpoint, method = 'GET', body = null) {
  const baseUrl = CONFIG.WORKER_API_URL.replace(/\/+$/, '');
  const url = endpoint.startsWith('?') ? `${baseUrl}/${endpoint}` : `${baseUrl}${endpoint}`;

  const options = {
    method: method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP Error: ${response.status}`);
  }
  return await response.json();
}

// 4. LOAD INITIAL DATA
async function fetchInitialData() {
  try {
    setSyncStatus('syncing', 'Loading Sheet...');

    const data = await apiRequest('?action=getInitialData');
    if (!data || !data.success) throw new Error(data ? data.error : 'Server error');

    // Clean Players
    state.players = (data.players || []).map(p => ({
      ...p,
      PlayerID: p.PlayerID || '',
      PlayerName: p.PlayerName || '',
      BasePrice: Number(p.BasePrice || 0),
      SoldPrice: Number(p.SoldPrice || 0),
      Status: (p.Status || 'PENDING').toString().toUpperCase().trim(),
      Age: p.Age || '',
      Area: p.Area || '',
      Role: p.Role || 'Batsman',
      BattingStyle: p.BattingStyle || 'Right Hand',
      BowlingStyle: p.BowlingStyle || 'None',
      PhotoURL: p.PhotoURL && p.PhotoURL !== '-' ? p.PhotoURL : ''
    }));

    // Clean Teams
    state.teams = (data.teams || []).map(t => ({
      ...t,
      TeamID: t.TeamID || '',
      TeamName: t.TeamName || '',
      OwnerName: t.OwnerName || '',
      TotalPurse: Number(t.TotalPurse || 100000),
      LogoURL: t.LogoURL && t.LogoURL !== '-' ? t.LogoURL : '🏏'
    }));

    state.results = data.results || [];
    state.logs = data.logs || [];

    // Populate UI
    populateTeamDropdowns();
    renderPurseBar();
    renderQueue('PENDING');

    // Render Subsections
    renderTeamsLedgers();
    renderPlayerCardsGrid('upcoming');
    renderPlayerCardsGrid('sold');
    renderPlayerCardsGrid('unsold');
    renderUpdatesFeed();

    // Load active player on stage
    const pending = state.players.filter(p => p.Status === 'PENDING');
    if (pending.length > 0) {
      loadPlayerToStage(pending[0].PlayerID);
    } else if (state.players.length > 0) {
      loadPlayerToStage(state.players[0].PlayerID);
    }

    setSyncStatus('online', 'Live Synced');
  } catch (err) {
    console.error('Fetch error:', err);
    setSyncStatus('error', 'Sync Failed');
  }
}

// 5. STAGE MANAGEMENT
function loadPlayerToStage(id) {
  const p = state.players.find(x => x.PlayerID.toString() === id.toString());
  if (!p) return;
  state.activePlayer = p;

  document.getElementById('stagePhoto').src = p.PhotoURL || `https://placehold.co/400x500/0a1128/38bdf8?text=${encodeURIComponent(p.PlayerName)}`;
  document.getElementById('stagePlayerID').innerText = `ID: #${p.PlayerID}`;
  document.getElementById('stageName').innerText = p.PlayerName;
  document.getElementById('stageRoleBadge').innerText = p.Role;
  document.getElementById('stageBasePrice').innerText = `₹${p.BasePrice.toLocaleString()}`;
  document.getElementById('stageMobile').innerText = p.Mobile;
  document.getElementById('stageArea').innerText = p.Area || 'N/A';
  document.getElementById('stageBatting').innerText = p.BattingStyle;
  document.getElementById('stageBowling').innerText = p.BowlingStyle;
  document.getElementById('stageAge').innerText = p.Age || '--';

  const badge = document.getElementById('stageBadge');
  badge.innerText = p.Status;
  badge.className = `card-status-badge ${p.Status === 'SOLD' ? 'sold' : p.Status === 'UNSOLD' ? 'unsold' : ''}`;

  document.getElementById('stageSoldPrice').value = p.SoldPrice > 0 ? p.SoldPrice : p.BasePrice;
  document.getElementById('stageTeamSelect').value = p.SoldTeamID || '';
  updateSelectedTeamInfo();
}

function updateSelectedTeamInfo() {
  const teamId = document.getElementById('stageTeamSelect').value;
  const team = state.teams.find(t => t.TeamID.toString() === teamId.toString());
  document.getElementById('stageOwnerLabel').innerText = team ? `Owner: ${team.OwnerName}` : 'Owner: --';
}

// 6. HAMMER ACTION (SOLD / UNSOLD)
async function recordAuction(status) {
  if (!state.activePlayer) return alert('Select a player first.');

  const p = state.activePlayer;
  const teamId = document.getElementById('stageTeamSelect').value;
  const soldPrice = Number(document.getElementById('stageSoldPrice').value);

  if (status === 'SOLD' && !teamId) {
    return alert('Please select a purchasing team.');
  }

  const team = state.teams.find(t => t.TeamID.toString() === teamId.toString());
  const teamName = team ? team.TeamName : '';

  // Update locally immediately
  p.Status = status;
  p.SoldTeamID = status === 'SOLD' ? teamId : '';
  p.SoldPrice = status === 'SOLD' ? soldPrice : 0;

  // Add live update row to logs
  state.logs.unshift({
    timestamp: new Date().toLocaleTimeString(),
    message: `${p.PlayerName} ${status === 'SOLD' ? 'SOLD TO ' + teamName + ' (' + soldPrice + ')' : 'MARKED UNSOLD'}`
  });

  loadPlayerToStage(p.PlayerID);
  renderPurseBar();
  renderQueue('PENDING');
  renderTeamsLedgers();
  renderPlayerCardsGrid('upcoming');
  renderPlayerCardsGrid('sold');
  renderPlayerCardsGrid('unsold');
  renderUpdatesFeed();

  try {
    setSyncStatus('syncing', 'Recording hammer...');
    await apiRequest('', 'POST', {
      action: 'recordAuctionResult',
      payload: {
        playerID: p.PlayerID,
        playerName: p.PlayerName,
        status: status,
        teamID: teamId,
        teamName: teamName,
        soldPrice: soldPrice
      }
    });
    setSyncStatus('online', 'Live Synced');
  } catch (err) {
    console.error(err);
    setSyncStatus('error', 'Sync Failed');
  }
}

// 7. RENDER PLAYER CARDS GRID (SOLD / UNSOLD / UPCOMING)
function renderPlayerCardsGrid(type) {
  let targetGrid = document.getElementById(`${type}Grid`);
  let totalBadge = document.getElementById(`${type}TotalCount`);
  if (!targetGrid) return;

  let list = [];
  if (type === 'sold') list = state.players.filter(p => p.Status === 'SOLD');
  else if (type === 'unsold') list = state.players.filter(p => p.Status === 'UNSOLD');
  else if (type === 'upcoming') list = state.players.filter(p => p.Status === 'PENDING');

  totalBadge.innerText = `Total : ${list.length}`;
  targetGrid.innerHTML = '';

  list.forEach(p => {
    const team = state.teams.find(t => t.TeamID.toString() === p.SoldTeamID.toString());
    const card = document.createElement('div');
    card.className = 'player-mini-card';
    card.innerHTML = `
      <span class="badge-number">#${p.PlayerID}</span>
      <img src="${p.PhotoURL || `https://placehold.co/100x100/0a1128/38bdf8?text=${encodeURIComponent(p.PlayerName)}`}" class="card-avatar" alt="${p.PlayerName}" />
      <div class="card-info">
        <div class="card-top-row">
          <span class="card-player-name">${p.PlayerName}</span>
          <span class="card-role-tag">${p.Role}</span>
        </div>
        <div class="card-subtext">LPL / ${p.Area || 'All Rounder'}</div>
        <div class="card-bottom-row">
          <span class="card-points">${p.Status === 'SOLD' ? p.SoldPrice + ' Pts.' : p.BasePrice + ' Base'}</span>
          <span class="card-team-name">${team ? team.TeamName : 'Available'}</span>
        </div>
      </div>
    `;
    card.onclick = () => {
      loadPlayerToStage(p.PlayerID);
      navigateTab('arena');
    };
    targetGrid.appendChild(card);
  });
}

function filterPlayerGrid(type) {
  const query = document.getElementById(`${type}Search`).value.toLowerCase();
  const cards = document.getElementById(`${type}Grid`).getElementsByClassName('player-mini-card');
  Array.from(cards).forEach(card => {
    const text = card.innerText.toLowerCase();
    card.style.display = text.includes(query) ? 'flex' : 'none';
  });
}

// 8. RENDER TEAMS LEDGERS
function renderTeamsLedgers() {
  const grid = document.getElementById('teamsCardGrid');
  const quickTabs = document.getElementById('teamQuickTabs');
  if (!grid) return;

  grid.innerHTML = '';
  quickTabs.innerHTML = '';

  state.teams.forEach(t => {
    const chip = document.createElement('button');
    chip.className = 'team-chip';
    chip.innerText = t.TeamName.substring(0, 6);
    quickTabs.appendChild(chip);

    const squad = state.players.filter(p => p.SoldTeamID.toString() === t.TeamID.toString());
    const used = squad.reduce((acc, p) => acc + Number(p.SoldPrice || 0), 0);
    const balance = t.TotalPurse - used;

    const card = document.createElement('div');
    card.className = 'team-ledger-card';
    card.innerHTML = `
      <div class="team-card-head">
        <div class="team-logo-sq">${t.LogoURL || '🏏'}</div>
        <h4 class="team-card-title">${t.TeamName}</h4>
      </div>

      <div class="team-metrics-row">
        <div class="metric-item">
          <span class="val blue">${(t.TotalPurse / 100000).toFixed(2)} LAC</span>
          <span class="lbl">PURSE</span>
        </div>
        <div class="metric-item">
          <span class="val pink">${(used / 100000).toFixed(2)} LAC</span>
          <span class="lbl">USED</span>
        </div>
        <div class="metric-item">
          <span class="val green">${balance.toLocaleString()}</span>
          <span class="lbl">BALANCE</span>
        </div>
        <div class="metric-item">
          <span class="val">${squad.length}/15</span>
          <span class="lbl">PLAYERS</span>
        </div>
      </div>

      <div class="team-roster-list">
        ${squad.map((p, idx) => `
          <div class="roster-row">
            <span>${idx + 1}. <strong>${p.PlayerName}</strong> (${p.Role})</span>
            <span class="roster-price-badge">${p.SoldPrice}</span>
          </div>
        `).join('')}
      </div>
    `;
    grid.appendChild(card);
  });
}

// 9. RENDER UPDATES TIMELINE
function renderUpdatesFeed() {
  const feed = document.getElementById('updatesTimeline');
  if (!feed) return;
  feed.innerHTML = '';

  if (state.logs.length === 0) {
    feed.innerHTML = '<p class="update-entry update-text">No auction activity logged yet.</p>';
    return;
  }

  state.logs.forEach((log, i) => {
    const entry = document.createElement('div');
    entry.className = `update-entry ${i === 0 ? 'latest' : ''}`;
    entry.innerHTML = `
      <div class="update-text">${log.message || log.details || log[3] || 'Activity recorded'}</div>
      <div class="update-time">${log.timestamp || 'Just now'}</div>
    `;
    feed.appendChild(entry);
  });
}

// 10. BOTTOM PURSE TRACKER
function renderPurseBar() {
  const bar = document.getElementById('stickyPurseBar');
  if (!bar) return;
  bar.innerHTML = '';

  state.teams.forEach(t => {
    const bought = state.players.filter(p => p.SoldTeamID.toString() === t.TeamID.toString());
    const spent = bought.reduce((sum, p) => sum + Number(p.SoldPrice || 0), 0);
    const rem = t.TotalPurse - spent;

    const chip = document.createElement('div');
    chip.className = 'purse-chip';
    chip.innerHTML = `<strong>${t.TeamName}</strong>: ${bought.length} plyrs | Rem: ₹${rem.toLocaleString()}`;
    bar.appendChild(chip);
  });
}

// 11. QUEUE CAROUSEL
function renderQueue(status = 'PENDING') {
  const container = document.getElementById('arenaQueueList');
  if (!container) return;
  container.innerHTML = '';

  const list = state.players.filter(p => p.Status === status);
  list.forEach(p => {
    const btn = document.createElement('button');
    btn.className = `queue-chip ${state.activePlayer && state.activePlayer.PlayerID === p.PlayerID ? 'active' : ''}`;
    btn.innerText = `#${p.PlayerID} ${p.PlayerName}`;
    btn.onclick = () => loadPlayerToStage(p.PlayerID);
    container.appendChild(btn);
  });
}

function filterQueue(type) {
  renderQueue(type === 'RE_AUCTION' ? 'UNSOLD' : 'PENDING');
}

// 12. ADD PLAYER & PHOTO COMPRESSION
async function compressPhoto(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width, height = img.height;
        const MAX = 400;
        if (width > height && width > MAX) {
          height = Math.round((height * MAX) / width);
          width = MAX;
        } else if (height > MAX) {
          width = Math.round((width * MAX) / height);
          height = MAX;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function previewPlayerImage(input) {
  const preview = document.getElementById('newPlayerPhotoPreview');
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.src = e.target.result;
      preview.classList.remove('hidden');
    };
    reader.readAsDataURL(input.files[0]);
  }
}

async function submitNewPlayer(e) {
  e.preventDefault();
  const btn = document.getElementById('btnSavePlayer');
  btn.disabled = true;
  btn.innerText = 'Saving to Drive...';

  const fileInput = document.getElementById('newPlayerPhotoFile');
  let imageBase64 = '';
  let imageName = '';

  if (fileInput.files && fileInput.files[0]) {
    imageName = fileInput.files[0].name;
    imageBase64 = await compressPhoto(fileInput.files[0]);
  }

  const payload = {
    playerID: document.getElementById('newPlayerID').value.trim(),
    playerName: document.getElementById('newPlayerName').value.trim(),
    mobile: document.getElementById('newPlayerMobile').value.trim(),
    age: document.getElementById('newPlayerAge').value,
    area: document.getElementById('newPlayerArea').value.trim(),
    basePrice: Number(document.getElementById('newPlayerBasePrice').value),
    role: document.getElementById('newPlayerRole').value,
    battingStyle: document.getElementById('newPlayerBatting').value,
    bowlingStyle: document.getElementById('newPlayerBowling').value.trim(),
    imageBase64: imageBase64,
    imageName: imageName,
    imageType: 'image/jpeg'
  };

  try {
    const res = await apiRequest('', 'POST', { action: 'addPlayer', payload: payload });
    if (!res.success) throw new Error(res.error || 'Server error');

    closeModal('modalAddPlayer');
    await fetchInitialData();
    alert(`Player "${payload.playerName}" saved to Google Sheets and Drive!`);
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'Save Player';
  }
}

// 13. ADD TEAM
async function submitNewTeam(e) {
  e.preventDefault();
  const btn = document.getElementById('btnSaveTeam');
  btn.disabled = true;
  btn.innerText = 'Saving Team...';

  const payload = {
    teamID: document.getElementById('newTeamID').value.trim(),
    teamName: document.getElementById('newTeamName').value.trim(),
    ownerName: document.getElementById('newTeamOwner').value.trim(),
    logoURL: document.getElementById('newTeamLogo').value.trim() || '🏏',
    totalPurse: Number(document.getElementById('newTeamPurse').value || 100000)
  };

  try {
    const res = await apiRequest('', 'POST', { action: 'addTeam', payload: payload });
    if (!res.success) throw new Error(res.error || 'Server error');

    closeModal('modalAddTeam');
    await fetchInitialData();
    alert(`Team "${payload.teamName}" added!`);
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'Save Team';
  }
}

// SIDEBAR CONTROL WITH AUTO-HIDE & UNHIDE LOGIC
let sidebarTimer = null;

function toggleSidebar(open) {
  const sidebar = document.getElementById('appSidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!sidebar) return;

  if (sidebarTimer) {
    clearTimeout(sidebarTimer);
    sidebarTimer = null;
  }

  if (open) {
    sidebar.classList.add('open');
    if (overlay) overlay.classList.add('active');
  } else {
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
  }
}

// SETUP AUTO-HIDE AND UNHIDE LISTENERS
function setupSidebarAutoHide() {
  const sidebar = document.getElementById('appSidebar');
  const edgeDetector = document.getElementById('sidebarEdgeDetector');

  if (!sidebar) return;

  // 1. Desktop: Hover left edge to unhide
  if (edgeDetector) {
    edgeDetector.addEventListener('mouseenter', () => {
      toggleSidebar(true);
    });
  }

  // 2. Desktop: Mouse leaves sidebar -> auto-hide with 400ms buffer
  sidebar.addEventListener('mouseleave', () => {
    // Only auto-hide on desktop screens
    if (window.innerWidth >= 768) {
      sidebarTimer = setTimeout(() => {
        toggleSidebar(false);
      }, 350);
    }
  });

  sidebar.addEventListener('mouseenter', () => {
    if (sidebarTimer) {
      clearTimeout(sidebarTimer);
      sidebarTimer = null;
    }
  });

  // 3. Mobile Touch Gestures: Swipe from edge to open, swipe left to close
  let touchStartX = 0;
  let touchStartY = 0;

  window.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const diffX = touchEndX - touchStartX;
    const diffY = touchEndY - touchStartY;

    // Ensure horizontal gesture intent (not vertical scroll)
    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 40) {
      // Swiped right from left boundary (< 35px) -> Open sidebar
      if (diffX > 0 && touchStartX < 35) {
        toggleSidebar(true);
      }
      // Swiped left while sidebar is open -> Close sidebar
      else if (diffX < 0 && sidebar.classList.contains('open')) {
        toggleSidebar(false);
      }
    }
  }, { passive: true });
}

function navigateTab(tabId) {
  // Hide all panes
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.side-nav-item').forEach(btn => btn.classList.remove('active'));

  // Show active pane
  const activePane = document.getElementById(`tab-${tabId}`);
  if (activePane) activePane.classList.add('active');

  // Highlight sidebar item
  const matchingBtn = Array.from(document.querySelectorAll('.side-nav-item')).find(b => b.getAttribute('onclick')?.includes(tabId));
  if (matchingBtn) matchingBtn.classList.add('active');

  // Update header title
  const titles = {
    intro: 'Tournament Intro',
    arena: 'Auction Arena',
    teams: 'Teams & Squads',
    upcoming: 'Upcoming Players',
    sold: 'Sold Players',
    unsold: 'Unsold Players',
    updates: 'Live Updates',
    exports: 'Reports & Export'
  };
  const titleEl = document.getElementById('pageHeaderTitle');
  if (titleEl) titleEl.innerText = titles[tabId] || 'GBCL Auction';

  // Close sidebar on mobile after tapping
  toggleSidebar(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  document.getElementById('themeToggleBtn').innerText = next === 'dark' ? '🌙' : '☀️';
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function populateTeamDropdowns() {
  const sel = document.getElementById('stageTeamSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Choose Purchasing Team --</option>';
  state.teams.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.TeamID;
    opt.innerText = `${t.TeamName} (${t.OwnerName})`;
    sel.appendChild(opt);
  });
}

function setSyncStatus(type, msg) {
  const dot = document.getElementById('syncDot');
  if (dot) dot.className = `status-dot ${type}`;
}

// 15. EXPORT UTILITIES
function exportToExcel() {
  const rows = state.players.map(p => {
    const team = state.teams.find(t => t.TeamID.toString() === p.SoldTeamID.toString());
    return {
      'Player ID': p.PlayerID,
      'Name': p.PlayerName,
      'Role': p.Role,
      'Base Price': p.BasePrice,
      'Status': p.Status,
      'Team': team ? team.TeamName : 'None',
      'Sold Price': p.SoldPrice
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Roster');
  XLSX.writeFile(wb, 'GBCL_Auction_Summary.xlsx');
}

function exportToPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.text('GBCL Auction Day Roster', 14, 15);
  doc.autoTable({
    startY: 22,
    head: [['ID', 'Player Name', 'Role', 'Status', 'Sold Price']],
    body: state.players.map(p => [p.PlayerID, p.PlayerName, p.Role, p.Status, p.SoldPrice])
  });
  doc.save('GBCL_Auction_Report.pdf');
}

// Call inside window.onload
const originalInit = window.onload;
window.onload = () => {
  if (typeof originalInit === 'function') originalInit();
  setupSidebarAutoHide();
};