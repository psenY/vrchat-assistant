const params = new URLSearchParams(window.location.search);
const initialToken = params.get('token') || '';
if (initialToken) {
  sessionStorage.setItem('vrc_monitor_token', initialToken);
  window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
}
const state = { token: initialToken || sessionStorage.getItem('vrc_monitor_token') || '' };
const $ = (id) => document.getElementById(id);

async function request(path) {
  const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
  const response = await fetch(path, { headers });
  if (response.status === 401) {
    const token = window.prompt('请输入 VRC Monitor 访问令牌');
    if (!token) throw new Error('需要访问令牌');
    state.token = token.trim();
    sessionStorage.setItem('vrc_monitor_token', state.token);
    return request(path);
  }
  if (!response.ok) throw new Error(`请求失败 (${response.status})`);
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
function eventLabel(event) {
  const labels = { 'friend-online': '上线', 'friend-offline': '下线', 'friend-location': '进入世界', 'friend-avatar': '更换 Avatar', 'friend-status': '更新状态', 'friend-bio': '更新简介', 'user-location': '你进入世界' };
  return labels[event.type] || event.type || '活动';
}
function eventDetail(event) {
  if (event.world_name) return event.world_name;
  try {
    const content = JSON.parse(event.content_json || '{}');
    return content.worldName || content.location || content.status || content.avatarName || '';
  } catch { return ''; }
}

function renderStatus(health) {
  const stats = health.db || {};
  const online = health.friendState?.online ?? 0;
  const total = health.friendState?.tracked ?? stats.friends ?? 0;
  $('online-count').textContent = online;
  $('online-badge').textContent = online;
  $('friend-count').textContent = `好友总数 ${total}`;
  $('event-count').textContent = stats.events ?? '-';
  $('ws-state').textContent = health.ws?.status === 'connected' ? '已连接' : (health.ws?.status || '未知');
  $('uptime').textContent = `运行时间 ${Math.floor((health.uptime || 0) / 3600)} 小时`;
  $('status-dot').classList.toggle('online', health.ws?.status === 'connected');
  $('connection-label').textContent = health.ws?.status === 'connected' ? '服务在线' : '服务异常';
}
function renderFriends(data) {
  const friends = data.friends || [];
  $('friends-list').innerHTML = friends.length ? friends.map((friend) => {
    const name = friend.nickname || friend.displayName || friend.userId;
    const world = friend.worldName || (friend.locationParsed?.worldId || '私人实例');
    const avatar = friend.avatarImageUrl ? `<img class="avatar" src="${escapeHtml(friend.avatarImageUrl)}" alt="">` : `<span class="avatar avatar-fallback">${escapeHtml(name.slice(0, 1))}</span>`;
    return `<div class="friend">${avatar}<div class="friend-main"><div class="friend-name">${escapeHtml(name)}</div><div class="friend-meta">${escapeHtml(world)}${friend.onlineMinutes != null ? ` · 在线 ${escapeHtml(formatDuration(friend.onlineMinutes))}` : ''}</div></div><span class="status-dot online"></span></div>`;
  }).join('') : '<div class="empty">当前没有在线好友</div>';
}
function renderEvents(data) {
  const events = data.events || [];
  $('events-list').innerHTML = events.length ? events.slice(0, 30).map((event) => `<div class="event"><span class="event-icon">•</span><div class="event-main"><div class="friend-name">${escapeHtml(event.display_name || event.user_id || '自己')} · ${escapeHtml(eventLabel(event))}</div><div class="event-meta">${escapeHtml(eventDetail(event))}</div></div><time class="event-time">${escapeHtml(formatTime(event.created_at))}</time></div>`).join('') : '<div class="empty">还没有活动记录</div>';
}
async function refresh() {
  $('error').hidden = true;
  try {
    const [health, friends, events] = await Promise.all([request('/health'), request('/api/friends/online'), request('/api/events/recent?limit=30')]);
    renderStatus(health); renderFriends(friends); renderEvents(events);
  } catch (error) {
    $('error').textContent = error.message; $('error').hidden = false;
    $('status-dot').classList.remove('online'); $('connection-label').textContent = '无法连接';
  }
}
$('refresh').addEventListener('click', refresh);
refresh();
setInterval(refresh, 30000);
