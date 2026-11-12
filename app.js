/**
 * GBCL AUCTION DAY MANAGER - LOGIC ENGINE
 * Connected to Cloudflare Worker API -> Google Apps Script / Drive / Sheets
 */

const CONFIG = {
  // Cloudflare Worker API URL
  WORKER_API_URL: 'https://gbcl-auction-api.mankrishsolutions.workers.dev',
  // Direct Google Spreadsheet ID fallback
  SHEET_ID: '1V8lK3fQ2Gq1b54y01vJ-9mYl_3rV9iC-8jA5mQ6nB8k'
};

let state = {
  players: [],
  teams: [],
  results: [],
  logs: [],
  activePlayer: null
};

// 1. CELEBRATION HAMMER ANIMATION OVERLAY (SOLD / UNSOLD)
function triggerHammerAnimation(status, playerName, teamName, price) {
  const overlay = document.getElementById('hammerOverlay');
  const card = document.getElementById('hammerCard');
  const icon = document.getElementById('hammerIcon');
  const stamp = document.getElementById('hammerStamp');
  const pName = document.getElementById('hammerPlayerName');
  const subText = document.getElementById('hammerSubText');
  const arenaDeck = document.getElementById('arenaDeckCard');

  if (!overlay || !card) return;

  if (status === 'SOLD') {
    card.className = 'hammer-celebration-card';
    icon.innerText = '🔨';
    stamp.innerText = 'SOLD!';
    pName.innerText = playerName;
    subText.innerText = `Sold to ${teamName} for ₹${Number(price).toLocaleString()}`;
    
    if (arenaDeck) {
      arenaDeck.classList.add('flash-sold');
      setTimeout(() => arenaDeck.classList.remove('flash-sold'), 2200);
    }

    if (typeof confetti === 'function') {
      confetti({
        particleCount: 95,
        spread: 75,
        origin: { y: 0.6 },
        colors: ['#10b981', '#38bdf8', '#facc15', '#a855f7']
      });
    }
  } else {
    card.className = 'hammer-celebration-card unsold-mode';
    icon.innerText = '🚫';
    stamp.innerText = 'UNSOLD';
    pName.innerText = playerName;
    subText.innerText = 'Moved to Re-Auction Pool';

    if (arenaDeck) {
      arenaDeck.classList.add('flash-unsold');
      setTimeout(() => arenaDeck.classList.remove('flash-unsold'), 2200);
    }
  }

  overlay.classList.remove('hidden');

  setTimeout(() => {
    overlay.classList.add('hidden');
  }, 2100);
}

// 2. TOAST NOTIFICATION SYSTEM
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const icons = {
    sold: '🔨',
    unsold: '🚫',
    info: '✅',
    error: '⚠️'
  };

  const toast = document.createElement('div');
  toast.className = `toast-msg ${type}`;
  toast.innerHTML = `<span>${icons[type] || '🔔'}</span><span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// 3. LOG ACTIVITY HELPER
function logUserActivity(message, category = 'info') {
  const entry = {
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    message: message,
    category: category
  };
  state.logs.unshift(entry);
  renderUpdatesFeed();
}

// 4. API REQUEST WITH ROBUST PARSING
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

// 5. DIRECT GVZ FALLBACK
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

// 6. MASTER DATA FETCHER
async function fetchInitialData() {
  setSyncStatus('syncing', 'Syncing...');

  let rawPlayers = [];
  let rawTeams = [];
  let rawLogs = [];

  try {
    const data = await apiRequest('?action=getInitialData');
    if (data && data.success) {
      rawPlayers = data.players || [];
      rawTeams = data.teams || [];
      rawLogs = data.logs || [];
    } else {
      throw new Error(data ? data.error : 'Empty response from worker');
    }
  } catch (workerErr) {
    console.warn('Worker API fallback to direct Sheet:', workerErr);
    try {
      const [p, t] = await Promise.all([
        fetchSheetDirect('Players'),
        fetchSheetDirect('Teams')
      ]);
      rawPlayers = p;
      rawTeams = t;
    } catch (sheetErr) {
      console.error('All data sources failed:', sheetErr);
      setSyncStatus('error', 'Failed');
      showToast('Failed to load sheet data. Check connection.', 'error');
      return;
    }
  }

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

  state.teams = rawTeams.map(t => ({
    ...t,
    TeamID: t.TeamID || '',
    TeamName: t.TeamName || '',
    OwnerName: t.OwnerName || '',
    TotalPurse: Number(t.TotalPurse || 100000),
    LogoURL: t.LogoURL && t.LogoURL !== '-' ? t.LogoURL : '🏏'
  }));

  if (rawLogs.length > 0 && state.logs.length === 0) {
    state.logs = rawLogs.map(l => ({
      timestamp: l.Timestamp || l[1] || 'Synced',
      message: l.Details || l.Action || l[3] || 'Activity recorded',
      category: 'info'
    })).reverse();
  }

  populateTeamDropdowns();
  renderPurseBar();
  renderQueue('PENDING');
  renderTeamsLedgers();
  renderPlayerCardsGrid('upcoming');
  renderPlayerCardsGrid('sold');
  renderPlayerCardsGrid('unsold');
  renderUpdatesFeed();
  renderReportsSummary();

  const pending = state.players.filter(p => p.Status === 'PENDING');
  if (pending.length > 0) {
    loadPlayerToStage(pending[0].PlayerID);
  } else if (state.players.length > 0) {
    loadPlayerToStage(state.players[0].PlayerID);
  }

  setSyncStatus('online', 'Live');
}

// 7. STAGE CONTROLLER
function loadPlayerToStage(id) {
  const p = state.players.find(x => x.PlayerID.toString() === id.toString());
  if (!p) return;
  state.activePlayer = p;

  const photoEl = document.getElementById('stagePhoto');
  if (photoEl) photoEl.src = p.PhotoURL || `https://placehold.co/400x500/0a1128/38bdf8?text=${encodeURIComponent(p.PlayerName)}`;
  
  document.getElementById('stagePlayerID').innerText = `ID: #${p.PlayerID}`;
  document.getElementById('stageName').innerText = p.PlayerName;
  document.getElementById('stageRoleBadge').innerText = p.Role;
  document.getElementById('stageBasePrice').innerText = `₹${p.BasePrice.toLocaleString()}`;
  document.getElementById('stageMobile').innerText = p.Mobile || '--';
  document.getElementById('stageArea').innerText = p.Area || 'N/A';
  document.getElementById('stageBatting').innerText = p.BattingStyle || '--';
  document.getElementById('stageBowling').innerText = p.BowlingStyle || '--';
  document.getElementById('stageAge').innerText = p.Age || '--';

  const badge = document.getElementById('stageBadge');
  if (badge) {
    badge.innerText = p.Status;
    badge.className = `card-status-badge ${p.Status === 'SOLD' ? 'sold' : p.Status === 'UNSOLD' ? 'unsold' : ''}`;
  }

  document.getElementById('stageSoldPrice').value = p.SoldPrice > 0 ? p.SoldPrice : p.BasePrice;
  document.getElementById('stageTeamSelect').value = p.SoldTeamID || '';

  updateSelectedTeamInfo();
}

function updateSelectedTeamInfo() {
  const select = document.getElementById('stageTeamSelect');
  const label = document.getElementById('stageOwnerLabel');
  if (!select || !label) return;

  const team = state.teams.find(t => t.TeamID.toString() === select.value.toString());
  label.innerText = team ? `Owner: ${team.OwnerName}` : 'Owner: --';
}

// 8. RECORD AUCTION (WITH HAMMER CELEBRATION ANIMATION & NOTIFICATIONS)
async function recordAuction(status) {
  if (!state.activePlayer) {
    showToast('Please select a player first.', 'error');
    return;
  }

  const p = state.activePlayer;
  const teamSelect = document.getElementById('stageTeamSelect');
  const priceInput = document.getElementById('stageSoldPrice');
  const btnSold = document.getElementById('btnMarkSold');
  const btnUnsold = document.getElementById('btnMarkUnsold');
  const banner = document.getElementById('hammerResultBanner');

  const teamId = teamSelect ? teamSelect.value : '';
  const soldPrice = priceInput ? Number(priceInput.value) : 0;

  if (status === 'SOLD' && !teamId) {
    showToast('Please choose a purchasing team before marking SOLD!', 'error');
    return;
  }

  const team = state.teams.find(t => t.TeamID.toString() === teamId.toString());
  const teamName = team ? team.TeamName : '';

  if (status === 'SOLD' && team) {
    const spent = state.players.filter(x => x.SoldTeamID.toString() === teamId.toString() && x.PlayerID !== p.PlayerID)
                               .reduce((sum, cur) => sum + Number(cur.SoldPrice || 0), 0);
    const rem = team.TotalPurse - spent;
    if (soldPrice > rem) {
      if (!confirm(`Warning: ${teamName} only has ₹${rem.toLocaleString()} left. Proceed anyway?`)) return;
    }
  }

  btnSold.disabled = true;
  btnUnsold.disabled = true;
  if (status === 'SOLD') {
    btnSold.innerText = '⏳ Processing Sale...';
  } else {
    btnUnsold.innerText = '⏳ Marking Unsold...';
  }
  setSyncStatus('syncing', 'Saving...');

  p.Status = status;
  p.SoldTeamID = status === 'SOLD' ? teamId : '';
  p.SoldPrice = status === 'SOLD' ? soldPrice : 0;

  triggerHammerAnimation(status, p.PlayerName, teamName, soldPrice);

  const logMessage = status === 'SOLD'
    ? `🔨 Player #${p.PlayerID} ${p.PlayerName} SOLD TO ${teamName} for ₹${soldPrice.toLocaleString()}`
    : `🚫 Player #${p.PlayerID} ${p.PlayerName} marked UNSOLD`;

  logUserActivity(logMessage, status === 'SOLD' ? 'sold' : 'unsold');

  if (banner) {
    banner.className = `hammer-banner ${status === 'SOLD' ? 'sold' : 'unsold'}`;
    banner.innerText = logMessage;
  }
  showToast(logMessage, status === 'SOLD' ? 'sold' : 'unsold');

  loadPlayerToStage(p.PlayerID);
  renderPurseBar();
  renderQueue('PENDING');
  renderTeamsLedgers();
  renderPlayerCardsGrid('upcoming');
  renderPlayerCardsGrid('sold');
  renderPlayerCardsGrid('unsold');
  renderReportsSummary();

  try {
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
    setSyncStatus('online', 'Saved');
  } catch (err) {
    console.error(err);
    setSyncStatus('error', 'Sync Failed');
    showToast('Saved locally, but sheet sync failed. Click refresh later.', 'error');
  } finally {
    btnSold.disabled = false;
    btnUnsold.disabled = false;
    btnSold.innerText = '🔨 SOLD';
    btnUnsold.innerText = '🚫 Mark UNSOLD';
  }
}

// 9. RENDER PLAYER CARDS GRIDS
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

  list.forEach((p, idx) => {
    const team = state.teams.find(t => t.TeamID.toString() === p.SoldTeamID.toString());
    const card = document.createElement('div');
    card.className = `player-mini-card ${type === 'sold' ? 'card-sold' : type === 'unsold' ? 'card-unsold' : ''}`;
    card.style.animationDelay = `${Math.min(idx * 0.04, 0.4)}s`;
    card.innerHTML = `
      <span class="badge-number">#${p.PlayerID}</span>
      <img src="${p.PhotoURL || `https://placehold.co/100x100/0a1128/38bdf8?text=${encodeURIComponent(p.PlayerName)}`}" class="card-avatar" alt="${p.PlayerName}" />
      <div class="card-info">
        <div class="card-top-row">
          <span class="card-player-name">${p.PlayerName}</span>
          <span class="card-role-tag">${p.Role}</span>
        </div>
        <div class="card-subtext">${p.Area || 'Player'} • ${p.BattingStyle || ''}</div>
        <div class="card-bottom-row">
          <span class="card-points">${p.Status === 'SOLD' ? '₹' + p.SoldPrice.toLocaleString() : 'Base: ₹' + p.BasePrice.toLocaleString()}</span>
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

// 10. RENDER TEAMS LEDGERS
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
        <div class="team-head-left">
          <div class="team-logo-sq">${t.LogoURL || '🏏'}</div>
          <div>
            <h4 class="team-card-title">${t.TeamName}</h4>
            <span class="team-owner-sub">Owner: ${t.OwnerName}</span>
          </div>
        </div>
      </div>
      <div class="team-metrics-row">
        <div class="metric-item">
          <span class="val blue">₹${(t.TotalPurse / 100000).toFixed(2)}L</span>
          <span class="lbl">PURSE</span>
        </div>
        <div class="metric-item">
          <span class="val pink">₹${(used / 100000).toFixed(2)}L</span>
          <span class="lbl">USED</span>
        </div>
        <div class="metric-item">
          <span class="val green">₹${balance.toLocaleString()}</span>
          <span class="lbl">BALANCE</span>
        </div>
        <div class="metric-item">
          <span class="val">${squad.length}/15</span>
          <span class="lbl">PLAYERS</span>
        </div>
      </div>
      <div class="team-roster-list">
        ${squad.length === 0 ? '<div class="roster-row" style="color:var(--text-muted)">No players assigned yet</div>' : squad.map((p, idx) => `
          <div class="roster-row">
            <span>${idx + 1}. <strong>${p.PlayerName}</strong> (${p.Role})</span>
            <span class="roster-price-badge">₹${Number(p.SoldPrice).toLocaleString()}</span>
          </div>
        `).join('')}
      </div>
    `;
    grid.appendChild(card);
  });
}

// 11. RENDER LIVE UPDATES TIMELINE
function renderUpdatesFeed() {
  const feed = document.getElementById('updatesTimeline');
  if (!feed) return;
  feed.innerHTML = '';

  if (state.logs.length === 0) {
    feed.innerHTML = '<div class="update-entry"><div class="update-text">No auction activity logged yet. Start bidding or add teams/players!</div></div>';
    return;
  }

  state.logs.forEach((log) => {
    const entry = document.createElement('div');
    entry.className = `update-entry ${log.category || 'info'}`;
    entry.innerHTML = `
      <div class="update-text">${log.message}</div>
      <div class="update-time">${log.timestamp}</div>
    `;
    feed.appendChild(entry);
  });
}

// 12. RENDER REPORTS ANALYTICS & TABLE
function renderReportsSummary() {
  const total = state.players.length;
  const sold = state.players.filter(p => p.Status === 'SOLD');
  const unsold = state.players.filter(p => p.Status === 'UNSOLD');
  const totalSpent = sold.reduce((sum, p) => sum + Number(p.SoldPrice || 0), 0);

  const elTotal = document.getElementById('repTotalPlayers');
  const elSold = document.getElementById('repSoldPlayers');
  const elUnsold = document.getElementById('repUnsoldPlayers');
  const elSpent = document.getElementById('repTotalSpent');

  if (elTotal) elTotal.innerText = total;
  if (elSold) elSold.innerText = sold.length;
  if (elUnsold) elUnsold.innerText = unsold.length;
  if (elSpent) elSpent.innerText = `₹${totalSpent.toLocaleString()}`;

  const tbody = document.getElementById('reportTeamsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  state.teams.forEach(t => {
    const squad = state.players.filter(p => p.SoldTeamID.toString() === t.TeamID.toString());
    const used = squad.reduce((sum, p) => sum + Number(p.SoldPrice || 0), 0);
    const rem = t.TotalPurse - used;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${t.LogoURL || '🏏'} ${t.TeamName}</strong></td>
      <td>${t.OwnerName}</td>
      <td>${squad.length} Players</td>
      <td>₹${t.TotalPurse.toLocaleString()}</td>
      <td style="color:#f43f5e;font-weight:700;">₹${used.toLocaleString()}</td>
      <td style="color:#10b981;font-weight:800;">₹${rem.toLocaleString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

// 13. PURSE BAR & QUEUE
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

// 14. ADD PLAYER & PHOTO COMPRESSION
function openAddPlayerModal() {
  document.getElementById('formAddPlayer').reset();
  document.getElementById('newPlayerPhotoPreview').classList.add('hidden');
  const nextId = state.players.length > 0 ? Math.max(...state.players.map(p => Number(p.PlayerID) || 0)) + 1 : 1;
  document.getElementById('newPlayerID').value = nextId;
  openModal('modalAddPlayer');
}

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

function previewOwnerImage(input) {
  const preview = document.getElementById('ownerPhotoPreview');
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
  btn.innerText = '⏳ Saving to Drive & Sheet...';
  setSyncStatus('syncing', 'Saving...');

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

    const msg = `👤 New Player Added: #${payload.playerID} ${payload.playerName} (${payload.role}, Base: ₹${payload.basePrice.toLocaleString()})`;
    logUserActivity(msg, 'player');
    showToast(msg, 'info');

    closeModal('modalAddPlayer');
    await fetchInitialData();
  } catch (err) {
    showToast('Failed to save player: ' + err.message, 'error');
    setSyncStatus('error', 'Failed');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Save Player';
  }
}

// 15. ADD TEAM + OPTIONAL PLAYING OWNER DIRECT ASSIGNMENT
function openAddTeamModal() {
  document.getElementById('formAddTeam').reset();
  document.getElementById('playingOwnerFields').classList.add('hidden');
  document.getElementById('ownerPhotoPreview').classList.add('hidden');
  
  const nextTeamId = state.teams.length > 0 ? Math.max(...state.teams.map(t => Number(t.TeamID) || 0)) + 1 : 1;
  const nextPlayerId = state.players.length > 0 ? Math.max(...state.players.map(p => Number(p.PlayerID) || 0)) + 1 : 1;
  
  document.getElementById('newTeamID').value = nextTeamId;
  document.getElementById('ownerPlayerID').value = nextPlayerId;
  openModal('modalAddTeam');
}

function togglePlayingOwnerFields() {
  const isChecked = document.getElementById('isPlayingOwner').checked;
  const container = document.getElementById('playingOwnerFields');
  if (isChecked) {
    container.classList.remove('hidden');
  } else {
    container.classList.add('hidden');
  }
}

async function submitNewTeam(e) {
  e.preventDefault();
  const btn = document.getElementById('btnSaveTeam');
  btn.disabled = true;
  btn.innerText = '⏳ Saving Team...';
  setSyncStatus('syncing', 'Saving...');

  const teamPayload = {
    teamID: document.getElementById('newTeamID').value.trim(),
    teamName: document.getElementById('newTeamName').value.trim(),
    ownerName: document.getElementById('newTeamOwner').value.trim(),
    logoURL: document.getElementById('newTeamLogo').value.trim() || '🏏',
    totalPurse: Number(document.getElementById('newTeamPurse').value || 100000)
  };

  const isPlayingOwner = document.getElementById('isPlayingOwner').checked;

  try {
    const teamRes = await apiRequest('', 'POST', { action: 'addTeam', payload: teamPayload });
    if (!teamRes.success) throw new Error(teamRes.error || 'Team creation failed');

    logUserActivity(`🏏 New Team Added: ${teamPayload.teamName} (Owner: ${teamPayload.ownerName}, Purse: ₹${teamPayload.totalPurse.toLocaleString()})`, 'team');

    if (isPlayingOwner) {
      btn.innerText = '⏳ Assigning Playing Owner...';
      const ownerPhotoInput = document.getElementById('ownerPhotoFile');
      let imageBase64 = '';
      let imageName = '';

      if (ownerPhotoInput.files && ownerPhotoInput.files[0]) {
        imageName = ownerPhotoInput.files[0].name;
        imageBase64 = await compressPhoto(ownerPhotoInput.files[0]);
      }

      const ownerPlayerId = document.getElementById('ownerPlayerID').value.trim() || (state.players.length + 1).toString();
      const ownerPrice = Number(document.getElementById('ownerPrice').value || 0);

      const playerPayload = {
        playerID: ownerPlayerId,
        playerName: teamPayload.ownerName,
        mobile: document.getElementById('ownerMobile').value.trim() || '9999999999',
        age: document.getElementById('ownerAge').value || '',
        area: document.getElementById('ownerArea').value.trim() || 'Owner',
        basePrice: ownerPrice,
        role: document.getElementById('ownerRole').value,
        battingStyle: 'Right Hand',
        bowlingStyle: 'None',
        category: 'Playing Owner',
        imageBase64: imageBase64,
        imageName: imageName,
        imageType: 'image/jpeg'
      };

      await apiRequest('', 'POST', { action: 'addPlayer', payload: playerPayload });

      await apiRequest('', 'POST', {
        action: 'recordAuctionResult',
        payload: {
          playerID: ownerPlayerId,
          playerName: teamPayload.ownerName,
          status: 'SOLD',
          teamID: teamPayload.teamID,
          teamName: teamPayload.teamName,
          soldPrice: ownerPrice
        }
      });

      logUserActivity(`👑 Playing Owner ${teamPayload.ownerName} assigned directly to ${teamPayload.teamName} (₹${ownerPrice.toLocaleString()})`, 'sold');
    }

    closeModal('modalAddTeam');
    await fetchInitialData();
    showToast(`Team "${teamPayload.teamName}" saved successfully!`, 'info');
  } catch (err) {
    showToast('Failed to save team: ' + err.message, 'error');
    setSyncStatus('error', 'Failed');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Save Team';
  }
}

// 16. TOP MENU NAVIGATION & THEME CONTROLS
function navigateTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.top-nav-item').forEach(btn => btn.classList.remove('active'));

  const activePane = document.getElementById(`tab-${tabId}`);
  if (activePane) activePane.classList.add('active');

  const matchingBtn = document.querySelector(`.top-nav-item[data-tab="${tabId}"]`);
  if (matchingBtn) {
    matchingBtn.classList.add('active');
    matchingBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  if (tabId === 'exports') renderReportsSummary();
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
  const lbl = document.getElementById('syncLabel');
  if (dot) dot.className = `status-dot ${type}`;
  if (lbl && msg) lbl.innerText = msg;
}

// 17. PDF & EXCEL EXPORTS
async function getImageBase64ForPDF(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: 'cors' });
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return null;
  }
}

async function exportPlayerCatalogPDF() {
  const btn = document.getElementById('btnExportCatalogPDF');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Generating 3-Row Photo Catalog...';
  }
  showToast('Preparing player photos for PDF catalog...', 'info');

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'a4');
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    doc.setFillColor(10, 17, 40);
    doc.rect(0, 0, pageWidth, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('GBCL 2026 - OFFICIAL AUCTION PLAYER CATALOG', pageWidth / 2, 11, { align: 'center' });
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(`MMN Golden Boys Champions League | Total Players: ${state.players.length}`, pageWidth / 2, 17, { align: 'center' });

    const marginX = 10;
    const gapX = 5;
    const gapY = 6;
    const cols = 3;
    const cardW = (pageWidth - marginX * 2 - gapX * (cols - 1)) / cols;
    const cardH = 54;

    let startY = 28;
    let colIdx = 0;

    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i];

      if (startY + cardH > pageHeight - 10) {
        doc.addPage();
        startY = 14;
      }

      const x = marginX + colIdx * (cardW + gapX);
      const y = startY;

      doc.setDrawColor(30, 58, 121);
      doc.setFillColor(248, 250, 252);
      doc.roundedRect(x, y, cardW, cardH, 3, 3, 'FD');

      doc.setFillColor(16, 31, 66);
      doc.roundedRect(x, y, cardW, 8, 2, 2, 'F');
      doc.setTextColor(56, 189, 248);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text(`#${p.PlayerID}`, x + 3, y + 5.5);

      doc.setTextColor(255, 255, 255);
      doc.setFontSize(7.5);
      doc.text((p.Role || 'Player').toUpperCase(), x + cardW - 3, y + 5.5, { align: 'right' });

      const photoW = 19;
      const photoH = 23;
      const photoX = x + 3;
      const photoY = y + 11;

      doc.setDrawColor(203, 213, 225);
      doc.rect(photoX, photoY, photoW, photoH);

      const imgData = await getImageBase64ForPDF(p.PhotoURL);
      if (imgData) {
        try {
          doc.addImage(imgData, 'JPEG', photoX, photoY, photoW, photoH);
        } catch (imgErr) {
          doc.setFontSize(6);
          doc.setTextColor(100, 116, 139);
          doc.text('PHOTO', photoX + photoW / 2, photoY + photoH / 2, { align: 'center' });
        }
      } else {
        doc.setFontSize(6);
        doc.setTextColor(100, 116, 139);
        doc.text('NO PHOTO', photoX + photoW / 2, photoY + photoH / 2, { align: 'center' });
      }

      const textX = photoX + photoW + 3;
      const maxTextW = cardW - photoW - 8;

      doc.setTextColor(15, 23, 42);
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'bold');
      const nameLines = doc.splitTextToSize(p.PlayerName || 'Unknown', maxTextW);
      doc.text(nameLines.slice(0, 2), textX, y + 14.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(71, 85, 105);
      doc.text(`Bat: ${p.BattingStyle || '-'}`, textX, y + 24);
      doc.text(`Bowl: ${p.BowlingStyle || '-'}`, textX, y + 28.5);
      doc.text(`Area: ${(p.Area || '-').substring(0, 14)}`, textX, y + 33);

      doc.setFillColor(226, 232, 240);
      doc.rect(x + 1, y + cardH - 10, cardW - 2, 9, 'F');
      doc.setTextColor(5, 150, 105);
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'bold');
      doc.text(`Base: Rs. ${p.BasePrice.toLocaleString()}`, x + cardW / 2, y + cardH - 4, { align: 'center' });

      colIdx++;
      if (colIdx >= cols) {
        colIdx = 0;
        startY += cardH + gapY;
      }
    }

    doc.save('GBCL_PreAuction_Player_Catalog.pdf');
    showToast('3-Row Player Catalog PDF downloaded!', 'info');
  } catch (err) {
    console.error(err);
    showToast('Error generating catalog PDF: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Download 3-Row Player Catalog PDF';
    }
  }
}

function exportTeamsPDF() {
  if (state.teams.length === 0) {
    showToast('No teams available to export.', 'error');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('p', 'mm', 'a4');
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFillColor(10, 17, 40);
  doc.rect(0, 0, pageWidth, 20, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('GBCL 2026 - FRANCHISE SQUADS & PURSE REPORT', pageWidth / 2, 13, { align: 'center' });

  let currentY = 28;

  state.teams.forEach((t) => {
    const squad = state.players.filter(p => p.SoldTeamID.toString() === t.TeamID.toString());
    const used = squad.reduce((sum, p) => sum + Number(p.SoldPrice || 0), 0);
    const balance = t.TotalPurse - used;

    if (currentY > 245) {
      doc.addPage();
      currentY = 18;
    }

    doc.setFillColor(16, 31, 66);
    doc.rect(14, currentY, pageWidth - 28, 12, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10.5);
    doc.setFont('helvetica', 'bold');
    doc.text(`${t.TeamName.toUpperCase()}  (Owner: ${t.OwnerName})`, 18, currentY + 8);

    doc.setFontSize(8.5);
    doc.setTextColor(56, 189, 248);
    doc.text(`Purse: Rs.${t.TotalPurse.toLocaleString()} | Used: Rs.${used.toLocaleString()} | Bal: Rs.${balance.toLocaleString()}`, pageWidth - 18, currentY + 8, { align: 'right' });

    const tableRows = squad.length > 0
      ? squad.map((p, idx) => [
          idx + 1,
          `#${p.PlayerID}`,
          p.PlayerName,
          p.Role,
          p.Area || '-',
          `Rs. ${Number(p.SoldPrice).toLocaleString()}`
        ])
      : [['-', '-', 'No players acquired yet', '-', '-', '-']];

    doc.autoTable({
      startY: currentY + 13,
      margin: { left: 14, right: 14 },
      head: [['#', 'ID', 'Player Name', 'Role', 'Area', 'Price']],
      body: tableRows,
      theme: 'grid',
      headStyles: { fillColor: [30, 58, 121], fontSize: 8 },
      bodyStyles: { fontSize: 8 },
      columnStyles: { 5: { halign: 'right', fontStyle: 'bold' } }
    });

    currentY = doc.lastAutoTable.finalY + 10;
  });

  doc.save('GBCL_All_Teams_Squads.pdf');
  showToast('Teams & Squads PDF downloaded!', 'info');
}

function exportToExcel() {
  const rows = state.players.map(p => {
    const team = state.teams.find(t => t.TeamID.toString() === p.SoldTeamID.toString());
    return {
      'Player ID': p.PlayerID,
      'Name': p.PlayerName,
      'Mobile': p.Mobile,
      'Role': p.Role,
      'Area': p.Area,
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
  showToast('Master Excel file downloaded!', 'info');
}

function exportToPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(14);
  doc.text('GBCL 2026 - Auction Day Master Roster', 14, 15);
  doc.autoTable({
    startY: 22,
    head: [['ID', 'Player Name', 'Role', 'Status', 'Team', 'Sold Price']],
    body: state.players.map(p => {
      const team = state.teams.find(t => t.TeamID.toString() === p.SoldTeamID.toString());
      return [p.PlayerID, p.PlayerName, p.Role, p.Status, team ? team.TeamName : '-', `Rs. ${p.SoldPrice}`];
    }),
    headStyles: { fillColor: [16, 31, 66] }
  });
  doc.save('GBCL_Auction_Summary_Table.pdf');
  showToast('Summary Table PDF downloaded!', 'info');
}

// 18. INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
  fetchInitialData();
});
