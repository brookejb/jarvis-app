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
    if (a.type === 'snooze_priority') {
      // Remove matched item from priorities and store with restore time
      const priorities = JSON.parse(localStorage.getItem('noa_priorities') || '[]');
      const snoozed = JSON.parse(localStorage.getItem('noa_snoozed_priorities') || '[]');
      const match = priorities.find(p => p.label.toLowerCase().includes((a.label || '').toLowerCase()));
      if (match) {
        const remaining = priorities.filter(p => p !== match);
        localStorage.setItem('noa_priorities', JSON.stringify(remaining));
        snoozed.push({ item: match, restoreAt: a.restoreAt });
        localStorage.setItem('noa_snoozed_priorities', JSON.stringify(snoozed));
        if (typeof renderPriorities === 'function') renderPriorities();
      }
    } else if (a.type === 'set_priorities') {
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
        // Always trust the date Noa specifies — she figures out the right date from context
        const dk = a.date || new Date().toLocaleDateString('en-CA');
        const log = JSON.parse(localStorage.getItem('noa_habit_log') || '{}');
        log[dk] = {
          bible: a.bible_today !== undefined ? a.bible_today : (log[dk]?.bible ?? false),
          gym:   a.gym_today   !== undefined ? a.gym_today   : (log[dk]?.gym   ?? false),
        };
        localStorage.setItem('noa_habit_log', JSON.stringify(log));
      }
    } else if (a.type === 'set_goal_progress') {
      localStorage.setItem('noa_semester_goals', JSON.stringify(a.goals));
    } else if (a.type === 'update_racing_checklist') {
      localStorage.setItem('noa_racing_checklist', JSON.stringify(a.items));
    } else if (a.type === 'set_recurring_schedule' && a.schedule) {
      const existing = JSON.parse(localStorage.getItem('noa_recurring_schedule') || '{}');
      const merged = { ...existing };
      for (const [day, items] of Object.entries(a.schedule)) {
        if (Array.isArray(items)) merged[day.toLowerCase()] = items;
      }
      localStorage.setItem('noa_recurring_schedule', JSON.stringify(merged));
    }
    // start_deep_work is handled by the page via window.onNoaAction below
  } catch (e) {}
  // Notify page-level handlers (UI re-renders, deep work trigger, etc.)
  try { if (typeof window.onNoaAction === 'function') window.onNoaAction(a); } catch(e) {}
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
    // Send client's local date and time so Noa can do accurate time math
    const clientDate = new Date().toLocaleDateString('en-CA');
    const clientTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const mode = (typeof window.getCurrentMode === 'function') ? window.getCurrentMode() : 'student';

    // Send everything Noa needs to see the full picture
    const priorities = JSON.parse(localStorage.getItem('noa_priorities') || '[]');
    const habitLog = JSON.parse(localStorage.getItem('noa_habit_log') || '{}');
    const energy = localStorage.getItem(`noa_energy_${clientDate}`) || null;
    const deepWorkLog = JSON.parse(localStorage.getItem('noa_deep_work_log') || '[]');
    const racingChecklist = JSON.parse(localStorage.getItem('noa_racing_checklist') || '[]');
    const semesterGoals = JSON.parse(localStorage.getItem('noa_semester_goals') || '[]');

    // Send 3 weeks of habit history so Noa can detect patterns, not just this week
    const weekHabits = {};
    const habitStart = new Date();
    habitStart.setDate(habitStart.getDate() - 20); // 3 weeks back
    for (let i = 0; i <= 20; i++) {
      const d = new Date(habitStart);
      d.setDate(habitStart.getDate() + i);
      const k = d.toLocaleDateString('en-CA');
      if (habitLog[k]) weekHabits[k] = habitLog[k];
    }

    // Today's deep work sessions
    const todayDW = deepWorkLog.filter(s => s.date === clientDate);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: chatHistory, clientDate, clientTime, mode,
        priorities, weekHabits, energy, todayDW, racingChecklist, semesterGoals,
      }),
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
