// Rolê de Slides — inscrição nos horários de apresentação.
// Backend: Supabase (RPCs no schema privado "rs", ver supabase/migrations) quando
// config.js traz URL e chave; senão, modo local (localStorage, só neste navegador).

// =========================================================================
// 1. CONFIGURAÇÃO DO EVENTO, BLOCOS E SLOTS
// =========================================================================
const EVENT_START = new Date('2026-11-14T12:00:00-03:00'); // sábado, 14/11, 12h (Brasília)

const BLOCKS_CONFIG = [
    {
        id: 'block_1',
        title: 'Bloco 1 • Tarde Parte 1',
        timeRange: '14h às 16h',
        capacity: 5,
        slots: [
            { start: '14:00', end: '14:20', note: '15 min slide + 5 min troca' },
            { start: '14:20', end: '14:40', note: '15 min slide + 5 min troca' },
            { start: '14:40', end: '15:00', note: '15 min slide + 5 min troca' },
            { start: '15:00', end: '15:20', note: '15 min slide + 5 min troca' },
            { start: '15:20', end: '15:45', note: '15 min slide + encerramento bloco' }
        ]
    },
    {
        id: 'block_2',
        title: 'Bloco 2 • Tarde Parte 2',
        timeRange: '16h às 18h',
        capacity: 5,
        slots: [
            { start: '16:00', end: '16:20', note: '15 min slide + 5 min troca' },
            { start: '16:20', end: '16:40', note: '15 min slide + 5 min troca' },
            { start: '16:40', end: '17:00', note: '15 min slide + 5 min troca' },
            { start: '17:00', end: '17:20', note: '15 min slide + 5 min troca' },
            { start: '17:20', end: '17:45', note: '15 min slide + pausa jantar' }
        ]
    },
    {
        id: 'block_3',
        title: 'Bloco 3 • Sessão Noturna',
        timeRange: '20h às 22h',
        capacity: 6,
        slots: [
            { start: '20:00', end: '20:18', note: '14 min slide + 4 min troca' },
            { start: '20:18', end: '20:36', note: '14 min slide + 4 min troca' },
            { start: '20:36', end: '20:54', note: '14 min slide + 4 min troca' },
            { start: '20:54', end: '21:12', note: '14 min slide + 4 min troca' },
            { start: '21:12', end: '21:30', note: '14 min slide + 4 min troca' },
            { start: '21:30', end: '21:50', note: '15 min slide + encerramento' }
        ]
    }
];

const TOTAL_CAPACITY = BLOCKS_CONFIG.reduce((s, b) => s + b.capacity, 0);

const ERROR_MESSAGES = {
    full: 'Ops! Esse horário acabou de lotar. Escolha outro bloco!',
    bad_name: 'Nome inválido (até 40 caracteres).',
    bad_topic: 'Tema inválido (até 90 caracteres).',
    bad_block: 'Bloco inválido. Recarregue a página.',
    bad_pin: 'PIN incorreto.',
    no_pin: 'O PIN do organizador ainda não foi configurado no banco.',
    throttled: 'Muitas tentativas erradas. Espere 10 minutos.',
    forbidden: 'Não foi possível cancelar: essa inscrição não é deste navegador.',
    not_found: 'Inscrição não encontrada (talvez já tenha sido removida).'
};

// =========================================================================
// 2. ESTADO E PERSISTÊNCIA
// =========================================================================
let registrations = [];
let organizerMode = false;
let organizerPin = null;
let backend = null;
let busy = false;

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
    constructor(code) { super(ERROR_MESSAGES[code] || `Erro: ${code}`); this.code = code; }
}

// ---- Supabase
async function createSupabaseBackend(url, anonKey) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

    async function rpc(fn, args) {
        const { data, error } = await sb.rpc(fn, args);
        if (error) throw new Error(error.message || 'Falha de conexão');
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
                renderAll();
            } catch (err) {
                console.error(err);
                showToast('Erro de conexão com o banco. Verifique sua internet.', 'error');
            }
        } while (refreshAgain);
    })();
    try { await refreshing; } finally { refreshing = null; }
}

function setStatus(text, ok) {
    document.getElementById('connection-status').textContent = text;
    const color = ok ? 'emerald' : 'amber';
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
            setStatus('Sem conexão', false);
            showToast('Não foi possível conectar. Recarregue a página.', 'error');
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
            if (!backend.live) return setStatus('Modo Local (só neste navegador)', false);
            setStatus(ok ? 'Vagas em Tempo Real' : 'Reconectando…', ok);
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
    const clock = document.getElementById('countdown-clock');
    const live = document.getElementById('countdown-live');
    const label = document.getElementById('countdown-label');
    if (diff <= 0) {
        clock.classList.add('hidden');
        live.classList.remove('hidden');
        label.textContent = 'É hoje!';
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
    countEl.className = 'text-2xl font-extrabold ' + (remaining === 0 ? 'text-rose-400' : remaining <= 4 ? 'text-amber-400' : 'text-emerald-400');
    document.getElementById('total-capacity').textContent = TOTAL_CAPACITY;
    document.getElementById('badge-registered-count').textContent = `${occupied}/${TOTAL_CAPACITY}`;

    if (busy) return;
    const submitBtn = document.getElementById('submit-btn');
    submitBtn.disabled = remaining === 0;
    submitBtn.innerHTML = remaining === 0
        ? `<i data-lucide="lock" class="w-5 h-5"></i><span>Todas as ${TOTAL_CAPACITY} Vagas Esgotadas!</span>`
        : `<i data-lucide="check-circle-2" class="w-5 h-5"></i><span>Confirmar Minha Vaga Agora</span>`;
}

function renderFormBlocks() {
    const container = document.getElementById('blocks-radio-container');
    const previouslySelected = document.querySelector('input[name="blockId"]:checked')?.value;

    container.innerHTML = BLOCKS_CONFIG.map(block => {
        const count = blockRegs(block.id).length;
        const left = Math.max(0, block.capacity - count);
        const isFull = left === 0;
        const isChecked = !isFull && previouslySelected === block.id;

        const badgeHtml = isFull
            ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">ESGOTADO</span>`
            : left === 1
                ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">ÚLTIMA VAGA!</span>`
                : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">${left} vagas livres</span>`;

        return `
            <label class="block ${isFull ? 'cursor-not-allowed' : 'cursor-pointer'}">
                <input type="radio" name="blockId" value="${block.id}" class="sr-only radio-card" ${isFull ? 'disabled' : ''} ${isChecked ? 'checked' : ''}>
                <div class="h-full p-4 rounded-xl border border-slate-700/90 bg-slate-900/70 hover:border-slate-500 transition flex flex-col justify-between gap-3">
                    <div>
                        <div class="text-xs font-medium text-slate-400">${block.title.split('•')[1]?.trim() || 'Bloco'}</div>
                        <div class="text-lg font-extrabold text-white mt-0.5">${block.timeRange}</div>
                    </div>
                    <div class="flex items-center justify-between pt-2 border-t border-slate-800/80">
                        ${badgeHtml}
                        <span class="text-[11px] text-slate-400 font-medium">${count}/${block.capacity}</span>
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
        const barColor = left === 0 ? 'bg-rose-500' : left <= 2 ? 'bg-amber-500' : 'bg-emerald-500';
        const textColor = left === 0 ? 'text-rose-400' : 'text-emerald-400';
        return `
            <div>
                <div class="flex justify-between items-center text-xs mb-1.5">
                    <span class="font-semibold text-white">${block.timeRange}</span>
                    <span class="font-bold ${textColor}">${left === 0 ? 'Lotado (0 vagas)' : `${left} de ${block.capacity} disponíveis`}</span>
                </div>
                <div class="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full ${barColor} transition-all duration-500 rounded-full" style="width: ${percent}%"></div>
                </div>
            </div>`;
    }).join('');
}

function topicHtml(person) {
    if (person.topicMode === 'defined') {
        return `<span class="text-sm font-medium text-slate-200">"${escapeHtml(person.topicTitle)}"</span>`;
    }
    if (person.topicMode === 'secret') {
        return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30">🤫 Tema Surpresa (Segredo)</span>`;
    }
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">⏳ Sem tema por enquanto</span>`;
}

const TECH_BADGES = {
    own_laptop: `<span title="Vai levar próprio notebook" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-slate-800 text-emerald-300 border border-slate-700"><i data-lucide="laptop" class="w-3 h-3"></i> Notebook</span>`,
    send_file: `<span title="Vai mandar arquivo antes para PC da casa" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-slate-800 text-sky-300 border border-slate-700"><i data-lucide="file-up" class="w-3 h-3"></i> PC Casa</span>`,
    audio_out: `<span title="Precisa de saída de áudio" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-slate-800 text-amber-300 border border-slate-700"><i data-lucide="volume-2" class="w-3 h-3"></i> Áudio</span>`
};

function renderSchedule() {
    const mine = myRegs();
    document.getElementById('schedule-blocks-container').innerHTML = BLOCKS_CONFIG.map((block, bIdx) => {
        const regs = blockRegs(block.id);
        const left = Math.max(0, block.capacity - regs.length);

        const rowsHtml = block.slots.map((slot, slotIdx) => {
            const person = regs[slotIdx];

            if (!person) {
                return `
                    <tr class="border-b border-slate-800/60 last:border-none hover:bg-slate-800/20 transition">
                        <td class="py-3.5 px-4 whitespace-nowrap">
                            <div class="font-mono text-xs sm:text-sm font-bold text-slate-400">${slot.start} - ${slot.end}</div>
                            <div class="text-[11px] text-slate-500">${slot.note}</div>
                        </td>
                        <td class="py-3.5 px-4" colspan="${organizerMode ? 4 : 3}">
                            <div class="flex items-center justify-between gap-2">
                                <span class="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400/90 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full whitespace-nowrap">
                                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                    Vaga #${slotIdx + 1} Disponível
                                </span>
                                <button data-action="quick-select" data-block="${block.id}" class="text-xs font-semibold text-indigo-400 hover:text-indigo-300 underline underline-offset-2 whitespace-nowrap">
                                    Reservar este horário →
                                </button>
                            </div>
                        </td>
                    </tr>`;
            }

            const isMine = Boolean(mine[person.id]);
            const techBadges = (person.tech || []).map(t => TECH_BADGES[t]).filter(Boolean);
            const id = escapeHtml(person.id);

            const organizerControls = organizerMode ? `
                <td class="py-3.5 px-4 text-right whitespace-nowrap">
                    <div class="inline-flex items-center gap-1">
                        <button data-action="move" data-id="${id}" data-dir="-1" ${slotIdx === 0 ? 'disabled' : ''} title="Subir na ordem" aria-label="Subir na ordem" class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition">
                            <i data-lucide="arrow-up" class="w-3.5 h-3.5"></i>
                        </button>
                        <button data-action="move" data-id="${id}" data-dir="1" ${slotIdx === regs.length - 1 ? 'disabled' : ''} title="Descer na ordem" aria-label="Descer na ordem" class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition">
                            <i data-lucide="arrow-down" class="w-3.5 h-3.5"></i>
                        </button>
                        <button data-action="remove" data-id="${id}" title="Remover e liberar vaga" aria-label="Remover e liberar vaga" class="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 ml-1 transition">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>
                    </div>
                </td>` : '';

            const cancelBtn = isMine ? `
                <button data-action="cancel" data-id="${id}" class="ml-1 text-[11px] font-semibold text-rose-300/90 hover:text-rose-200 underline underline-offset-2">cancelar</button>` : '';

            return `
                <tr class="border-b border-slate-800/60 last:border-none ${isMine ? 'bg-emerald-950/20' : 'bg-indigo-950/15'} hover:bg-indigo-950/30 transition">
                    <td class="py-3.5 px-4 whitespace-nowrap">
                        <div class="font-mono text-xs sm:text-sm font-bold text-indigo-300">${slot.start} - ${slot.end}</div>
                        <div class="text-[11px] text-slate-400">Apresentação #${slotIdx + 1}</div>
                    </td>
                    <td class="py-3.5 px-4 whitespace-nowrap">
                        <div class="flex items-center gap-2.5">
                            <div class="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-xs font-bold text-white shrink-0">
                                ${escapeHtml(Array.from(person.name)[0]?.toUpperCase() || '?')}
                            </div>
                            <div>
                                <span class="font-bold text-white text-sm">${escapeHtml(person.name)}</span>
                                ${isMine ? `<div class="text-[11px] text-emerald-300 font-semibold">você ${cancelBtn}</div>` : ''}
                            </div>
                        </div>
                    </td>
                    <td class="py-3.5 px-4">${topicHtml(person)}</td>
                    <td class="py-3.5 px-4">
                        <div class="flex flex-wrap gap-1.5">
                            ${techBadges.length ? techBadges.join('') : '<span class="text-xs text-slate-500">—</span>'}
                        </div>
                    </td>
                    ${organizerControls}
                </tr>`;
        }).join('');

        const dinnerBreakHtml = bIdx === 1 ? `
            <div class="rounded-2xl p-4 bg-slate-900/60 border border-dashed border-slate-700 flex items-center justify-center gap-3 text-slate-400 text-xs sm:text-sm">
                <i data-lucide="utensils" class="w-4 h-4 text-amber-400 shrink-0"></i>
                <span><strong>18h00 às 20h00:</strong> Intervalo livre para jantar, descansar e recarregar as energias! 🍕🥤</span>
            </div>` : '';

        return `
            <div class="glass-card rounded-2xl overflow-hidden shadow-lg">
                <div class="px-5 py-4 bg-slate-900/90 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <span class="text-xs font-semibold uppercase tracking-wider text-indigo-400">${block.title}</span>
                        <h3 class="text-lg font-extrabold text-white">${block.timeRange}</h3>
                    </div>
                    <span class="px-3 py-1 rounded-full text-xs font-bold ${left === 0 ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'}">
                        ${left === 0 ? 'Bloco Lotado (0 vagas)' : `${left} ${left === 1 ? 'vaga restante' : 'vagas restantes'}`}
                    </span>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400 bg-slate-950/40">
                                <th class="py-2.5 px-4">Horário</th>
                                <th class="py-2.5 px-4">Apresentador</th>
                                <th class="py-2.5 px-4">Tema</th>
                                <th class="py-2.5 px-4">Setup</th>
                                ${organizerMode ? '<th class="py-2.5 px-4 text-right">Organizar</th>' : ''}
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
async function run(action, successMsg) {
    try {
        await action();
        if (successMsg) showToast(successMsg, 'info');
    } catch (err) {
        console.error(err);
        if (err.code === 'bad_pin' || err.code === 'no_pin') leaveOrganizerMode();
        showToast(err.message || 'Algo deu errado.', 'error');
    }
    await refresh();
}

document.getElementById('presentation-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const name = document.getElementById('presenter-name').value.trim();
    const blockRadio = document.querySelector('input[name="blockId"]:checked');
    const topicMode = document.querySelector('input[name="topicMode"]:checked')?.value || 'defined';
    const topicTitle = document.getElementById('topic-title').value.trim();
    const tech = Array.from(document.querySelectorAll('input[name="tech"]:checked')).map(cb => cb.value);

    if (!name) {
        showToast('Por favor, digite o seu nome ou apelido!', 'error');
        document.getElementById('presenter-name').focus();
        return;
    }
    if (!blockRadio) {
        showToast('Escolha um bloco de horário disponível!', 'error');
        return;
    }
    if (topicMode === 'defined' && !topicTitle) {
        showToast('Escreva o tema da sua apresentação ou escolha "Segredo" / "Sem tema por enquanto".', 'error');
        document.getElementById('topic-title').focus();
        return;
    }

    busy = true;
    const btn = document.getElementById('submit-btn');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i><span>Reservando sua vaga...</span>`;
    icons();

    try {
        await backend.register({ name, blockId: blockRadio.value, topicMode, topicTitle, tech });
        document.getElementById('presenter-name').value = '';
        document.getElementById('topic-title').value = '';
        document.querySelectorAll('input[name="tech"]').forEach(cb => { cb.checked = false; });
        showToast(`Vaga garantida para ${name}! 🎉`, 'success');
        switchTab('schedule');
    } catch (err) {
        console.error(err);
        showToast(err.message || 'Não foi possível reservar. Tente de novo.', 'error');
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

const TAB_ON = 'flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all bg-indigo-600 text-white shadow-md';
const TAB_OFF = 'flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all text-slate-400 hover:text-white';

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

function enterOrganizerMode() {
    organizerMode = true;
    document.getElementById('organizer-btn-label').textContent = 'Modo Organizador: ON';
    document.getElementById('organizer-banner').classList.remove('hidden');
    switchTab('schedule');
    renderSchedule();
    icons();
}

function leaveOrganizerMode() {
    organizerMode = false;
    organizerPin = null;
    store.del(PIN_KEY, sessionStorage);
    document.getElementById('organizer-btn-label').textContent = 'Modo Organizador: OFF';
    document.getElementById('organizer-banner').classList.add('hidden');
    renderSchedule();
    icons();
}

document.getElementById('organizer-toggle-btn').addEventListener('click', () => {
    if (organizerMode) {
        organizerMode = false;
        document.getElementById('organizer-btn-label').textContent = 'Modo Organizador: OFF';
        document.getElementById('organizer-banner').classList.add('hidden');
        renderSchedule();
        icons();
        return;
    }
    if (!backend) return;
    if (!backend.needsPin || organizerPin) {
        enterOrganizerMode();
        showToast('Modo Organizador ativado!', 'info');
        return;
    }
    openModal({
        title: 'Modo Organizador',
        message: 'Digite o PIN do organizador para reordenar ou remover inscrições.',
        okLabel: 'Entrar',
        okClass: 'bg-purple-600 hover:bg-purple-500 shadow-purple-600/20',
        withInput: true,
        onConfirm: async (pin) => {
            try {
                await backend.checkPin(pin);
                organizerPin = pin;
                store.set(PIN_KEY, pin, sessionStorage);
                enterOrganizerMode();
                showToast('Modo Organizador ativado!', 'info');
            } catch (err) {
                showToast(err.message || 'Não foi possível validar o PIN.', 'error');
            }
        }
    });
});

document.getElementById('reset-all-btn').addEventListener('click', () => {
    openModal({
        title: 'Resetar Todas as Vagas?',
        message: `Isso vai apagar todas as inscrições atuais e restaurar as ${TOTAL_CAPACITY} vagas originais. Tem certeza?`,
        onConfirm: () => run(() => backend.reset(organizerPin), `Todas as ${TOTAL_CAPACITY} vagas foram resetadas!`)
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
            title: 'Remover Apresentador?',
            message: `Deseja remover "${person.name}" do cronograma? A vaga voltará a ficar disponível imediatamente.`,
            onConfirm: () => run(() => backend.remove(organizerPin, id), 'Inscrição removida e vaga liberada!')
        });
    }
    if (action === 'cancel' && person) {
        return openModal({
            title: 'Cancelar sua inscrição?',
            message: `Sua vaga das ${slotStartOf(person)} vai ficar livre para outra pessoa.`,
            okLabel: 'Cancelar inscrição',
            onConfirm: () => run(() => backend.cancel(id), 'Inscrição cancelada e vaga liberada.')
        });
    }
});

function slotStartOf(person) {
    const block = BLOCKS_CONFIG.find(b => b.id === person.blockId);
    const idx = blockRegs(person.blockId).findIndex(r => r.id === person.id);
    return block?.slots[idx]?.start || block?.timeRange || '';
}

// Copiar texto formatado para WhatsApp
document.getElementById('copy-whatsapp-btn').addEventListener('click', async () => {
    let text = `🛹📊 *ROLÊ DE SLIDES - CRONOGRAMA*\n📅 Sábado, 14/11 • a partir das 12h\n\n`;

    BLOCKS_CONFIG.forEach((block, bIdx) => {
        const regs = blockRegs(block.id);
        text += `⏰ *${block.timeRange}* (${regs.length}/${block.capacity} ocupadas)\n`;
        block.slots.forEach((slot, idx) => {
            const p = regs[idx];
            if (p) {
                const tema = p.topicMode === 'defined' ? `"${p.topicTitle}"` : p.topicMode === 'secret' ? '🤫 Tema Surpresa' : '⏳ A definir';
                text += `• ${slot.start} - ${slot.end}: *${p.name}* (${tema})\n`;
            } else {
                text += `• ${slot.start} - ${slot.end}: _[Vaga Livre]_\n`;
            }
        });
        text += `\n`;
        if (bIdx === 1) text += `🍕 *18h00 às 20h00: Pausa para Jantar*\n\n`;
    });
    text += location.href.split('#')[0];

    if (await copyText(text)) showToast('Cronograma copiado! Só colar no grupo do WhatsApp.', 'success');
    else showToast('Não foi possível copiar automaticamente.', 'error');
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
function openModal({ title, message, onConfirm, okLabel = 'Confirmar', okClass = 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/20', withInput = false }) {
    const modal = document.getElementById('confirm-modal');
    const form = document.getElementById('confirm-form');
    const input = document.getElementById('confirm-input');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');

    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    okBtn.textContent = okLabel;
    okBtn.className = `px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-lg transition ${okClass}`;
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
            showToast('O PIN tem de 4 a 8 dígitos.', 'error');
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
        success: 'bg-emerald-950/95 border-emerald-500/50 text-emerald-200',
        error: 'bg-rose-950/95 border-rose-500/50 text-rose-200',
        info: 'bg-slate-900/95 border-indigo-500/50 text-slate-100'
    };
    const iconNames = { success: 'check-circle', error: 'alert-circle', info: 'info' };

    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.className = `pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-md text-sm font-medium transform transition-all duration-300 ${colors[type] || colors.info}`;
    toast.innerHTML = `<i data-lucide="${iconNames[type] || 'info'}" class="w-5 h-5 shrink-0"></i><span>${escapeHtml(message)}</span>`;
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

// Inicialização (módulos rodam depois do parse do HTML)
icons();
startCountdown();
renderAll();
initStorage();
