const FIREBASE_URL = "https://platina-dashboard-f92a6-default-rtdb.firebaseio.com/platina_v4.json";

const App = {
    state: {
        tankCapacity: 50.0, currentFuel: 50.0, efficiency: 10.0,
        refuelOdoKm: 0.0, lifetimeOdoKm: 0.0,
        cycleStartDate: new Date().toLocaleDateString('es-MX'), cycleTripsCount: 0,
        lastUpdated: 0, lastAskedDate: "", planToRefuelToday: false,
        trips: [], refuelCycles: [], geminiApiKey: "", aiVoice: "Aoede",
        lowFuelAlerted: false, criticalFuelAlerted: false
    },
    watchId: null, lastPos: null, currentTripKm: 0.0, currentSpeedKmh: 0,
    tripStartCoords: null, tripEndCoords: null, tripStartTime: null,

    async init() {
        const saved = localStorage.getItem('platina_state_v4');
        if (saved) { try { this.state = { ...this.state, ...JSON.parse(saved) }; } catch (e) {} }
        const savedKey = localStorage.getItem('platina_gemini_key');
        if (savedKey) this.state.geminiApiKey = savedKey;
        this.updateUI();
        await this.syncWithFirebase(false);
        this.resolvePendingAddresses();
        window.addEventListener('online', () => { this.syncWithFirebase(false); this.resolvePendingAddresses(); });
    },

    // ---------- Helpers de interfaz ----------
    ico(name, cls = '') { return `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`; },
    esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
    el(id) { return document.getElementById(id); },

    setCloud(state, label) {
        const icons = { online: 'cloud', sync: 'sync', offline: 'cloud-off', error: 'alert' };
        this.el('cloud-pill').dataset.state = state;
        this.el('cloud-status').innerText = label;
        this.el('cloud-icon').setAttribute('href', '#i-' + (icons[state] || 'cloud'));
    },

    setTripButton(running) {
        const b = this.el('btn-gps-toggle');
        b.className = 'btn btn-lg ' + (running ? 'btn-danger' : 'btn-primary');
        b.innerHTML = this.ico(running ? 'stop' : 'play') + `<span>${running ? 'Finalizar' : 'Iniciar Viaje'}</span>`;
    },

    // ---------- Audio y voz (ver js/voice.js) ----------
    initAudio() { Voice.unlock(); },
    playBeep(type = 'normal') { Voice.beep(type); },

    voiceOpts(isCritical = false) {
        return { critical: isCritical, apiKey: this.state.geminiApiKey, geminiVoice: this.state.aiVoice || 'Aoede' };
    },
    triggerAlert(text, isCritical = false) { return Voice.speak(text, this.voiceOpts(isCritical)); },

    testVoiceAlert() {
        const range = Math.round(this.state.currentFuel * this.state.efficiency);
        this.triggerAlert(`Hola Mario. Tienes ${this.state.currentFuel.toFixed(1)} litros en el tanque, para unos ${range} kilómetros de recorrido.`, false);
    },

    // Prueba con los valores del formulario (sin guardar)
    async previewVoice() {
        const st = this.el('voice-status'), engine = this.el('input-ai-voice').value;
        const key = this.el('input-gemini-key').value.trim();
        const rate = parseFloat(this.el('input-voice-rate').value) || 1;
        const localVoice = this.el('input-local-voice').value;
        const sample = 'Hola Mario. Tienes doce punto siete litros en el tanque, para unos ciento veintisiete kilómetros.';
        st.innerText = engine !== 'local' && key ? 'Generando voz neuronal…' : 'Reproduciendo voz local…';
        Voice.stop(); Voice.beep('normal');
        let used = 'local';
        if (engine !== 'local' && key) {
            const pcm = await Voice._neural(sample, { apiKey: key, geminiVoice: engine, critical: false });
            if (pcm) { Voice._playPcm(pcm); used = 'gemini'; }
        }
        if (used === 'local') await Voice.previewLocal(sample, { localVoice, rate });
        st.innerText = used === 'gemini' ? '✓ Voz neuronal Gemini' : (engine !== 'local' && key ? 'Gemini no respondió: se usó la voz local' : '✓ Voz local');
    },

    async fillVoiceSettings() {
        const gem = this.el('input-ai-voice');
        gem.innerHTML = Voice.GEMINI_VOICES.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')
            + '<option value="local">Solo voz local (sin conexión)</option>';
        gem.value = this.state.aiVoice || 'Aoede';

        const sel = this.el('input-local-voice');
        sel.innerHTML = '<option value="auto">Automática (la mejor disponible)</option>';
        const list = await Voice.localList();
        sel.innerHTML = '<option value="auto">Automática (la mejor disponible)</option>'
            + list.map(v => `<option value="${this.esc(v.voiceURI)}">${Voice.score(v) >= 50 ? '★ ' : ''}${this.esc(v.name)} (${this.esc(v.lang)})</option>`).join('');
        sel.value = list.some(v => v.voiceURI === Voice.prefs.localVoice) ? Voice.prefs.localVoice : 'auto';
        const best = list[0];
        this.el('local-voice-hint').innerText = best
            ? `${list.length} voces en español detectadas. Mejor: ${best.name}${Voice.score(best) >= 50 ? ' (alta calidad)' : ''}.`
            : 'No se detectaron voces en español en este dispositivo.';
        const rate = Voice.prefs.rate || 1;
        this.el('input-voice-rate').value = rate;
        this.el('voice-rate-out').value = rate.toFixed(2) + '×';
        this.el('voice-status').innerText = '';
    },

    saveLocalState(mark = true) {
        if (mark) this.state.lastUpdated = Date.now();
        localStorage.setItem('platina_state_v4', JSON.stringify(this.state));
        this.updateUI();
    },

    async syncWithFirebase(manual = false) {
        if (!navigator.onLine) { this.setCloud('offline', 'Offline'); return; }
        this.setCloud('sync', 'Sync');
        try {
            const res = await fetch(FIREBASE_URL);
            const remote = await res.json();
            if (!remote) { await this.pushToFirebase(); }
            else {
                const trips = this.mergeById(this.state.trips || [], remote.trips || []);
                const cycles = this.mergeById(this.state.refuelCycles || [], remote.refuelCycles || []);
                if ((remote.lastUpdated || 0) > (this.state.lastUpdated || 0)) {
                    this.state = { ...this.state, ...remote, trips, refuelCycles: cycles, geminiApiKey: this.state.geminiApiKey || "" };
                    this.saveLocalState(false);
                    if (manual) this.triggerAlert('Sincronización completada.', false);
                } else {
                    this.state.trips = trips; this.state.refuelCycles = cycles;
                    await this.pushToFirebase();
                }
            }
            this.setCloud('online', 'Online');
        } catch (e) { this.setCloud('error', 'Red'); }
    },

    // La API key NUNCA se sube a la nube: queda solo en este dispositivo.
    publicState() { const { geminiApiKey, ...rest } = this.state; return rest; },

    async pushToFirebase() {
        if (!navigator.onLine) return;
        try {
            await fetch(FIREBASE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.publicState()) });
            this.setCloud('online', 'Online');
        } catch (e) {}
    },

    mergeById(a, b) {
        const map = new Map();
        [...a, ...b].forEach(x => {
            if (x && x.id) {
                const ex = map.get(x.id);
                if (!ex || (x.addressResolved && !ex.addressResolved)) map.set(x.id, x);
            }
        });
        return Array.from(map.values()).sort((x, y) => y.id - x.id);
    },

    async resolvePendingAddresses() {
        if (!navigator.onLine || !this.state.trips) return;
        let changed = false;
        for (let t of this.state.trips) {
            if (!t.addressResolved && t.startLat && t.endLat) {
                const s = await this.geocode(t.startLat, t.startLon);
                await new Promise(r => setTimeout(r, 1100));
                const e = await this.geocode(t.endLat, t.endLon);
                if (s && e) { t.startAddress = s; t.endAddress = e; t.addressResolved = true; changed = true; }
            }
        }
        if (changed) { this.saveLocalState(true); this.pushToFirebase(); }
    },

    async geocode(lat, lon) {
        try {
            const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18`, { headers: { 'Accept-Language': 'es' } });
            const d = await r.json();
            if (d?.address) {
                const road = d.address.road || d.address.pedestrian || d.address.suburb || "Calle s/n";
                const hood = d.address.neighbourhood || d.address.suburb || d.address.town || "";
                return `${road}${hood ? ', ' + hood : ''}`;
            }
        } catch (e) {}
        return null;
    },

    handleStartStopClick() {
        this.initAudio();
        if (this.watchId !== null) { this.stopTrip(); return; }
        const today = new Date().toLocaleDateString('es-MX');
        if (this.state.lastAskedDate !== today) {
            document.getElementById('daily-question-modal').style.display = 'flex';
        } else {
            if (this.state.planToRefuelToday) this.triggerAlert('Recuerda que hoy planeaste recargar gasolina.', false);
            this.startTripGPS();
        }
    },

    answerDailyRefuel(val) {
        this.state.lastAskedDate = new Date().toLocaleDateString('es-MX');
        this.state.planToRefuelToday = val;
        this.closeModal('daily-question-modal');
        this.saveLocalState(true); this.pushToFirebase();
        if (val) this.triggerAlert('Entendido. Te recordaré registrar los litros.', false);
        this.startTripGPS();
    },

    async startTripGPS() {
        if (!navigator.geolocation) return alert('GPS no soportado.');
        if ('wakeLock' in navigator) { try { await navigator.wakeLock.request('screen'); } catch (e) {} }
        this.currentTripKm = 0.0; this.lastPos = null; this.tripStartCoords = null; this.tripEndCoords = null; this.tripStartTime = new Date();
        this.setTripButton(true);
        document.getElementById('gps-dot').className = 'dot searching';
        document.getElementById('speed-ring').classList.add('gps-live');
        this.updateUI();

        this.watchId = navigator.geolocation.watchPosition(pos => {
            document.getElementById('gps-dot').className = 'dot active';
            document.getElementById('gps-pill').classList.add('live');
            document.getElementById('gps-status').innerText = `GPS ±${Math.round(pos.coords.accuracy)}m`;
            this.currentSpeedKmh = (pos.coords.speed && pos.coords.speed > 0) ? Math.round(pos.coords.speed * 3.6) : 0;
            if (!this.tripStartCoords && pos.coords.accuracy < 65) this.tripStartCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            this.tripEndCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };

            if (this.lastPos && pos.coords.accuracy < 45) {
                const dist = this.haversine(this.lastPos.latitude, this.lastPos.longitude, pos.coords.latitude, pos.coords.longitude);
                if (dist > 0.008) {
                    this.currentTripKm += dist; this.state.refuelOdoKm += dist; this.state.lifetimeOdoKm += dist;
                    this.state.currentFuel = Math.max(0, this.state.currentFuel - (dist / this.state.efficiency));
                    this.lastPos = pos.coords; this.saveLocalState(true);
                }
            } else if (!this.lastPos && pos.coords.accuracy < 60) { this.lastPos = pos.coords; }
            document.getElementById('speed-display').innerText = this.currentSpeedKmh;
            this.setDial(this.currentSpeedKmh);
            document.getElementById('current-trip-km').innerText = this.currentTripKm.toFixed(2);
        }, () => {}, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    },

    stopTrip() {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null; this.currentSpeedKmh = 0;
        document.getElementById('speed-display').innerText = '0';
        document.getElementById('speed-ring').classList.remove('gps-live');
        this.setTripButton(false);
        this.setDial(0);
        document.getElementById('gps-pill').classList.remove('live');
        document.getElementById('gps-dot').className = 'dot';
        document.getElementById('gps-status').innerText = 'GPS: Off';

        if (this.currentTripKm >= 0.02) {
            const now = new Date();
            this.state.trips.unshift({
                id: Date.now(), date: now.toLocaleDateString('es-MX'),
                startTime: this.tripStartTime.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}),
                endTime: now.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}),
                km: Number(this.currentTripKm.toFixed(2)),
                fuelUsed: Number((this.currentTripKm / this.state.efficiency).toFixed(2)),
                fuelRemaining: Number(this.state.currentFuel.toFixed(1)),
                startLat: this.tripStartCoords?.lat, startLon: this.tripStartCoords?.lon,
                endLat: this.tripEndCoords?.lat, endLon: this.tripEndCoords?.lon,
                startAddress: "Calculando calle...", endAddress: "Calculando calle...", addressResolved: false
            });
            this.state.cycleTripsCount = (this.state.cycleTripsCount || 0) + 1;
        }
        this.currentTripKm = 0.0;
        document.getElementById('current-trip-km').innerText = '0.00';
        this.saveLocalState(true); this.pushToFirebase(); this.resolvePendingAddresses();
        if (this.state.planToRefuelToday) this.triggerAlert('Viaje finalizado. Recuerda registrar tus litros si ya pasaste a la gasolinera.', false);
        else this.playBeep('normal');
    },

    addManualKm() {
        const km = parseFloat(prompt('¿Kilómetros recorridos?', '5.0'));
        if (!isNaN(km) && km > 0) {
            const spent = km / this.state.efficiency;
            this.state.refuelOdoKm += km; this.state.lifetimeOdoKm += km;
            this.state.currentFuel = Math.max(0, this.state.currentFuel - spent);
            this.state.cycleTripsCount = (this.state.cycleTripsCount || 0) + 1;
            const now = new Date();
            this.state.trips.unshift({
                id: Date.now(), date: now.toLocaleDateString('es-MX'),
                startTime: now.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}),
                endTime: now.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}),
                km: Number(km.toFixed(2)), fuelUsed: Number(spent.toFixed(2)),
                fuelRemaining: Number(this.state.currentFuel.toFixed(1)),
                startAddress: "Manual", endAddress: "Manual", addressResolved: true
            });
            this.saveLocalState(true); this.pushToFirebase();
        }
    },

    openRefuelModal() {
        document.getElementById('modal-cycle-km').innerText = this.state.refuelOdoKm.toFixed(1);
        document.getElementById('input-refuel-liters').value = '';
        document.getElementById('input-refuel-cost').value = '';
        document.getElementById('ticket-status').innerText = '';
        document.getElementById('refuel-date').innerText = new Date().toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        document.getElementById('modal-cycle-trips').innerText = this.state.cycleTripsCount || 0;
        this.updateRefuelPreview();
        document.getElementById('refuel-modal').style.display = 'flex';
    },

    // Vista previa en vivo: precio unitario, rendimiento del ciclo y nivel de tanque
    updateRefuelPreview() {
        const cap = this.state.tankCapacity, before = this.state.currentFuel;
        const l = Math.max(0, parseFloat(this.el('input-refuel-liters').value) || 0);
        const c = Math.max(0, parseFloat(this.el('input-refuel-cost').value) || 0);
        const after = Math.min(cap, before + l), added = after - before;
        const pBefore = before / cap * 100, pAfter = after / cap * 100;
        this.el('refuel-unit-price').innerText = l > 0 && c > 0 ? `$${(c / l).toFixed(2)} / L` : '—';
        this.el('modal-cycle-eff').innerText = l > 0 && this.state.refuelOdoKm > 0 ? (this.state.refuelOdoKm / l).toFixed(1) : '—';
        this.el('preview-before-pct').innerText = Math.round(pBefore) + '%';
        this.el('preview-after-pct').innerText = Math.round(pAfter) + '%';
        this.el('preview-after-l').innerText = l > 0 ? `(${after.toFixed(1)} L)` : '';
        this.el('preview-prev').style.width = pBefore + '%';
        this.el('preview-add').style.width = (pAfter - pBefore) + '%';
        this.el('preview-prev-l').innerText = `Previo: ${before.toFixed(1)} L`;
        this.el('preview-cap').innerText = `Cap: ${cap.toFixed(1)} L`;
        this.el('preview-add-l').innerText = `Carga: +${added.toFixed(1)} L`;
    },

    confirmRefuel() {
        const l = parseFloat(document.getElementById('input-refuel-liters').value);
        const c = parseFloat(document.getElementById('input-refuel-cost').value) || 0;
        if (isNaN(l) || l <= 0) return alert('Ingresa litros válidos.');
        this.registerRefuel(l, c, "Carga / Ticket");
        this.closeModal('refuel-modal');
    },

    fillTankQuick() {
        const needed = Math.max(0, this.state.tankCapacity - this.state.currentFuel);
        if (confirm(`¿Confirmas Tanque Lleno (50L)? Se cerrará el ciclo de ${this.state.refuelOdoKm.toFixed(1)} km.`)) {
            this.registerRefuel(Number(needed.toFixed(1)) || 50.0, 0, "Tanque Lleno");
        }
    },

    registerRefuel(liters, cost, method) {
        const now = new Date();
        const before = this.state.currentFuel;
        this.state.currentFuel = Math.min(this.state.tankCapacity, this.state.currentFuel + liters);
        this.state.refuelCycles.unshift({
            id: Date.now(), startDate: this.state.cycleStartDate,
            endDate: now.toLocaleDateString('es-MX') + ' ' + now.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}),
            kmDriven: Number(this.state.refuelOdoKm.toFixed(1)), tripsCount: this.state.cycleTripsCount || 0,
            fuelBeforeRefuel: Number(before.toFixed(1)), litersAdded: Number(liters.toFixed(2)), costPaid: cost, method
        });
        this.state.refuelOdoKm = 0.0; this.state.cycleTripsCount = 0;
        this.state.cycleStartDate = now.toLocaleDateString('es-MX');
        this.state.planToRefuelToday = false;
        this.saveLocalState(true); this.pushToFirebase();
        this.triggerAlert(`Recarga de ${liters.toFixed(1)} litros registrada. Odómetro reiniciado.`, false);
    },

    adjustTrafficFuel() {
        this.state.currentFuel = Math.max(0, this.state.currentFuel - 1.0);
        this.saveLocalState(true); this.pushToFirebase(); this.playBeep('normal');
    },

    async handleTicketPhoto(e) {
        const file = e.target.files[0];
        if (!file || !navigator.onLine || !this.state.geminiApiKey) return;
        const st = document.getElementById('ticket-status');
        st.innerText = 'Leyendo ticket…';
        try {
            const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(file); });
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.state.geminiApiKey },
                body: JSON.stringify({ contents: [{ parts: [{ text: "Extrae litros y costo total en JSON: {\"liters\":0.0,\"cost\":0.0}" }, { inline_data: { mime_type: file.type, data: b64 } }] }] })
            });
            const d = await resp.json();
            const match = d.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/);
            if (match) {
                const p = JSON.parse(match[0]);
                if (p.liters) document.getElementById('input-refuel-liters').value = p.liters;
                if (p.cost) document.getElementById('input-refuel-cost').value = p.cost;
                st.innerText = `Leído: ${p.liters} L · $${p.cost}`;
                this.updateRefuelPreview();
            }
        } catch (err) { st.innerText = 'No se pudo leer: ingresa los litros manualmente.'; }
    },

    openHistoryModal() {
        if (this.watchId !== null || this.currentSpeedKmh > 3) return alert('🛑 Detén el auto para ver la bitácora.');
        const trips = this.state.trips || [], cycles = this.state.refuelCycles || [];
        this.el('count-trips').innerText = trips.length;
        this.el('count-cycles').innerText = cycles.length;

        const totalKm = trips.reduce((a, t) => a + (Number(t.km) || 0), 0);
        const totalL = cycles.reduce((a, c) => a + (Number(c.litersAdded) || 0), 0);
        const head = (label, total) => `<div class="list-head"><span class="overline">${label}</span><strong>${total}</strong></div>`;

        this.el('history-trips-view').innerHTML = trips.length
            ? head('Sesiones de conducción', `TOTAL: ${totalKm.toFixed(2)} KM`) + trips.map(t => `
            <article class="log-card">
                <div class="log-top">
                    <div class="log-when"><span class="icon-tile">${this.ico('calendar')}</span>
                        <div><p class="log-date">${this.esc(t.date)}</p><p class="log-time">${this.esc(t.startTime)} - ${this.esc(t.endTime)}</p></div></div>
                    <div class="log-stat"><div class="log-big">${this.esc(t.km)} <small>km</small></div><span class="chip chip-amber">-${this.esc(t.fuelUsed)} L</span></div>
                </div>
                <ol class="timeline">
                    <li><span class="tl-label">Origen</span><span class="tl-addr">${this.esc(t.startAddress)}</span></li>
                    <li class="end"><span class="tl-label">Destino</span><span class="tl-addr">${this.esc(t.endAddress)}</span></li>
                </ol>
            </article>`).join('')
            : '<div class="empty">Aún no hay viajes registrados.</div>';

        const cap = this.state.tankCapacity;
        this.el('history-cycles-view').innerHTML = cycles.length
            ? head('Ciclos de recarga', `TOTAL: ${totalL.toFixed(1)} L`) + cycles.map(c => {
                const before = Number(c.fuelBeforeRefuel) || 0, add = Number(c.litersAdded) || 0;
                const pBefore = Math.min(100, before / cap * 100), pAdd = Math.min(100 - pBefore, add / cap * 100);
                const eff = add > 0 && c.kmDriven > 0 ? (c.kmDriven / add).toFixed(1) : '—';
                const price = add > 0 && c.costPaid > 0 ? ` · $${(c.costPaid / add).toFixed(2)}/L` : '';
                return `
            <article class="log-card">
                <div class="log-top">
                    <div class="log-when"><span class="icon-tile amber">${this.ico('fuel')}</span>
                        <div><p class="log-date">${this.esc(c.endDate)}</p><p class="log-time">${this.esc(c.method || 'Recarga')}${price}</p></div></div>
                    <div class="log-stat"><div class="log-big cyan">+${this.esc(c.litersAdded)} <small>L</small></div>${c.costPaid > 0 ? `<span class="chip chip-amber">$${Number(c.costPaid).toFixed(2)}</span>` : ''}</div>
                </div>
                <div class="mini-metrics">
                    <div class="metric-tile"><div class="metric-label">Ciclo</div><div class="metric-val">${this.esc(c.kmDriven)}</div><small>km</small></div>
                    <div class="metric-tile"><div class="metric-label">Rend.</div><div class="metric-val cyan">${eff}</div><small>km/L</small></div>
                    <div class="metric-tile"><div class="metric-label">Viajes</div><div class="metric-val">${this.esc(c.tripsCount)}</div><small>en ciclo</small></div>
                </div>
                <div class="tank-mini">
                    <div class="stack-bar"><div class="prev" style="width:${pBefore}%"></div><div class="add" style="width:${pAdd}%"></div></div>
                    <div class="tank-mini-row"><span>Reserva previa: ${before} L</span><span>Tanque tras carga: ${Math.min(cap, before + add).toFixed(1)} L</span></div>
                </div>
            </article>`; }).join('')
            : '<div class="empty">Aún no hay recargas registradas.</div>';

        this.el('history-modal').style.display = 'flex';
    },

    switchHistoryTab(tab) {
        document.getElementById('tab-trips-btn').className = tab === 'trips' ? 'tab-btn active' : 'tab-btn';
        document.getElementById('tab-cycles-btn').className = tab === 'cycles' ? 'tab-btn active' : 'tab-btn';
        document.getElementById('history-trips-view').style.display = tab === 'trips' ? 'flex' : 'none';
        document.getElementById('history-cycles-view').style.display = tab === 'cycles' ? 'flex' : 'none';
    },

    exportCSV(type) {
        let csv = "\uFEFF";
        if (type === 'trips') {
            csv += "Fecha,Inicio,Fin,KM,Litros,Restante,Origen,Destino\n";
            (this.state.trips || []).forEach(t => csv += `${t.date},${t.startTime},${t.endTime},${t.km},${t.fuelUsed},${t.fuelRemaining},"${t.startAddress}","${t.endAddress}"\n`);
        } else {
            csv += "Inicio,Fecha Recarga,KM Ciclo,Viajes,Reserva,Litros Cargados,Costo\n";
            (this.state.refuelCycles || []).forEach(c => csv += `${c.startDate},${c.endDate},${c.kmDriven},${c.tripsCount},${c.fuelBeforeRefuel},${c.litersAdded},${c.costPaid}\n`);
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        a.download = `Platina_${type}.csv`; a.click();
    },

    openSettings() {
        document.getElementById('input-efficiency').value = this.state.efficiency;
        document.getElementById('input-current-fuel').value = this.state.currentFuel.toFixed(1);
        this.fillVoiceSettings();
        document.getElementById('input-gemini-key').value = this.state.geminiApiKey || '';
        document.getElementById('settings-modal').style.display = 'flex';
    },

    saveSettings() {
        const eff = parseFloat(document.getElementById('input-efficiency').value);
        const cur = parseFloat(document.getElementById('input-current-fuel').value);
        if (!isNaN(eff) && eff > 0) this.state.efficiency = eff;
        if (!isNaN(cur) && cur >= 0) this.state.currentFuel = Math.min(this.state.tankCapacity, cur);
        this.state.aiVoice = document.getElementById('input-ai-voice').value;
        Voice.savePrefs({ localVoice: document.getElementById('input-local-voice').value, rate: parseFloat(document.getElementById('input-voice-rate').value) || 1 });
        this.state.geminiApiKey = document.getElementById('input-gemini-key').value.trim();
        localStorage.setItem('platina_gemini_key', this.state.geminiApiKey);
        this.saveLocalState(true); this.pushToFirebase();
        this.closeModal('settings-modal');
    },

    closeModal(id) {
        document.getElementById(id).style.display = 'none';
        if (id === 'settings-modal') Voice.stop();
    },

    // Aguja del velocímetro: 0–120 km/h sobre el arco
    setDial(kmh) {
        const pct = Math.max(2, Math.min(100, (kmh / 120) * 100));
        document.getElementById('dial-active').style.strokeDasharray = `${pct} 100`;
    },

    updateUI() {
        const pct = Math.max(0, Math.min(100, (this.state.currentFuel / this.state.tankCapacity) * 100));
        const range = Math.round(this.state.currentFuel * this.state.efficiency);
        document.getElementById('fuel-liters').innerText = this.state.currentFuel.toFixed(1);
        document.getElementById('fuel-pct').innerText = Math.round(pct);
        document.getElementById('fuel-bar').style.width = pct + '%';
        document.getElementById('odo-total').innerText = (this.state.lifetimeOdoKm || 0).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        const gauge = document.getElementById('fuel-gauge');
        gauge.classList.toggle('is-critical', pct <= 15);
        gauge.classList.toggle('is-low', pct > 15 && pct <= 25);
        document.getElementById('range-km').innerText = range;
        document.getElementById('efficiency-val').innerText = this.state.efficiency.toFixed(1);
        document.getElementById('refuel-odo-km').innerText = (this.state.refuelOdoKm || 0).toFixed(1);
        document.getElementById('refuel-reminder-banner').style.display = this.state.planToRefuelToday ? 'flex' : 'none';

        const banner = document.getElementById('alert-banner');
        if (pct <= 15) {
            this.showAlert('is-critical', `Reserva crítica · ${this.state.currentFuel.toFixed(1)} L`, range);
            if (!this.state.criticalFuelAlerted) { this.triggerAlert(`Atención Mario, reserva crítica. Quedan ${Math.round(this.state.currentFuel)} litros.`, true); this.state.criticalFuelAlerted = true; }
        } else if (pct <= 25) {
            this.showAlert('is-warn', `Reserva baja · ${this.state.currentFuel.toFixed(1)} L`, range);
            if (!this.state.lowFuelAlerted) { this.triggerAlert(`Nivel bajo de combustible. Quedan ${Math.round(this.state.currentFuel)} litros.`, false); this.state.lowFuelAlerted = true; }
        } else { banner.style.display = 'none'; this.state.lowFuelAlerted = false; this.state.criticalFuelAlerted = false; }
    },

    showAlert(level, title, range) {
        const b = document.getElementById('alert-banner');
        b.className = 'banner ' + level; b.style.display = 'flex';
        document.getElementById('alert-title').innerText = title;
        document.getElementById('alert-sub').innerText = `Recarga sugerida · Autonomía ~${range} km`;
    },

    haversine(lat1, lon1, lat2, lon2) {
        const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2)**2;
        return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
    }
};

window.onload = () => App.init();
