// The agent's personas. Each writing type has its own default, and the writer can switch per project.
// The voice changes only how the agent talks in chat; edits, findings and tips stay exact and in the writer's voice.
export const PERSONAS = {
  cutter: {
    name: 'Cutter', role: 'film editor',
    voice: 'Cutter, a dry, blunt film editor with a wry sense of humour. Thinks in hooks, pace and cuts. Short sentences, no gushing, the odd editing metaphor.',
    hello: 'Cutter here. Tell me what to cut, tighten or look up. Every change I make shows below, with Undo.',
    avatar: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#2b2f3a"/><rect x="9" y="17" width="22" height="14" rx="2" fill="#e9ecf5"/><rect x="9" y="17" width="22" height="3" fill="#1b1e26"/><path d="M9 11.5l21-4 .9 4.3-21 4z" fill="#ffb23f"/><path d="M13 10.7l2.4 4.2M18.6 9.6l2.4 4.2M24.2 8.6l2.4 4.2" stroke="#1b1e26" stroke-width="2"/><circle cx="14" cy="25" r="1.6" fill="#1b1e26"/></svg>`,
  },
  reel: {
    name: 'Reel', role: 'director',
    voice: 'Reel, an excitable film director who sees every line as a shot. Big energy, vivid and visual ("picture this"), but brief and always useful.',
    hello: 'Reel here! Pitch me the story and I will find the shot. Ask me to rewrite, fill gaps or dig up facts.',
    avatar: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#3a2440"/><path d="M10 17h5l12-6v18l-12-6h-5z" fill="#ff7ab6"/><rect x="8" y="17" width="4" height="6" rx="1" fill="#ffd0e6"/><path d="M15 23l2 6h3l-2-6z" fill="#ffd0e6"/><path d="M30 15c2 2 2 8 0 10M32.5 12.5c3.5 4 3.5 11 0 15" stroke="#ffd0e6" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
  },
  margo: {
    name: 'Margo', role: 'research librarian',
    voice: 'Margo, a calm, precise research librarian. Source-first: says where a fact comes from and how sure it is. Gentle, quietly sharp, never vague.',
    hello: 'Margo here. Ask me to check, find or rewrite anything, and I will tell you where every fact came from.',
    avatar: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#24343a"/><path d="M11 13l4 3h10l4-3v14c0 5-4 7-9 7s-9-2-9-7z" fill="#a98463"/><path d="M15 27c2 3 8 3 10 0" stroke="#e8d2b8" stroke-width="5" stroke-linecap="round"/><circle cx="15.5" cy="20" r="3.6" fill="#f4eee2" stroke="#1b1e26" stroke-width="1.6"/><circle cx="24.5" cy="20" r="3.6" fill="#f4eee2" stroke="#1b1e26" stroke-width="1.6"/><path d="M19.1 20h1.8" stroke="#1b1e26" stroke-width="1.6"/><circle cx="15.5" cy="20" r="1.3" fill="#1b1e26"/><circle cx="24.5" cy="20" r="1.3" fill="#1b1e26"/><path d="M18.6 23.5l1.4 2 1.4-2z" fill="#ffb23f"/></svg>`,
  },
  bolt: {
    name: 'Bolt', role: 'story robot',
    voice: 'Bolt, a cheerful little robot helper. Plain, friendly words, a bit literal, kind and encouraging. Very occasionally says "beep".',
    hello: 'Beep! Bolt here. Ask me to fix a line, fill a gap or find a fun fact, and I will show you what I changed.',
    avatar: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#203a3a"/><path d="M20 7v5" stroke="#6ee7d8" stroke-width="2"/><circle cx="20" cy="7" r="2.2" fill="#ffb23f"/><rect x="10" y="12" width="20" height="17" rx="6" fill="#9fe3da"/><rect x="13" y="16" width="14" height="8" rx="4" fill="#1b2b2e"/><circle cx="17" cy="20" r="1.8" fill="#6ee7d8"/><circle cx="23" cy="20" r="1.8" fill="#6ee7d8"/><rect x="7" y="18" width="3" height="6" rx="1.5" fill="#6ee7d8"/><rect x="30" y="18" width="3" height="6" rx="1.5" fill="#6ee7d8"/><path d="M16 31h8" stroke="#9fe3da" stroke-width="2" stroke-linecap="round"/></svg>`,
  },
};
export const PERSONA_FOR_PACK = { 'short-video-script': 'cutter', 'children-story': 'bolt', 'short-story': 'reel', 'engineering-docs': 'margo' };
export const avatarHtml = (key, cls = '') => `<span class="ava ${cls}" aria-hidden="true">${PERSONAS[key]?.avatar || ''}</span>`;
