// Noa side panel - shared across all pages
const SESSION_KEY = 'noa_chat_history';

let chatHistory = [];
try { chatHistory = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]'); } catch (e) {}

function saveHistory() {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(chatHistory.slice(-60))); } catch (e) {}
}

function openPanel() {
  document.getElementById('noa-panel').classList.remove('translate-x-full');
  document.getElementById('noa-overlay').classList.remove('hidden');
  document.getElementById('noa-messages').scrollTop = 999999;
}

function closePanel() {
  document.getElementById('noa-panel').classList.add('translate-x-full');
  document.getElementById('noa-overlay').classList.add('hidden');
}

function appendMessage(role, text) {
  const container = document.getElementById('noa-messages');
  if (!container) return;
  const isUser = role === 'user';
  const div = document.createElement('div');
  div.className = `flex flex-col items-${isUser ? 'end' : 'start'} w-full`;
  div.innerHTML = `
    <div class="max-w-[88%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${isUser
      ? 'bg-[#f0607a22] border border-[#f0607a33] rounded-tr-none text-[#e7e1e5]'
      : 'bg-[#2c292c] rounded-tl-none text-[#e7e1e5]'
    }">${text.replace(/\n/g, '<br>')}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function setLoading(on) {
  const btn = document.getElementById('noa-send');
  if (!btn) return;
  btn.innerHTML = on
    ? '<span class="material-symbols-outlined text-sm animate-spin">refresh</span>'
    : '<span class="material-symbols-outlined text-sm">send</span>';
  btn.disabled = on;
}

function handleAction(a) {
  try {
    if (a.type === 'set_priorities') {
      localStorage.setItem('noa_priorities', JSON.stringify(a.items));
    } else if (a.type === 'set_schedule') {
      const date = a.date || new Date().toISOString().split('T')[0];
      localStorage.setItem(`noa_schedule_${date}`, JSON.stringify(a.items));
    } else if (a.type === 'update_rituals') {
      const cur = JSON.parse(localStorage.getItem('noa_rituals') || '{}');
      localStorage.setItem('noa_rituals', JSON.stringify({
        bible: a.bible ?? cur.bible ?? 0,
        gym: a.gym ?? cur.gym ?? 0,
      }));
      if (a.bible_today !== undefined || a.gym_today !== undefined) {
        const dk = new Date().toISOString().split('T')[0];
        const log = JSON.parse(localStorage.getItem('noa_habit_log') || '{}');
        log[dk] = { bible: a.bible_today ?? log[dk]?.bible ?? false, gym: a.gym_today ?? log[dk]?.gym ?? false };
        localStorage.setItem('noa_habit_log', JSON.stringify(log));
      }
    } else if (a.type === 'set_goal_progress') {
      localStorage.setItem('noa_semester_goals', JSON.stringify(a.goals));
    } else if (a.type === 'update_racing_checklist') {
      localStorage.setItem('noa_racing_checklist', JSON.stringify(a.items));
    }
  } catch (e) {}
}

async function sendMessage(text) {
  text = text?.trim();
  if (!text) return;
  openPanel();
  const input = document.getElementById('noa-input');
  if (input) input.value = '';
  appendMessage('user', text);
  chatHistory.push({ role: 'user', content: text });
  saveHistory();
  setLoading(true);
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory }),
    });
    const data = await res.json();
    const reply = data.reply || 'Something went wrong, try again.';
    chatHistory.push({ role: 'assistant', content: reply });
    saveHistory();
    appendMessage('assistant', reply);
    if (data.actions) handleAction(data.actions);
  } catch (e) {
    appendMessage('assistant', 'Connection error. Try again.');
  } finally {
    setLoading(false);
  }
}

// Restore history on load
chatHistory.forEach(m => appendMessage(m.role, m.content));

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('noa-toggle');
  const closeBtn = document.getElementById('noa-close');
  const overlay = document.getElementById('noa-overlay');
  const input = document.getElementById('noa-input');
  const sendBtn = document.getElementById('noa-send');

  if (toggle) toggle.addEventListener('click', openPanel);
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  if (overlay) overlay.addEventListener('click', closePanel);
  if (sendBtn) sendBtn.addEventListener('click', () => sendMessage(document.getElementById('noa-input')?.value));
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input.value); }
  });
});

// Global hook for quick-reply chips
window.noaSend = sendMessage;
