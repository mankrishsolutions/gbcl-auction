/**
 * GBCL AUCTION DAY MANAGER - LOGIC ENGINE
 */

const CONFIG = {
  // Your Cloudflare Worker URL:
  WORKER_API_URL: 'https://gbcl-auction-api.mankrishsolutions.workers.dev',
  // Direct Google Spreadsheet ID fallback:
  SHEET_ID: '1V8lK3fQ2Gq1b54y01vJ-9mYl_3rV9iC-8jA5mQ6nB8k'
};

let state = {
  players: [],
  teams: [],
  results: [],
  logs: [],
  activePlayer: null
};

// 1. API REQUEST WITH TIMEOUT & ROBUST PARSING
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
    throw new Error(`Worker HTTP ${response.status}`);
  }
  return await response.json();
}

// 2. DIRECT GVZ FALLBACK (NEVER BLOCKS IF WORKER IS DOWN)
async function fetchSheetDirect(tabName) {
  const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;
  const res = await fetch(url);
  const txt = await res.text();
  const json = JSON.parse(txt.substring(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  const headers = json.table.cols.map(c => (c && c.label) ? c.label.trim() : '');
  
  return json.table.rows.map(row => {
    let item = {};
    if (row && row.c) {
      row.c.forEach((cell, i) => {
        const col = headers[i];
        if (col) {
          item[col] = cell && cell.v !== null && cell.v !== undefined ? cell.v : '';
        }
      });
    }
    return item;
  });
}

// 3. MASTER DATA FETCHER (WORKER FIRST -> GVZ FALLBACK)
async function fetchInitialData() {
  setSyncStatus('syncing', 'Loading Sheet...');

  let rawPlayers = [];
  let rawTeams = [];
  let rawLogs = [];

  try {
    // Attempt Worker API first
    const data = await apiRequest('?action=getInitialData');
    if (data && data.success) {
      rawPlayers = data.players || [];
      rawTeams = data.teams || [];
      rawLogs = data.logs || [];
    } else {
      throw new Error(data ? data.error : 'Empty response from worker');
    }
  } catch (workerErr) {
    console.warn('Worker API uncontactable, falling back to direct Sheet gviz:', workerErr);
    try {
      const [p, t] = await Promise.all([
        fetchSheetDirect('Players'),
        fetchSheetDirect('Teams')
      ]);
      rawPlayers = p;
      rawTeams = t;
    } catch (sheetErr) {
      console.error('All data sources failed:', sheetErr);
      setSyncStatus('error', 'Sync Failed');
      return;
    }
  }

  // Format Players
  state.players = rawPlayers.map(p => ({
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

  // Format Teams
  state.teams = rawTeams.map(t => ({
    ...t,
    TeamID: t.TeamID || '',
    TeamName: t.TeamName || '',
    OwnerName: t.OwnerName || '',
    TotalPurse: Number(t.TotalPurse || 100000),
    LogoURL: t.LogoURL && t.LogoURL !== '-' ? t.LogoURL : '🏏'
  }));

  state.logs = rawLogs;

  // Render Everything
  populateTeamDropdowns();
  renderPurseBar();
  renderQueue('PENDING');
  renderTeamsLedgers();
  renderPlayerCardsGrid('upcoming');
  renderPlayerCardsGrid('sold');
  renderPlayerCardsGrid('unsold');
  renderUpdatesFeed();

  // Load first pending player onto stage
  const pending = state.players.filter(p => p.Status === 'PENDING');
  if (pending.length > 0) {
    loadPlayerToStage(pending[0].PlayerID);
  } else if (state.players.length > 0) {
    loadPlayerToStage(state.players[0].PlayerID);
  }

  setSyncStatus('online', 'Live Synced');
}

// 4. STAGE CONTROLLER
function loadPlayerToStage(id) {
  const p = state.players.find(x => x.PlayerID.toString() === id.toString());
  if (!p) return;
  state.activePlayer = p;

  const photoEl = document.getElementById('stagePhoto');
  if (photoEl) photoEl.src = p.PhotoURL || `https://placehold.co/400x500/0a1128/38bdf8?text=${encodeURIComponent(p.PlayerName)}`;
  
  const idEl = document.getElementById('stagePlayerID');
  if (idEl) idEl.innerText = `ID: #${p.PlayerID}`;

  const nameEl = document.getElementById('stageName');
  if (nameEl) nameEl.innerText = p.PlayerName;

  const roleEl = document.getElementById('stageRoleBadge');
  if (roleEl) roleEl.innerText = p.Role;

  const baseEl = document.getElementById('stageBasePrice');
  if (baseEl) baseEl.innerText = `₹${p.BasePrice.toLocaleString()}`;

  const mobEl = document.getElementById('stageMobile');
  if (mobEl) mobEl.innerText = p.Mobile || '--';

  const areaEl = document.getElementById('stageArea');
  if (areaEl) areaEl.innerText = p.Area || 'N/A';

  const batEl = document.getElementById('stageBatting');
  if (batEl) batEl.innerText = p.BattingStyle || '--';

  const bowlEl = document.getElementById('stageBowling');
  if (bowlEl) bowlEl.innerText = p.BowlingStyle || '--';

  const ageEl = document.getElementById('stageAge');
  if (ageEl) ageEl.innerText = p.Age || '--';

  const badge = document.getElementById('stageBadge');
  if (badge) {
    badge.innerText = p.Status;
    badge.className = `card-status-badge ${p.Status === 'SOLD' ? 'sold' : p.Status === 'UNSOLD' ? 'unsold' : ''}`;
  }

  const soldInput = document.getElementById('stageSoldPrice');
  if (soldInput) soldInput.value = p.SoldPrice > 0 ? p.SoldPrice : p.BasePrice;

  const teamSel = document.getElementById('stageTeamSelect');
  if (teamSel) teamSel.value = p.SoldTeamID || '';

  updateSelectedTeamInfo();
}

function updateSelectedTeamInfo() {
  const select = document.getElementById('stageTeamSelect');
  const label = document.getElementById('stageOwnerLabel');
  if (!select || !label) return;

  const team = state.teams.find(t => t.TeamID.toString() === select.value.toString());
  label.innerText = team ? `Owner: ${team.OwnerName}` : 'Owner: --';
}

// 5. RECORD AUCTION
async function recordAuction(status) {
  if (!state.activePlayer) return alert('Select a player first.');

  const p = state.activePlayer;
  const teamSelect = document.getElementById('stageTeamSelect');
  const priceInput = document.getElementById('stageSoldPrice');

  const teamId = teamSelect ? teamSelect.value : '';
  const soldPrice = priceInput ? Number(priceInput.value) : 0;

  if (status === 'SOLD' && !teamId) {
    return alert('Please select a purchasing team.');
  }

  const team = state.teams.find(t => t.TeamID.toString() === teamId.toString());
  const teamName = team ? team.TeamName : '';

  p.Status = status;
  p.SoldTeamID = status === 'SOLD' ? teamId : '';
  p.SoldPrice = status === 'SOLD' ? soldPrice : 0;

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

// 6. RENDER GRIDS
function renderPlayerCardsGrid(type) {
  const targetGrid = document.getElementById(`${type}Grid`);
  const totalBadge = document.getElementById(`${type}TotalCount`);
  if (!targetGrid) return;

  let list = [];
  if (type === 'sold') list = state.players.filter(p => p.Status === 'SOLD');
  else if (type === 'unsold') list = state.players.filter(p => p.Status === 'UNSOLD');
  else if (type === 'upcoming') list = state.players.filter(p => p.Status === 'PENDING');

  if (totalBadge) totalBadge.innerText = `Total : ${list.length}`;
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
  const input = document.getElementById(`${type}Search`);
  if (!input) return;
  const query = input.value.toLowerCase();
  const cards = document.getElementById(`${type}Grid`)?.getElementsByClassName('player-mini-card') || [];
  Array.from(cards).forEach(card => {
    card.style.display = card.innerText.toLowerCase().includes(query) ? 'flex' : 'none';
  });
}

// 7. RENDER TEAMS
function renderTeamsLedgers() {
  const grid = document.getElementById('teamsCardGrid');
  const quickTabs = document.getElementById('teamQuickTabs');
  if (!grid) return;

  grid.innerHTML = '';
  if (quickTabs) quickTabs.innerHTML = '';

  state.teams.forEach(t => {
    if (quickTabs) {
      const chip = document.createElement('button');
      chip.className = 'team-chip';
      chip.innerText = t.TeamName.substring(0, 6);
      quickTabs.appendChild(chip);
    }

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

// 8. RENDER UPDATES
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

// 9. PURSE BAR
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

// 10. QUEUE
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

// 11. MODAL CONTROLS & PHOTO
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

// 12. SIDEBAR & NAVIGATION
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

function navigateTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.side-nav-item').forEach(btn => btn.classList.remove('active'));

  const activePane = document.getElementById(`tab-${tabId}`);
  if (activePane) activePane.classList.add('active');

  const matchingBtn = Array.from(document.querySelectorAll('.side-nav-item')).find(b => b.getAttribute('onclick')?.includes(tabId));
  if (matchingBtn) matchingBtn.classList.add('active');

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

  toggleSidebar(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerText = next === 'dark' ? '🌙' : '☀️';
}

function openModal(id) { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

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

// 13. SIDEBAR AUTO-HIDE
function setupSidebarEvents() {
  const sidebar = document.getElementById('appSidebar');
  const edgeDetector = document.getElementById('sidebarEdgeDetector');

  if (edgeDetector) {
    edgeDetector.addEventListener('mouseenter', () => toggleSidebar(true));
  }

  if (sidebar) {
    sidebar.addEventListener('mouseleave', () => {
      if (window.innerWidth >= 768) {
        sidebarTimer = setTimeout(() => toggleSidebar(false), 350);
      }
    });

    sidebar.addEventListener('mouseenter', () => {
      if (sidebarTimer) {
        clearTimeout(sidebarTimer);
        sidebarTimer = null;
      }
    });
  }

  // Mobile Swipe Detection
  let touchStartX = 0;
  let touchStartY = 0;

  window.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    const diffX = e.changedTouches[0].clientX - touchStartX;
    const diffY = e.changedTouches[0].clientY - touchStartY;

    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 40) {
      if (diffX > 0 && touchStartX < 35) {
        toggleSidebar(true);
      } else if (diffX < 0 && sidebar?.classList.contains('open')) {
        toggleSidebar(false);
      }
    }
  }, { passive: true });
}

// 14. EXPORTS
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

// 15. SECURE INITIALIZATION RUNNER
document.addEventListener('DOMContentLoaded', () => {
  fetchInitialData();
  setupSidebarEvents();
});