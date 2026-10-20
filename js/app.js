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
    tripStartCoords: null, tripEndCoords: null, tripStartTime: null, audioCtx: null,

    async init() {
        const saved = localStorage.getItem('platina_state_v4');
        if (saved) { try { this.state = { ...this.state, ...JSON.parse(saved) }; } catch (e) {} }
        const savedKey = localStorage.getItem('platina_gemini_key');
        if (savedKey) this.state.geminiApiKey = savedKey;
        if ('speechSynthesis' in window) window.speechSynthesis.getVoices();
        this.updateUI();
        await this.syncWithFirebase(false);
        this.resolvePendingAddresses();
        window.addEventListener('online', () => { this.syncWithFirebase(false); this.resolvePendingAddresses(); });
    },

    initAudio() {
        if (!this.audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) this.audioCtx = new Ctx();
        }
        if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
    },

    playBeep(type = 'normal') {
        try {
            this.initAudio();
            if (!this.audioCtx) return;
            const now = this.audioCtx.currentTime;
            const freqs = type === 'critical' ? [950, 950, 950] : [660, 880];
            freqs.forEach((f, i) => {
                const osc = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();
                osc.type = type === 'critical' ? 'square' : 'sine';
                osc.frequency.setValueAtTime(f, now + i * 0.18);
                gain.gain.setValueAtTime(0.3, now + i * 0.18);
                gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.18 + 0.15);
                osc.connect(gain); gain.connect(this.audioCtx.destination);
                osc.start(now + i * 0.18); osc.stop(now + i * 0.18 + 0.16);
            });
        } catch (e) {}
    },

    // VOZ MODERNA: Gemini Neural TTS (Online) -> Voz Natural Local (Fallback)
    async triggerAlert(text, isCritical = false) {
        this.playBeep(isCritical ? 'critical' : 'normal');

        if (navigator.onLine && this.state.geminiApiKey && this.state.aiVoice !== 'local') {
            try {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${this.state.geminiApiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: `Lee con tono natural, cálido y fluido de asistente automotriz en español de México: ${text}` }] }],
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.state.aiVoice || "Aoede" } } }
                        }
                    })
                });
                const data = await res.json();
                const pcmBase64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                if (pcmBase64) {
                    this.playPcmAudio(pcmBase64, 24000);
                    return;
                }
            } catch (e) { console.warn("Fallback a voz local"); }
        }
        this.speakLocalEnhanced(text);
    },

    playPcmAudio(base64, sampleRate = 24000) {
        this.initAudio();
        const binary = atob(base64);
        const len = binary.length / 2;
        const buffer = this.audioCtx.createBuffer(1, len, sampleRate);
        const channel = buffer.getChannelData(0);
        const view = new DataView(new ArrayBuffer(binary.length));
        for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
        for (let i = 0; i < len; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioCtx.destination);
        source.start();
    },

    speakLocalEnhanced(text) {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();
        // Priorizar voces naturales/premium sobre las sintéticas básicas
        const preferred = voices.find(v => v.lang.includes('es') && /Natural|Online|Paulina|Monica|Sabina|Google español/i.test(v.name))
                       || voices.find(v => v.lang === 'es-MX')
                       || voices.find(v => v.lang.startsWith('es'));
        if (preferred) utter.voice = preferred;
        utter.lang = 'es-MX';
        utter.rate = 1.03;
        setTimeout(() => window.speechSynthesis.speak(utter), 400);
    },

    testVoiceAlert() {
        const range = Math.round(this.state.currentFuel * this.state.efficiency);
        this.triggerAlert(`Hola Mario. Tienes ${this.state.currentFuel.toFixed(1)} litros en el tanque, para unos ${range} kilómetros de recorrido.`, false);
    },

    saveLocalState(mark = true) {
        if (mark) this.state.lastUpdated = Date.now();
        localStorage.setItem('platina_state_v4', JSON.stringify(this.state));
        this.updateUI();
    },

    async syncWithFirebase(manual = false) {
        const el = document.getElementById('cloud-status');
        if (!navigator.onLine) { el.innerText = '📴 Offline'; return; }
        el.innerText = '🔄 Sync';
        try {
            const res = await fetch(FIREBASE_URL);
            const remote = await res.json();
            if (!remote) { await this.pushToFirebase(); }
            else {
                const trips = this.mergeById(this.state.trips || [], remote.trips || []);
                const cycles = this.mergeById(this.state.refuelCycles || [], remote.refuelCycles || []);
                if ((remote.lastUpdated || 0) > (this.state.lastUpdated || 0)) {
                    this.state = { ...this.state, ...remote, trips, refuelCycles: cycles, geminiApiKey: this.state.geminiApiKey || remote.geminiApiKey || "" };
                    this.saveLocalState(false);
                    if (manual) this.triggerAlert('Sincronización completada.', false);
                } else {
                    this.state.trips = trips; this.state.refuelCycles = cycles;
                    await this.pushToFirebase();
                }
            }
            el.innerText = '☁️ Online';
        } catch (e) { el.innerText = '⚠️ Red'; }
    },

    async pushToFirebase() {
        if (!navigator.onLine) return;
        try {
            await fetch(FIREBASE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.state) });
            document.getElementById('cloud-status').innerText = '☁️ Online';
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
        document.getElementById('btn-gps-toggle').innerText = '⏹️ Finalizar';
        document.getElementById('btn-gps-toggle').className = 'btn-crimson';
        document.getElementById('gps-dot').className = 'dot searching';
        document.getElementById('speed-ring').classList.add('gps-live');
        this.updateUI();

        this.watchId = navigator.geolocation.watchPosition(pos => {
            document.getElementById('gps-dot').className = 'dot active';
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
            document.getElementById('current-trip-km').innerText = this.currentTripKm.toFixed(2);
        }, () => {}, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    },

    stopTrip() {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null; this.currentSpeedKmh = 0;
        document.getElementById('speed-display').innerText = '0';
        document.getElementById('speed-ring').classList.remove('gps-live');
        document.getElementById('btn-gps-toggle').innerText = '▶️ Iniciar Viaje';
        document.getElementById('btn-gps-toggle').className = 'btn-emerald';
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
        document.getElementById('refuel-modal').style.display = 'flex';
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
        st.innerText = '🔍 Leyendo ticket...';
        try {
            const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(file); });
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.state.geminiApiKey}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: "Extrae litros y costo total en JSON: {\"liters\":0.0,\"cost\":0.0}" }, { inline_data: { mime_type: file.type, data: b64 } }] }] })
            });
            const d = await resp.json();
            const match = d.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/);
            if (match) {
                const p = JSON.parse(match[0]);
                if (p.liters) document.getElementById('input-refuel-liters').value = p.liters;
                if (p.cost) document.getElementById('input-refuel-cost').value = p.cost;
                st.innerText = `✅ ${p.liters} L ($${p.cost})`;
            }
        } catch (err) { st.innerText = '⚠️ Ingresa los litros manualmente.'; }
    },

    openHistoryModal() {
        if (this.watchId !== null || this.currentSpeedKmh > 3) return alert('🛑 Detén el auto para ver la bitácora.');
        document.getElementById('count-trips').innerText = (this.state.trips || []).length;
        document.getElementById('count-cycles').innerText = (this.state.refuelCycles || []).length;
        document.getElementById('history-trips-view').innerHTML = (this.state.trips || []).map(t => `
            <div class="log-card"><div class="log-header"><span>📅 ${t.date} (${t.startTime}-${t.endTime})</span><span class="log-badge">${t.km} km • -${t.fuelUsed}L</span></div>
            <div>🟢 ${t.startAddress}</div><div>🔴 ${t.endAddress}</div></div>`).join('');
        document.getElementById('history-cycles-view').innerHTML = (this.state.refuelCycles || []).map(c => `
            <div class="log-card"><div class="log-header"><span>⛽ ${c.endDate}</span><span class="log-badge">+${c.litersAdded} L</span></div>
            <div>🛣️ Ciclo: ${c.kmDriven} km (${c.tripsCount} viajes) | Reserva: ${c.fuelBeforeRefuel}L</div></div>`).join('');
        document.getElementById('history-modal').style.display = 'flex';
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
        document.getElementById('input-ai-voice').value = this.state.aiVoice || 'Aoede';
        document.getElementById('input-gemini-key').value = this.state.geminiApiKey || '';
        document.getElementById('settings-modal').style.display = 'flex';
    },

    saveSettings() {
        const eff = parseFloat(document.getElementById('input-efficiency').value);
        const cur = parseFloat(document.getElementById('input-current-fuel').value);
        if (!isNaN(eff) && eff > 0) this.state.efficiency = eff;
        if (!isNaN(cur) && cur >= 0) this.state.currentFuel = Math.min(this.state.tankCapacity, cur);
        this.state.aiVoice = document.getElementById('input-ai-voice').value;
        this.state.geminiApiKey = document.getElementById('input-gemini-key').value.trim();
        localStorage.setItem('platina_gemini_key', this.state.geminiApiKey);
        this.saveLocalState(true); this.pushToFirebase();
        this.closeModal('settings-modal');
    },

    closeModal(id) { document.getElementById(id).style.display = 'none'; },

    updateUI() {
        const pct = Math.max(0, Math.min(100, (this.state.currentFuel / this.state.tankCapacity) * 100));
        const range = Math.round(this.state.currentFuel * this.state.efficiency);
        document.getElementById('fuel-liters').innerText = this.state.currentFuel.toFixed(1);
        document.getElementById('fuel-pct').innerText = Math.round(pct);
        document.getElementById('fuel-bar').style.width = pct + '%';
        document.getElementById('range-km').innerText = range;
        document.getElementById('efficiency-val').innerText = this.state.efficiency.toFixed(1);
        document.getElementById('refuel-odo-km').innerText = (this.state.refuelOdoKm || 0).toFixed(1);
        document.getElementById('refuel-reminder-banner').style.display = this.state.planToRefuelToday ? 'flex' : 'none';

        const banner = document.getElementById('alert-banner');
        if (pct <= 15) {
            banner.style.display = 'flex'; banner.innerText = `🚨 RESERVA CRÍTICA: ${this.state.currentFuel.toFixed(1)} L`;
            if (!this.state.criticalFuelAlerted) { this.triggerAlert(`Atención Mario, reserva crítica. Quedan ${Math.round(this.state.currentFuel)} litros.`, true); this.state.criticalFuelAlerted = true; }
        } else if (pct <= 25) {
            banner.style.display = 'flex'; banner.innerText = `⚠️ NIVEL BAJO: ${this.state.currentFuel.toFixed(1)} L`;
            if (!this.state.lowFuelAlerted) { this.triggerAlert(`Nivel bajo de combustible. Quedan ${Math.round(this.state.currentFuel)} litros.`, false); this.state.lowFuelAlerted = true; }
        } else { banner.style.display = 'none'; this.state.lowFuelAlerted = false; this.state.criticalFuelAlerted = false; }
    },

    haversine(lat1, lon1, lat2, lon2) {
        const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2)**2;
        return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
    }
};

window.onload = () => App.init();
