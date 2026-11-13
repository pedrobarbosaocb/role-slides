// Rolê de Slides — inscrição nos horários de apresentação.
// Backend: Supabase (RPCs no schema privado "rs", ver supabase/migrations) quando
// config.js traz URL e chave; senão, modo local (localStorage, só neste navegador).
import { LANGS, detectLang, setLang, getLang, t } from './i18n.js';

// =========================================================================
// 1. CONFIGURAÇÃO DO EVENTO, BLOCOS E SLOTS
// =========================================================================
const EVENT_START = new Date('2026-11-14T12:00:00-03:00'); // sábado, 14/11, 12h (Brasília)

const swap = (a, b) => ({ key: 'note_swap', vars: { a, b } });
const BLOCKS_CONFIG = [
    {
        id: 'block_1', n: 1, from: 14, to: 16, capacity: 5, icon: 'sun',
        slots: [
            { start: '14:00', end: '14:20', note: swap(15, 5) },
            { start: '14:20', end: '14:40', note: swap(15, 5) },
            { start: '14:40', end: '15:00', note: swap(15, 5) },
            { start: '15:00', end: '15:20', note: swap(15, 5) },
            { start: '15:20', end: '15:45', note: { key: 'note_close_block' } }
        ]
    },
    {
        id: 'block_2', n: 2, from: 16, to: 18, capacity: 5, icon: 'sunset',
        slots: [
            { start: '16:00', end: '16:20', note: swap(15, 5) },
            { start: '16:20', end: '16:40', note: swap(15, 5) },
            { start: '16:40', end: '17:00', note: swap(15, 5) },
            { start: '17:00', end: '17:20', note: swap(15, 5) },
            { start: '17:20', end: '17:45', note: { key: 'note_dinner' } }
        ]
    },
    {
        id: 'block_3', n: 3, from: 20, to: 22, capacity: 6, icon: 'moon',
        slots: [
            { start: '20:00', end: '20:18', note: swap(14, 4) },
            { start: '20:18', end: '20:36', note: swap(14, 4) },
            { start: '20:36', end: '20:54', note: swap(14, 4) },
            { start: '20:54', end: '21:12', note: swap(14, 4) },
            { start: '21:12', end: '21:30', note: swap(14, 4) },
            { start: '21:30', end: '21:50', note: { key: 'note_close' } }
        ]
    }
];

const TOTAL_CAPACITY = BLOCKS_CONFIG.reduce((s, b) => s + b.capacity, 0);
const rangeOf = b => t('range', { a: b.from, b: b.to });
const shortOf = b => t(`block_${b.n}`);
const titleOf = b => `${t('block', { n: b.n })} • ${shortOf(b)}`;

// =========================================================================
// 2. ESTADO E PERSISTÊNCIA
// =========================================================================
let registrations = [];
let organizerMode = false;
let organizerPin = null;
let backend = null;
let busy = false;
let editingId = null; // inscrição própria sendo editada no formulário
let statusKey = 'status_connecting';
let statusOk = false;

const LOCAL_DATA_KEY = 'role_slides_local_v1';
const MY_KEYS = 'role_slides_my_regs_v1';
const PIN_KEY = 'role_slides_pin_v1';

const store = {
    get(k, storage = localStorage) {
        try { return JSON.parse(storage.getItem(k)); } catch { return null; }
    },
    set(k, v, storage = localStorage) {
        try { storage.setItem(k, JSON.stringify(v)); } catch { /* sem storage: segue sem lembrar */ }
    },
    del(k, storage = localStorage) {
        try { storage.removeItem(k); } catch { /* idem */ }
    }
};

const myRegs = () => store.get(MY_KEYS) || {};
function rememberMine(id, key) { const m = myRegs(); m[id] = key; store.set(MY_KEYS, m); }
function forgetMine(id) { const m = myRegs(); delete m[id]; store.set(MY_KEYS, m); }

function randomKey() {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

class RpcError extends Error {
    constructor(code) { super(code); this.code = code; }
}
const errorText = err => (err?.code ? t(`err_${err.code}`) : t('err_generic'));

// ---- Supabase
async function createSupabaseBackend(url, anonKey) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

    async function rpc(fn, args) {
        const { data, error } = await sb.rpc(fn, args);
        if (error) throw new Error(error.message || 'rpc');
        if (data && typeof data === 'object' && 'error' in data) throw new RpcError(data.error);
        return data;
    }

    return {
        live: true,
        needsPin: true,
        async list() {
            const data = await rpc('rs_list');
            return data.registrations || [];
        },
        async register(d) {
            const key = randomKey();
            const res = await rpc('rs_register', {
                p_name: d.name, p_block: d.blockId, p_topic_mode: d.topicMode,
                p_topic_title: d.topicTitle, p_tech: d.tech, p_key: key
            });
            rememberMine(res.id, key);
        },
        async cancel(id) {
            await rpc('rs_cancel', { p_id: id, p_key: myRegs()[id] || '' });
            forgetMine(id);
        },
        update: (id, d) => rpc('rs_update', {
            p_id: id, p_key: myRegs()[id] || '', p_name: d.name, p_block: d.blockId,
            p_topic_mode: d.topicMode, p_topic_title: d.topicTitle, p_tech: d.tech
        }),
        checkPin: pin => rpc('rs_check_pin', { p_pin: pin }),
        remove: (pin, id) => rpc('rs_remove', { p_pin: pin, p_id: id }),
        move: (pin, id, dir) => rpc('rs_move', { p_pin: pin, p_id: id, p_dir: dir }),
        reset: pin => rpc('rs_reset', { p_pin: pin }),
        subscribe(onChange, onStatus) {
            sb.channel('role-slides')
                .on('broadcast', { event: 'change' }, () => onChange())
                .subscribe(status => onStatus(status === 'SUBSCRIBED'));
        }
    };
}

// ---- Local (sem Supabase configurado): dados só neste navegador
function createLocalBackend() {
    const load = () => store.get(LOCAL_DATA_KEY) || [];
    const save = list => store.set(LOCAL_DATA_KEY, list);
    const sorted = list => list.slice().sort((a, b) => {
        const ba = BLOCKS_CONFIG.findIndex(x => x.id === a.blockId);
        const bb = BLOCKS_CONFIG.findIndex(x => x.id === b.blockId);
        return ba - bb || a.orderIndex - b.orderIndex || a.createdAt - b.createdAt;
    });
    const renumber = (list, blockId) => sorted(list).filter(r => r.blockId === blockId).forEach((r, i) => { r.orderIndex = i; });

    return {
        live: false,
        needsPin: false,
        async list() { return sorted(load()); },
        async register(d) {
            const list = load();
            const block = BLOCKS_CONFIG.find(b => b.id === d.blockId);
            const inBlock = list.filter(r => r.blockId === d.blockId);
            if (!block) throw new RpcError('bad_block');
            if (inBlock.length >= block.capacity) throw new RpcError('full');
            const id = 'local' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            list.push({
                id, blockId: d.blockId, name: d.name, topicMode: d.topicMode,
                topicTitle: d.topicMode === 'defined' ? d.topicTitle : '', tech: d.tech,
                orderIndex: inBlock.reduce((m, r) => Math.max(m, r.orderIndex), -1) + 1,
                createdAt: Date.now()
            });
            save(list);
            rememberMine(id, 'local');
        },
        async cancel(id) { await this.remove(null, id); forgetMine(id); },
        async update(id, d) {
            const list = load();
            const r = list.find(x => x.id === id);
            if (!r || !myRegs()[id]) throw new RpcError('forbidden');
            if (d.blockId !== r.blockId) {
                const block = BLOCKS_CONFIG.find(b => b.id === d.blockId);
                const inBlock = list.filter(x => x.blockId === d.blockId);
                if (!block) throw new RpcError('bad_block');
                if (inBlock.length >= block.capacity) throw new RpcError('full');
                const oldBlock = r.blockId;
                r.blockId = d.blockId;
                r.orderIndex = inBlock.reduce((m, x) => Math.max(m, x.orderIndex), -1) + 1;
                renumber(list, oldBlock);
            }
            Object.assign(r, { name: d.name, topicMode: d.topicMode, topicTitle: d.topicMode === 'defined' ? d.topicTitle : '', tech: d.tech });
            save(list);
        },
        async checkPin() { return { ok: true }; },
        async remove(_pin, id) {
            const list = load();
            const r = list.find(x => x.id === id);
            const rest = list.filter(x => x.id !== id);
            if (r) renumber(rest, r.blockId);
            save(rest);
        },
        async move(_pin, id, dir) {
            const list = load();
            const r = list.find(x => x.id === id);
            if (!r) return;
            renumber(list, r.blockId);
            const other = list.find(x => x.blockId === r.blockId && x.orderIndex === r.orderIndex + dir);
            if (other) { other.orderIndex = r.orderIndex; r.orderIndex += dir; }
            save(list);
        },
        async reset() { save([]); },
        subscribe(onChange, onStatus) {
            window.addEventListener('storage', e => { if (e.key === LOCAL_DATA_KEY) onChange(); });
            onStatus(true);
        }
    };
}

let refreshing = null;
let refreshAgain = false;
async function refresh() {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
        do {
            refreshAgain = false;
            try {
                registrations = await backend.list();
                if (editingId && !registrations.some(r => r.id === editingId)) stopEdit(false);
                renderAll();
            } catch (err) {
                console.error(err);
                showToast(t('err_connection'), 'error');
            }
        } while (refreshAgain);
    })();
    try { await refreshing; } finally { refreshing = null; }
}

function setStatus(key, ok) {
    statusKey = key;
    statusOk = ok;
    renderStatus();
}

function renderStatus() {
    document.getElementById('connection-status').textContent = t(statusKey);
    const color = statusOk ? 'emerald' : 'amber';
    document.getElementById('status-ping').className = `animate-ping absolute inline-flex h-full w-full rounded-full bg-${color}-400 opacity-75`;
    document.getElementById('status-dot').className = `relative inline-flex rounded-full h-2 w-2 bg-${color}-500`;
}

async function initStorage() {
    const cfg = window.ROLE_CONFIG || {};
    if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
        try {
            backend = await createSupabaseBackend(cfg.supabaseUrl, cfg.supabaseAnonKey);
        } catch (err) {
            console.error('Falha ao carregar o Supabase:', err);
            setStatus('status_offline', false);
            showToast(t('err_cannot_connect'), 'error');
            return;
        }
    } else {
        backend = createLocalBackend();
    }

    const savedPin = store.get(PIN_KEY, sessionStorage);
    if (savedPin) organizerPin = savedPin;

    await refresh();
    backend.subscribe(
        () => refresh(),
        ok => {
            if (!backend.live) return setStatus('status_local', false);
            setStatus(ok ? 'status_live' : 'status_reconnecting', ok);
            if (ok) refresh();
        }
    );
    if (backend.live) {
        // rede de segurança caso o tempo real caia
        setInterval(() => { if (!document.hidden) refresh(); }, 30000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    }
}

// =========================================================================
// 3. COUNTDOWN
// =========================================================================
function tickCountdown() {
    const diff = EVENT_START.getTime() - Date.now();
    if (diff <= 0) {
        document.getElementById('countdown-clock').classList.add('hidden');
        document.getElementById('countdown-live').classList.remove('hidden');
        const label = document.getElementById('countdown-label');
        label.dataset.i18n = 'cd_label_today';
        label.textContent = t('cd_label_today');
        return false;
    }
    const s = Math.floor(diff / 1000);
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('cd-days').textContent = Math.floor(s / 86400);
    document.getElementById('cd-hours').textContent = pad(Math.floor((s % 86400) / 3600));
    document.getElementById('cd-mins').textContent = pad(Math.floor((s % 3600) / 60));
    document.getElementById('cd-secs').textContent = pad(s % 60);
    return true;
}

function startCountdown() {
    if (!tickCountdown()) return;
    const id = setInterval(() => { if (!tickCountdown()) clearInterval(id); }, 1000);
}

// =========================================================================
// 4. RENDERIZAÇÃO
// =========================================================================
const icons = () => window.lucide && lucide.createIcons();
const icon = (name, cls = 'w-4 h-4') => `<i data-lucide="${name}" class="${cls}"></i>`;
const blockRegs = blockId => registrations
    .filter(r => r.blockId === blockId)
    .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt);

function renderAll() {
    renderCounters();
    renderFormBlocks();
    renderSidebarAvailability();
    renderSchedule();
    icons();
}

function renderCounters() {
    const occupied = registrations.length;
    const remaining = Math.max(0, TOTAL_CAPACITY - occupied);

    const countEl = document.getElementById('total-remaining-count');
    countEl.textContent = remaining;
    countEl.className = 'text-2xl font-extrabold ' + (remaining === 0 ? 'text-purple-700' : remaining <= 4 ? 'text-amber-700' : 'text-emerald-700');
    document.getElementById('total-capacity').textContent = TOTAL_CAPACITY;
    document.getElementById('badge-registered-count').textContent = `${occupied}/${TOTAL_CAPACITY}`;

    if (busy) return;
    const submitBtn = document.getElementById('submit-btn');
    if (editingId) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `${icon('save', 'w-5 h-5')}<span>${t('submit_save')}</span>`;
        return;
    }
    submitBtn.disabled = remaining === 0;
    submitBtn.innerHTML = remaining === 0
        ? `${icon('lock', 'w-5 h-5')}<span>${t('submit_full', { n: TOTAL_CAPACITY })}</span>`
        : `${icon('check-circle-2', 'w-5 h-5')}<span>${t('submit')}</span>`;
}

function renderFormBlocks() {
    const container = document.getElementById('blocks-radio-container');
    const previouslySelected = document.querySelector('input[name="blockId"]:checked')?.value;

    const editing = registrations.find(r => r.id === editingId);
    container.innerHTML = BLOCKS_CONFIG.map(block => {
        const count = blockRegs(block.id).length;
        const left = Math.max(0, block.capacity - count);
        // quem está editando sempre pode manter o próprio bloco, mesmo lotado
        const isFull = left === 0 && editing?.blockId !== block.id;
        const isChecked = !isFull && previouslySelected === block.id;

        const badgeHtml = left === 0
            ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-purple-500/20 text-purple-700 border border-purple-500/30">${icon('lock', 'w-3 h-3')}${t('badge_full')}</span>`
            : left === 1
                ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/20 text-amber-700 border border-amber-500/30">${icon('flame', 'w-3 h-3')}${t('badge_last')}</span>`
                : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-700 border border-emerald-500/30">${icon('armchair', 'w-3 h-3')}<span dir="ltr">${left}</span></span>`;

        return `
            <label class="block ${isFull ? 'cursor-not-allowed' : 'cursor-pointer'}" title="${escapeHtml(titleOf(block))}">
                <input type="radio" name="blockId" value="${block.id}" class="sr-only radio-card" ${isFull ? 'disabled' : ''} ${isChecked ? 'checked' : ''}>
                <div class="h-full p-4 rounded-lg border border-slate-200 bg-white hover:border-indigo-300 transition flex flex-col justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <span class="text-indigo-600 shrink-0">${icon(block.icon, 'w-6 h-6')}</span>
                        <div>
                            <div class="text-lg font-extrabold text-slate-900 leading-tight" dir="ltr">${rangeOf(block)}</div>
                            <div class="text-xs text-slate-600">${escapeHtml(shortOf(block))}</div>
                        </div>
                    </div>
                    <div class="flex items-center justify-between pt-3 border-t border-slate-100">
                        ${badgeHtml}
                        <span class="text-xs text-slate-600 font-medium" dir="ltr">${count}/${block.capacity}</span>
                    </div>
                </div>
            </label>`;
    }).join('');
}

function renderSidebarAvailability() {
    document.getElementById('sidebar-availability-list').innerHTML = BLOCKS_CONFIG.map(block => {
        const count = blockRegs(block.id).length;
        const left = Math.max(0, block.capacity - count);
        const percent = Math.min(100, Math.round((count / block.capacity) * 100));
        const barColor = left === 0 ? 'bg-purple-500' : left <= 2 ? 'bg-amber-500' : 'bg-emerald-500';
        const textColor = left === 0 ? 'text-purple-700' : 'text-emerald-700';
        return `
            <div>
                <div class="flex justify-between items-center text-xs mb-1.5">
                    <span class="inline-flex items-center gap-1.5 font-semibold text-slate-900">${icon(block.icon, 'w-3.5 h-3.5 text-indigo-700')}<span dir="ltr">${rangeOf(block)}</span></span>
                    <span class="inline-flex items-center gap-1 font-bold ${textColor}">${left === 0 ? icon('lock', 'w-3.5 h-3.5') : icon('armchair', 'w-3.5 h-3.5')}<span dir="ltr">${left}/${block.capacity}</span></span>
                </div>
                <div class="xp-track w-full h-3 rounded-sm overflow-hidden">
                    <div class="xp-bar h-full ${barColor} transition-all duration-500" style="width: ${percent}%"></div>
                </div>
            </div>`;
    }).join('');
}

function topicHtml(person) {
    if (person.topicMode === 'defined') {
        return `<span class="text-sm font-medium text-slate-800 break-words">"${escapeHtml(person.topicTitle)}"</span>`;
    }
    if (person.topicMode === 'secret') {
        return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-purple-500/15 text-purple-700 border border-purple-500/30">${icon('venetian-mask', 'w-3.5 h-3.5')}${t('topic_secret')}</span>`;
    }
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-700 border border-amber-500/30">${icon('hourglass', 'w-3.5 h-3.5')}${t('topic_tbd')}</span>`;
}

const TECH = {
    own_laptop: { icon: 'laptop', color: 'text-emerald-700', label: 'tech_laptop' },
    send_file: { icon: 'file-up', color: 'text-sky-700', label: 'tech_file' },
    audio_out: { icon: 'volume-2', color: 'text-amber-700', label: 'tech_audio' }
};

function techHtml(tech) {
    const items = (tech || []).filter(k => TECH[k]);
    if (!items.length) return '<span class="text-xs text-slate-500">—</span>';
    return items.map(k => {
        const label = escapeHtml(t(TECH[k].label));
        return `<span title="${label}" aria-label="${label}" class="inline-flex items-center justify-center w-8 h-8 rounded-md bg-slate-50 ${TECH[k].color} border border-slate-200">${icon(TECH[k].icon, 'w-3.5 h-3.5')}</span>`;
    }).join('');
}

const th = (ic, key, extra = '') =>
    `<th class="py-2.5 px-4 ${extra}" title="${escapeHtml(t(key))}"><span class="inline-flex items-center gap-1.5">${icon(ic, 'w-3.5 h-3.5')}<span class="sr-only">${escapeHtml(t(key))}</span></span></th>`;

function renderSchedule() {
    const mine = myRegs();
    document.getElementById('schedule-blocks-container').innerHTML = BLOCKS_CONFIG.map((block, bIdx) => {
        const regs = blockRegs(block.id);
        const left = Math.max(0, block.capacity - regs.length);

        const rowsHtml = block.slots.map((slot, slotIdx) => {
            const person = regs[slotIdx];
            const note = escapeHtml(t(slot.note.key, slot.note.vars));

            if (!person) {
                return `
                    <tr class="border-b border-slate-100 last:border-none hover:bg-slate-50 transition">
                        <td class="py-3 px-4 whitespace-nowrap" title="${note}">
                            <div class="font-mono text-xs sm:text-sm font-bold text-slate-500" dir="ltr">${slot.start} - ${slot.end}</div>
                        </td>
                        <td class="py-3 px-4" colspan="${organizerMode ? 4 : 3}">
                            <div class="flex items-center justify-between gap-2">
                                <span class="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700/90 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full whitespace-nowrap">
                                    ${icon('armchair', 'w-3.5 h-3.5')}${escapeHtml(t('slot_free', { n: slotIdx + 1 }))}
                                </span>
                                <button data-action="quick-select" data-block="${block.id}" title="${escapeHtml(t('reserve_slot'))}" aria-label="${escapeHtml(t('reserve_slot'))}" class="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-700 border border-indigo-500/30 transition">
                                    ${icon('plus', 'w-4 h-4')}
                                </button>
                            </div>
                        </td>
                    </tr>`;
            }

            const isMine = Boolean(mine[person.id]);
            const id = escapeHtml(person.id);

            const organizerControls = organizerMode ? `
                <td class="py-3 px-4 text-end whitespace-nowrap">
                    <div class="inline-flex items-center gap-1">
                        <button data-action="move" data-id="${id}" data-dir="-1" ${slotIdx === 0 ? 'disabled' : ''} title="${escapeHtml(t('move_up'))}" aria-label="${escapeHtml(t('move_up'))}" class="p-1.5 rounded-lg bg-white hover:bg-blue-50 text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition">${icon('arrow-up', 'w-3.5 h-3.5')}</button>
                        <button data-action="move" data-id="${id}" data-dir="1" ${slotIdx === regs.length - 1 ? 'disabled' : ''} title="${escapeHtml(t('move_down'))}" aria-label="${escapeHtml(t('move_down'))}" class="p-1.5 rounded-lg bg-white hover:bg-blue-50 text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition">${icon('arrow-down', 'w-3.5 h-3.5')}</button>
                        <button data-action="remove" data-id="${id}" title="${escapeHtml(t('remove_title'))}" aria-label="${escapeHtml(t('remove_title'))}" class="p-1.5 rounded-lg bg-purple-500/15 hover:bg-purple-500/30 text-purple-700 border border-purple-500/30 ms-1 transition">${icon('trash-2', 'w-3.5 h-3.5')}</button>
                    </div>
                </td>` : '';

            const mineHtml = isMine ? `
                <span class="inline-flex items-center gap-1 text-xs text-emerald-700 font-semibold">
                    ${icon('badge-check', 'w-3.5 h-3.5')}${escapeHtml(t('you'))}
                    <button data-action="edit" data-id="${id}" title="${escapeHtml(t('edit_btn'))}" aria-label="${escapeHtml(t('edit_btn'))}" class="ms-1 inline-flex items-center justify-center w-6 h-6 rounded-md bg-indigo-500/20 hover:bg-indigo-500/40 text-indigo-700 border border-indigo-500/40">${icon('pencil', 'w-3.5 h-3.5')}</button>
                    <button data-action="cancel" data-id="${id}" title="${escapeHtml(t('modal_cancel_title'))}" aria-label="${escapeHtml(t('modal_cancel_title'))}" class="inline-flex items-center justify-center w-6 h-6 rounded-md bg-purple-500/15 hover:bg-purple-500/30 text-purple-700 border border-purple-500/30">${icon('x', 'w-3.5 h-3.5')}</button>
                </span>` : '';

            return `
                <tr class="border-b border-slate-100 last:border-none ${isMine ? 'bg-emerald-50' : ''} hover:bg-slate-50 transition">
                    <td class="py-3 px-4 whitespace-nowrap" title="${note}">
                        <div class="font-mono text-xs sm:text-sm font-bold text-indigo-700" dir="ltr">${slot.start} - ${slot.end}</div>
                        <div class="text-xs text-slate-600">#${slotIdx + 1}</div>
                    </td>
                    <td class="py-3 px-4 whitespace-nowrap">
                        <div class="flex items-center gap-2.5">
                            <div class="xp-avatar w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0">
                                ${escapeHtml(Array.from(person.name)[0]?.toUpperCase() || '?')}
                            </div>
                            <div class="flex flex-col">
                                <bdi class="font-bold text-slate-900 text-sm">${escapeHtml(person.name)}</bdi>
                                ${mineHtml}
                            </div>
                        </div>
                    </td>
                    <td class="py-3 px-4"><bdi>${topicHtml(person)}</bdi></td>
                    <td class="py-3 px-4"><div class="flex flex-wrap gap-1.5">${techHtml(person.tech)}</div></td>
                    ${organizerControls}
                </tr>`;
        }).join('');

        const dinnerBreakHtml = bIdx === 1 ? `
            <div class="rounded-lg px-4 py-3 bg-white/85 flex items-center justify-center gap-3 text-slate-800 text-sm">
                ${icon('utensils', 'w-5 h-5 text-amber-700 shrink-0')}
                <span>${t('dinner_html')}</span>
            </div>` : '';

        return `
            <div class="glass-card rounded-lg overflow-hidden">
                <div class="titlebar px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                    <div class="flex items-center gap-3">
                        <span class="text-indigo-600 shrink-0">${icon(block.icon, 'w-6 h-6')}</span>
                        <div>
                            <span class="text-xs font-semibold uppercase tracking-wider text-indigo-700">${escapeHtml(titleOf(block))}</span>
                            <h3 class="text-lg font-extrabold text-slate-900" dir="ltr">${rangeOf(block)}</h3>
                        </div>
                    </div>
                    <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${left === 0 ? 'bg-purple-500/20 text-purple-700 border border-purple-500/30' : 'bg-emerald-500/15 text-emerald-700 border border-emerald-500/30'}">
                        ${left === 0 ? icon('lock', 'w-3.5 h-3.5') : icon('armchair', 'w-3.5 h-3.5')}
                        <span dir="ltr">${left}/${block.capacity}</span>
                    </span>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-start border-collapse">
                        <thead>
                            <tr class="border-b border-slate-200 text-xs font-semibold uppercase tracking-wider text-slate-600 text-start">
                                ${th('clock', 'th_time')}${th('user-round', 'th_presenter')}${th('lightbulb', 'th_topic')}${th('wrench', 'th_setup')}
                                ${organizerMode ? th('shield', 'th_organize', 'text-end') : ''}
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            </div>
            ${dinnerBreakHtml}`;
    }).join('');
}

// =========================================================================
// 5. AÇÕES
// =========================================================================
async function run(action, successKey, vars) {
    try {
        await action();
        if (successKey) showToast(t(successKey, vars), 'info');
    } catch (err) {
        console.error(err);
        if (err.code === 'bad_pin' || err.code === 'no_pin') leaveOrganizerMode();
        showToast(errorText(err), 'error');
    }
    await refresh();
}

document.getElementById('presentation-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !backend) return;

    const name = document.getElementById('presenter-name').value.trim();
    const blockRadio = document.querySelector('input[name="blockId"]:checked');
    const topicMode = document.querySelector('input[name="topicMode"]:checked')?.value || 'defined';
    const topicTitle = document.getElementById('topic-title').value.trim();
    const tech = Array.from(document.querySelectorAll('input[name="tech"]:checked')).map(cb => cb.value);

    if (!name) {
        showToast(t('toast_name_required'), 'error');
        document.getElementById('presenter-name').focus();
        return;
    }
    if (!blockRadio) {
        showToast(t('toast_block_required'), 'error');
        return;
    }
    if (topicMode === 'defined' && !topicTitle) {
        showToast(t('toast_topic_required'), 'error');
        document.getElementById('topic-title').focus();
        return;
    }

    busy = true;
    const btn = document.getElementById('submit-btn');
    btn.disabled = true;
    btn.innerHTML = `${icon('loader-2', 'w-5 h-5 animate-spin')}<span>${t('submit_busy')}</span>`;
    icons();

    try {
        const data = { name, blockId: blockRadio.value, topicMode, topicTitle, tech };
        if (editingId) {
            await backend.update(editingId, data);
            stopEdit(false);
            showToast(t('toast_updated'), 'success');
        } else {
            await backend.register(data);
            clearForm();
            showToast(t('toast_success', { name }), 'success');
        }
        switchTab('schedule');
    } catch (err) {
        console.error(err);
        showToast(err.code ? errorText(err) : t('toast_reserve_fail'), 'error');
    } finally {
        busy = false;
        await refresh();
    }
});

function handleTopicModeChange() {
    const mode = document.querySelector('input[name="topicMode"]:checked')?.value;
    document.getElementById('topic-input-wrapper').classList.toggle('hidden', mode !== 'defined');
}
document.querySelectorAll('input[name="topicMode"]').forEach(r => r.addEventListener('change', handleTopicModeChange));

function clearForm() {
    document.getElementById('presenter-name').value = '';
    document.getElementById('topic-title').value = '';
    document.querySelectorAll('input[name="tech"]').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('input[name="blockId"]').forEach(r => { r.checked = false; });
    document.querySelector('input[name="topicMode"][value="defined"]').checked = true;
    handleTopicModeChange();
}

// Edição: só aparece para inscrições deste navegador; o banco confere a chave de novo
function startEdit(id) {
    const r = registrations.find(x => x.id === id);
    if (!r || !myRegs()[id]) return;
    editingId = id;
    renderAll(); // libera o próprio bloco mesmo se estiver lotado
    document.getElementById('presenter-name').value = r.name;
    document.getElementById('topic-title').value = r.topicMode === 'defined' ? r.topicTitle : '';
    const block = document.querySelector(`input[name="blockId"][value="${r.blockId}"]`);
    if (block) block.checked = true;
    const mode = document.querySelector(`input[name="topicMode"][value="${r.topicMode}"]`);
    if (mode) mode.checked = true;
    handleTopicModeChange();
    document.querySelectorAll('input[name="tech"]').forEach(cb => { cb.checked = (r.tech || []).includes(cb.value); });
    document.getElementById('edit-banner').classList.remove('hidden');
    switchTab('form');
    document.getElementById('presenter-name').focus();
}

function stopEdit(rerender = true) {
    editingId = null;
    document.getElementById('edit-banner').classList.add('hidden');
    clearForm();
    if (rerender) renderAll();
}
document.getElementById('edit-discard-btn').addEventListener('click', () => stopEdit());

const TAB_ON = 'xp-tab xp-tab-on flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2 text-sm font-bold';
const TAB_OFF = 'xp-tab flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold';

function switchTab(tab) {
    const isForm = tab === 'form';
    document.getElementById('view-form').classList.toggle('hidden', !isForm);
    document.getElementById('view-schedule').classList.toggle('hidden', isForm);
    document.getElementById('tab-form-btn').className = isForm ? TAB_ON : TAB_OFF;
    document.getElementById('tab-schedule-btn').className = isForm ? TAB_OFF : TAB_ON;
}
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function quickSelectBlock(blockId) {
    switchTab('form');
    const radio = document.querySelector(`input[name="blockId"][value="${blockId}"]`);
    if (radio && !radio.disabled) radio.checked = true;
    document.getElementById('presenter-name').focus();
}

function renderOrganizerButton() {
    const btn = document.getElementById('organizer-toggle-btn');
    const key = organizerMode ? 'org_on' : 'org_off';
    btn.dataset.i18nTitle = key;
    btn.dataset.i18nAria = key;
    btn.title = t(key);
    btn.setAttribute('aria-label', t(key));
    btn.setAttribute('aria-pressed', String(organizerMode));
    btn.className = `inline-flex items-center justify-center w-9 h-9 rounded-md transition ${organizerMode
        ? 'xp-btn'
        : 'glass-card text-indigo-700 hover:text-slate-900'}`;
    document.getElementById('organizer-banner').classList.toggle('hidden', !organizerMode);
}

function setOrganizer(on) {
    organizerMode = on;
    renderOrganizerButton();
    if (on) switchTab('schedule');
    renderSchedule();
    icons();
}

function leaveOrganizerMode() {
    organizerPin = null;
    store.del(PIN_KEY, sessionStorage);
    setOrganizer(false);
}

document.getElementById('organizer-toggle-btn').addEventListener('click', () => {
    if (organizerMode) return setOrganizer(false);
    if (!backend) return;
    if (!backend.needsPin || organizerPin) {
        setOrganizer(true);
        showToast(t('toast_org_on'), 'info');
        return;
    }
    openModal({
        title: t('modal_org_title'),
        message: t('modal_org_msg'),
        okLabel: t('modal_org_ok'),
        okClass: 'xp-btn-green',
        withInput: true,
        onConfirm: async (pin) => {
            try {
                await backend.checkPin(pin);
                organizerPin = pin;
                store.set(PIN_KEY, pin, sessionStorage);
                setOrganizer(true);
                showToast(t('toast_org_on'), 'info');
            } catch (err) {
                showToast(err.code ? errorText(err) : t('toast_pin_fail'), 'error');
            }
        }
    });
});

document.getElementById('reset-all-btn').addEventListener('click', () => {
    openModal({
        title: t('modal_reset_title'),
        message: t('modal_reset_msg', { n: TOTAL_CAPACITY }),
        onConfirm: () => run(() => backend.reset(organizerPin), 'toast_reset', { n: TOTAL_CAPACITY })
    });
});

// Delegação de cliques no cronograma (sem onclick inline: nomes nunca viram código)
document.getElementById('schedule-blocks-container').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const { action, id, block, dir } = btn.dataset;
    const person = registrations.find(r => r.id === id);

    if (action === 'quick-select') return quickSelectBlock(block);
    if (action === 'move') {
        btn.disabled = true;
        return run(() => backend.move(organizerPin, id, Number(dir)));
    }
    if (action === 'remove' && person) {
        return openModal({
            title: t('modal_remove_title'),
            message: t('modal_remove_msg', { name: person.name }),
            onConfirm: () => run(() => backend.remove(organizerPin, id), 'toast_removed')
        });
    }
    if (action === 'edit' && person) return startEdit(id);
    if (action === 'cancel' && person) {
        return openModal({
            title: t('modal_cancel_title'),
            message: t('modal_cancel_msg', { time: slotStartOf(person) }),
            okLabel: t('modal_cancel_ok'),
            onConfirm: () => run(() => backend.cancel(id), 'toast_cancelled')
        });
    }
});

function slotStartOf(person) {
    const block = BLOCKS_CONFIG.find(b => b.id === person.blockId);
    const idx = blockRegs(person.blockId).findIndex(r => r.id === person.id);
    return block?.slots[idx]?.start || (block ? rangeOf(block) : '');
}

// Copiar texto formatado para WhatsApp (no idioma escolhido)
document.getElementById('copy-whatsapp-btn').addEventListener('click', async () => {
    let text = `🛹 *${t('wa_header')}*\n📅 ${t('wa_date')}\n\n`;

    BLOCKS_CONFIG.forEach((block, bIdx) => {
        const regs = blockRegs(block.id);
        text += `⏰ *${rangeOf(block)}* (${t('wa_occupied', { n: regs.length, cap: block.capacity })})\n`;
        block.slots.forEach((slot, idx) => {
            const p = regs[idx];
            if (p) {
                const tema = p.topicMode === 'defined' ? `"${p.topicTitle}"` : p.topicMode === 'secret' ? t('wa_topic_secret') : t('wa_topic_tbd');
                text += `• ${slot.start} - ${slot.end}: *${p.name}* (${tema})\n`;
            } else {
                text += `• ${slot.start} - ${slot.end}: _${t('wa_free')}_\n`;
            }
        });
        text += `\n`;
        if (bIdx === 1) text += `🍕 *${t('wa_dinner')}*\n\n`;
    });
    text += location.href.split('#')[0];

    if (await copyText(text)) showToast(t('toast_copied'), 'success');
    else showToast(t('toast_copy_fail'), 'error');
});

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        ta.remove();
        return ok;
    }
}

// Modal de confirmação / PIN
function openModal({ title, message, onConfirm, okLabel = t('confirm'), okClass = 'xp-btn-green', withInput = false }) {
    const modal = document.getElementById('confirm-modal');
    const form = document.getElementById('confirm-form');
    const input = document.getElementById('confirm-input');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');

    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    okBtn.textContent = okLabel;
    okBtn.className = `px-4 py-2 rounded-md text-sm font-semibold transition ${okClass}`;
    input.value = '';
    input.classList.toggle('hidden', !withInput);

    const close = () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        form.onsubmit = null;
        cancelBtn.onclick = null;
        modal.onclick = null;
        document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    form.onsubmit = async (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (withInput && !/^\d{4,8}$/.test(value)) {
            showToast(t('toast_pin_format'), 'error');
            input.focus();
            return;
        }
        close();
        await onConfirm(value);
    };
    cancelBtn.onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
    document.addEventListener('keydown', onKey);

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    icons();
    (withInput ? input : okBtn).focus();
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const colors = {
        success: 'bg-emerald-50 border-emerald-500/50 text-emerald-700',
        error: 'bg-purple-50 border-purple-500/50 text-purple-700',
        info: 'bg-yellow-50 border-indigo-500/60 text-slate-800'
    };
    const iconNames = { success: 'check-circle', error: 'alert-circle', info: 'info' };

    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.className = `pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg border xp-balloon backdrop-blur-md text-sm font-medium transform transition-all duration-300 ${colors[type] || colors.info}`;
    toast.innerHTML = `${icon(iconNames[type] || 'info', 'w-5 h-5 shrink-0')}<span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    icons();

    setTimeout(() => {
        toast.classList.add('opacity-0', '-translate-y-2');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// =========================================================================
// 6. TRILHA SONORA (Noturno Op. 9 nº 2 em loop)
// =========================================================================
const MUSIC_OFF_KEY = 'role_slides_music_off_v1';
const audio = document.getElementById('bg-music');
const musicBtn = document.getElementById('music-btn');

function renderMusic() {
    const playing = !audio.paused;
    musicBtn.classList.toggle('paused', !playing);
    document.body.classList.toggle('music-paused', !playing);
    musicBtn.setAttribute('aria-pressed', String(playing));
    musicBtn.setAttribute('aria-label', t(playing ? 'music_pause' : 'music_play'));
    musicBtn.title = t(playing ? 'music_pause' : 'music_play');
    document.getElementById('music-icon-play')?.classList.toggle('hidden', playing);
    document.getElementById('music-icon-pause')?.classList.toggle('hidden', !playing);
}

function setupMusic() {
    audio.volume = 0.45;
    audio.addEventListener('play', renderMusic);
    audio.addEventListener('pause', renderMusic);

    const play = () => audio.play().catch(() => { /* autoplay bloqueado: espera um gesto */ });

    musicBtn.addEventListener('click', () => {
        if (audio.paused) {
            store.del(MUSIC_OFF_KEY);
            play();
        } else {
            store.set(MUSIC_OFF_KEY, true);
            audio.pause();
        }
    });

    renderMusic();
    if (store.get(MUSIC_OFF_KEY)) return;

    // navegadores bloqueiam som sem interação: tenta já e, se não der, no primeiro toque/tecla
    play();
    const events = ['pointerdown', 'keydown', 'touchstart'];
    const unlock = (e) => {
        if (musicBtn.contains(e.target)) return; // o próprio botão cuida de si
        if (audio.paused && !store.get(MUSIC_OFF_KEY)) play();
        events.forEach(ev => document.removeEventListener(ev, unlock, true));
    };
    events.forEach(ev => document.addEventListener(ev, unlock, true));
}

// =========================================================================
// 7. IDIOMA
// =========================================================================
function applyLang(code) {
    setLang(code);
    document.getElementById('topic-title').setAttribute('aria-label', t('q3'));
    renderStatus();
    renderOrganizerButton();
    renderMusic();
    renderAll();
}

function setupLang() {
    const select = document.getElementById('lang-select');
    select.innerHTML = LANGS.map(l => `<option value="${l.code}" lang="${l.html}">${escapeHtml(l.label)}</option>`).join('');
    select.value = detectLang();
    select.addEventListener('change', () => applyLang(select.value));
    applyLang(select.value);
    select.value = getLang();
}

// Inicialização (módulos rodam depois do parse do HTML)
switchTab('form');
setupMusic();
setupLang();
startCountdown();
initStorage();
