const FIREBASE_URL = "https://platina-dashboard-f92a6-default-rtdb.firebaseio.com/platina_v4.json";

const App = {
    state: {
        tankCapacity: 50.0, currentFuel: 50.0, efficiency: 8.2,
        refuelOdoKm: 0.0, lifetimeOdoKm: 0.0,
        cycleStartDate: new Date().toLocaleDateString('es-MX'), cycleTripsCount: 0,
        lastUpdated: 0, lastAskedDate: "", planToRefuelToday: false,
        trips: [], refuelCycles: [], favoriteTrips: [],
        geminiApiKey: "", aiVoice: "Aoede",
        plateDigit: "5", hologram: "1", parkedCoords: null, streamUrl: "",
        lowFuelAlerted: false, criticalFuelAlerted: false
    },
    watchId: null, lastPos: null, currentTripKm: 0.0, currentSpeedKmh: 0,
    tripStartCoords: null, tripEndCoords: null, tripStartTime: null,
    playlist: [], currentTrackIdx: 0, userVolume: 0.85, weatherSummary: "",
    calculatedHistEfficiency: null,

    async init() {
        const saved = localStorage.getItem('platina_state_v4');
        if (saved) { try { this.state = { ...this.state, ...JSON.parse(saved) }; } catch (e) {} }
        const savedKey = localStorage.getItem('platina_gemini_key');
        if (savedKey) this.state.geminiApiKey = savedKey;

        this.startClock();
        this.setupAudioPlayer();
        if ('speechSynthesis' in window) {
            window.speechSynthesis.getVoices();
            window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
        }

        this.updateUI();
        await this.syncWithFirebase(false);
        this.resolvePendingAddresses();
        this.checkWeather(false);

        window.addEventListener('online', () => {
            this.syncWithFirebase(false);
            this.resolvePendingAddresses();
            this.checkWeather(false);
        });
    },

    computeHistoricalEfficiency() {
        const cycles = (this.state.refuelCycles || []).filter(c => c.kmDriven > 5 && c.litersAdded > 1);
        const trips = this.state.trips || [];

        let totalClosedKm = cycles.reduce((sum, c) => sum + Number(c.kmDriven || 0), 0);
        let totalClosedLiters = cycles.reduce((sum, c) => sum + Number(c.litersAdded || 0), 0);
        let totalAllTripsKm = trips.reduce((sum, t) => sum + Number(t.km || 0), 0);

        if (cycles.length > 0) {
            const estKmPerLiter = totalClosedKm / totalClosedLiters;
            if (estKmPerLiter > 3 && estKmPerLiter < 22) {
                this.calculatedHistEfficiency = Number(estKmPerLiter.toFixed(2));
                return {
                    avg: this.calculatedHistEfficiency,
                    detail: `Basado en ${cycles.length} recarga(s): ${totalClosedKm.toFixed(1)} km recorridos con ${totalClosedLiters.toFixed(1)} L cargados = <strong>${this.calculatedHistEfficiency} km/L</strong>.`
                };
            }
        }

        if (totalAllTripsKm > 20) {
            const consumedFrom50 = Math.max(10, 50 - (this.state.currentFuel || 0));
            const est = Number((totalAllTripsKm / consumedFrom50).toFixed(2));
            if (est >= 4 && est <= 18) {
                this.calculatedHistEfficiency = est;
                return {
                    avg: est,
                    detail: `Historial de ${trips.length} viajes (${totalAllTripsKm.toFixed(1)} km). Consumo real estimado: <strong>${est} km/L</strong>.`
                };
            }
        }

        this.calculatedHistEfficiency = 8.1;
        return {
            avg: 8.1,
            detail: `Calibración recomendada para Platina 2004 en cerro y tráfico: <strong>8.1 km/L</strong> (más realista que 10.0 km/L).`
        };
    },

    applyHistoricalEfficiency() {
        const analysis = this.computeHistoricalEfficiency();
        this.state.efficiency = analysis.avg;
        document.getElementById('input-efficiency').value = analysis.avg;
        this.saveLocalState(true);
        this.pushToFirebase();
        this.triggerAlert(`Rendimiento calibrado a ${analysis.avg} kilómetros por litro según tu historial.`, false);
    },

    renderFavoritesUI() {
        const favs = this.state.favoriteTrips || [];
        const barEl = document.getElementById('quick-favorites-list');
        const modalListEl = document.getElementById('modal-favorites-list');
        const countEl = document.getElementById('count-favs');

        if (countEl) countEl.innerText = favs.length;

        if (barEl) {
            barEl.innerHTML = favs.length === 0
                ? `<span class="fav-empty-hint">Sin favoritos aún. Toca "+ Gestionar" para guardar escuela, trabajo o casa.</span>`
                : favs.map((f, idx) => `
                    <button class="fav-chip" onclick="App.triggerFavoriteTrip('${f.id}')">
                        #${idx + 1} ${f.name} <span>(${f.km} km)</span>
                    </button>
                `).join('');
        }

        if (modalListEl) {
            modalListEl.innerHTML = favs.length === 0
                ? `<p style="text-align:center;color:var(--text-secondary);padding:15px;">Aún no tienes viajes frecuentes guardados.</p>`
                : favs.map((f, idx) => `
                    <div class="log-card">
                        <div class="log-header">
                            <span>⭐ #${idx + 1} ${f.name}</span>
                            <div style="display:flex;gap:6px;align-items:center;">
                                <span class="log-badge">${f.km} km</span>
                                <button class="btn-emerald" style="padding:4px 8px;font-size:0.72rem;" onclick="App.triggerFavoriteTrip('${f.id}')">Registrar</button>
                                <button class="btn-crimson" style="padding:4px 7px;font-size:0.7rem;" onclick="App.deleteFavoriteTrip('${f.id}')">✕</button>
                            </div>
                        </div>
                        <div style="color:var(--text-secondary);font-size:0.72rem;">🟢 ${f.startAddress} → 🔴 ${f.endAddress}</div>
                    </div>
                `).join('');
        }
    },

    triggerFavoriteTrip(favId) {
        VoiceEngine.initAudio();
        const fav = (this.state.favoriteTrips || []).find(f => String(f.id) === String(favId));
        if (!fav) return;

        const spent = fav.km / this.state.efficiency;
        if (!confirm(`¿Registrar Viaje Frecuente "${fav.name}"?\n\n• Ruta: ${fav.startAddress} → ${fav.endAddress}\n• Distancia: ${fav.km} km\n• Consumo: -${spent.toFixed(2)} L`)) return;

        this.recordTripEntry(fav.km, `${fav.name}: ${fav.startAddress}`, fav.endAddress);
        this.closeModal('manual-trip-modal');
        this.triggerAlert(`Viaje frecuente a ${fav.name} de ${fav.km} kilómetros registrado.`, false);
    },

    deleteFavoriteTrip(favId) {
        if (!confirm('¿Eliminar este viaje frecuente?')) return;
        this.state.favoriteTrips = (this.state.favoriteTrips || []).filter(f => String(f.id) !== String(favId));
        this.saveLocalState(true);
        this.pushToFirebase();
    },

    openManualTripModal(defaultTab = 'favorites') {
        VoiceEngine.initAudio();
        document.getElementById('manual-fav-name').value = '';
        document.getElementById('manual-start-input').value = '';
        document.getElementById('manual-end-input').value = '';
        document.getElementById('manual-km-input').value = '';
        this.updateManualPreview();
        this.renderFavoritesUI();
        this.switchManualModalTab(defaultTab);
        document.getElementById('manual-trip-modal').style.display = 'flex';
    },

    switchManualModalTab(tab) {
        const isFav = tab === 'favorites';
        document.getElementById('tab-fav-btn').className = isFav ? 'tab-btn active' : 'tab-btn';
        document.getElementById('tab-new-manual-btn').className = !isFav ? 'tab-btn active' : 'tab-btn';
        document.getElementById('modal-favorites-view').style.display = isFav ? 'block' : 'none';
        document.getElementById('modal-manual-form-view').style.display = !isFav ? 'block' : 'none';
    },

    async calculateRouteDistance() {
        const startText = document.getElementById('manual-start-input').value.trim();
        const endText = document.getElementById('manual-end-input').value.trim();
        const btn = document.getElementById('btn-calc-route');

        if (!startText || !endText) return alert('Escribe inicio y destino.');
        if (!navigator.onLine) return alert('Sin conexión. Ingresa los kilómetros directamente abajo.');

        btn.innerText = '🔍 Calculando ruta...';
        try {
            const [sCoord, eCoord] = await Promise.all([this.searchPlaceCoords(startText), this.searchPlaceCoords(endText)]);
            if (!sCoord || !eCoord) {
                btn.innerText = '📐 Calcular Kilómetros por Calle';
                return alert('No encontré uno de los puntos. Agrega el municipio o ciudad.');
            }
            const routeRes = await fetch(`https://router.project-osrm.org/route/v1/driving/${sCoord.lon},${sCoord.lat};${eCoord.lon},${eCoord.lat}?overview=false`);
            const routeData = await routeRes.json();
            const km = routeData?.routes?.[0]?.distance ? (routeData.routes[0].distance / 1000) : (this.haversine(sCoord.lat, sCoord.lon, eCoord.lat, eCoord.lon) * 1.3);

            document.getElementById('manual-km-input').value = km.toFixed(2);
            this.updateManualPreview();
            btn.innerText = `✅ Ruta calculada (${km.toFixed(1)} km)`;
        } catch (e) {
            btn.innerText = '📐 Calcular Kilómetros por Calle';
            alert('Error al calcular ruta.');
        }
    },

    async searchPlaceCoords(query) {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ', Mexico')}&limit=1`);
        const d = await r.json();
        return d?.[0] ? { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) } : null;
    },

    updateManualPreview() {
        const km = parseFloat(document.getElementById('manual-km-input').value) || 0;
        const fuel = km / this.state.efficiency;
        const rem = Math.max(0, this.state.currentFuel - fuel);
        document.getElementById('prev-km').innerText = `${km.toFixed(2)} km`;
        document.getElementById('prev-fuel').innerText = `-${fuel.toFixed(2)} L`;
        document.getElementById('prev-remaining').innerText = `${rem.toFixed(1)} L`;
    },

    confirmManualTrip(saveAsFavorite = false) {
        const km = parseFloat(document.getElementById('manual-km-input').value);
        if (isNaN(km) || km <= 0) return alert('Verifica que los kilómetros sean mayores a 0.');

        const favName = document.getElementById('manual-fav-name').value.trim();
        const startAddr = document.getElementById('manual-start-input').value.trim() || "Origen Manual";
        const endAddr = document.getElementById('manual-end-input').value.trim() || "Destino Manual";

        if (saveAsFavorite) {
            const label = favName || prompt('Escribe un nombre corto para este Viaje Frecuente (ej. Escuela, Trabajo):', endAddr.slice(0, 18));
            if (!label) return;
            if (!this.state.favoriteTrips) this.state.favoriteTrips = [];
            this.state.favoriteTrips.push({
                id: 'fav_' + Date.now(),
                name: label,
                startAddress: startAddr,
                endAddress: endAddr,
                km: Number(km.toFixed(2))
            });
        }

        const spent = km / this.state.efficiency;
        if (!confirm(`¿Confirmas registrar este viaje?\n\n• Origen: ${startAddr}\n• Destino: ${endAddr}\n• Distancia: ${km.toFixed(2)} km\n• Consumo: -${spent.toFixed(2)} L`)) return;

        this.recordTripEntry(km, startAddr, endAddr);
        this.closeModal('manual-trip-modal');
        this.triggerAlert(`Viaje de ${km.toFixed(1)} kilómetros registrado.`, false);
    },

    recordTripEntry(km, startAddr, endAddr) {
        const spent = km / this.state.efficiency;
        this.state.refuelOdoKm += km;
        this.state.lifetimeOdoKm += km;
        this.state.currentFuel = Math.max(0, this.state.currentFuel - spent);
        this.state.cycleTripsCount = (this.state.cycleTripsCount || 0) + 1;

        const now = new Date();
        this.state.trips.unshift({
            id: Date.now(), date: now.toLocaleDateString('es-MX'),
            startTime: now.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}),
            endTime: now.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}),
            km: Number(km.toFixed(2)), fuelUsed: Number(spent.toFixed(2)),
            fuelRemaining: Number(this.state.currentFuel.toFixed(1)),
            startAddress: startAddr, endAddress: endAddr, addressResolved: true
        });

        this.saveLocalState(true);
        this.pushToFirebase();
    },

    startClock() {
        const tick = () => {
            const now = new Date();
            document.getElementById('clock-time').innerText = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            const opts = { weekday: 'short', day: '2-digit', month: 'short' };
            document.getElementById('clock-date').innerText = now.toLocaleDateString('es-MX', opts).toUpperCase();
        };
        tick();
        setInterval(tick, 1000);
    },

    evaluateHoyNoCircula() {
        const badge = document.getElementById('hnc-badge');
        if (!badge) return;
        if (this.state.hologram === "0") { badge.className = "pill-badge hnc-ok"; badge.innerText = "🟢 Exento (0)"; return; }
        const now = new Date();
        const day = now.getDay();
        const d = parseInt(this.state.plateDigit || "5");
        let restricted = false;

        if (day === 1 && (d === 5 || d === 6)) restricted = true;
        if (day === 2 && (d === 7 || d === 8)) restricted = true;
        if (day === 3 && (d === 3 || d === 4)) restricted = true;
        if (day === 4 && (d === 1 || d === 2)) restricted = true;
        if (day === 5 && (d === 9 || d === 0)) restricted = true;
        if (day === 6) {
            const weekOfMonth = Math.ceil(now.getDate() / 7);
            if (this.state.hologram === "2") restricted = true;
            else if (this.state.hologram === "1") {
                const isOdd = d % 2 !== 0;
                if (isOdd && (weekOfMonth === 1 || weekOfMonth === 3)) restricted = true;
                if (!isOdd && (weekOfMonth === 2 || weekOfMonth === 4)) restricted = true;
            }
        }
        badge.className = restricted ? "pill-badge hnc-warn" : "pill-badge hnc-ok";
        badge.innerText = restricted ? "⛔ No Circula" : "🟢 Circula";
    },

    async checkWeather(speak = false) {
        if (!navigator.onLine) return;
        try {
            const lat = this.state.parkedCoords?.lat || 19.54;
            const lon = this.state.parkedCoords?.lon || -99.19;
            const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation_probability&timezone=auto`);
            const data = await res.json();
            if (data?.current) {
                const temp = Math.round(data.current.temperature_2m);
                const rain = data.current.precipitation_probability || 0;
                document.getElementById('weather-badge').innerText = `${rain > 40 ? '🌧️' : '🌡️'} ${temp}°C`;
                this.weatherSummary = `Temperatura de ${temp} grados, con ${rain} por ciento de probabilidad de lluvia.`;
                if (speak) this.triggerAlert(this.weatherSummary, false);
            }
        } catch (e) {}
    },

    setupAudioPlayer() {
        const audio = document.getElementById('cockpit-audio');
        audio.volume = this.userVolume;
        audio.addEventListener('ended', () => this.nextTrack());
    },

    loadLocalMusicFiles(e) {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        this.playlist = files.map(f => ({ name: f.name.replace(/\.[^/.]+$/, ""), url: URL.createObjectURL(f) }));
        this.currentTrackIdx = 0;
        this.playCurrentTrack();
    },

    playCurrentTrack() {
        const audio = document.getElementById('cockpit-audio');
        if (!this.playlist.length && this.state.streamUrl) {
            audio.src = this.state.streamUrl;
            document.getElementById('media-track-title').innerText = "Streaming: Finamp / Navidrome";
            audio.play().catch(() => {});
            document.getElementById('btn-play-pause').innerText = "⏸";
            return;
        }
        if (!this.playlist.length) return;
        const track = this.playlist[this.currentTrackIdx];
        audio.src = track.url;
        document.getElementById('media-track-title').innerText = track.name;
        audio.play().catch(() => {});
        document.getElementById('btn-play-pause').innerText = "⏸";
    },

    togglePlayPause() {
        const audio = document.getElementById('cockpit-audio');
        if (!audio.src) {
            if (this.state.streamUrl) { this.playCurrentTrack(); return; }
            document.getElementById('local-music-input').click();
            return;
        }
        if (audio.paused) { audio.play(); document.getElementById('btn-play-pause').innerText = "⏸"; }
        else { audio.pause(); document.getElementById('btn-play-pause').innerText = "▶"; }
    },

    nextTrack() {
        if (!this.playlist.length) return;
        this.currentTrackIdx = (this.currentTrackIdx + 1) % this.playlist.length;
        this.playCurrentTrack();
    },

    prevTrack() {
        if (!this.playlist.length) return;
        this.currentTrackIdx = (this.currentTrackIdx - 1 + this.playlist.length) % this.playlist.length;
        this.playCurrentTrack();
    },

    setVolume(val) {
        this.userVolume = parseFloat(val);
        document.getElementById('cockpit-audio').volume = this.userVolume;
    },

    duckMusic(duck = true) {
        const audio = document.getElementById('cockpit-audio');
        if (!audio || audio.paused) return;
        audio.volume = duck ? Math.min(0.18, this.userVolume * 0.25) : this.userVolume;
    },

    launchExternalAudio(app) {
        const isAndroid = /Android/i.test(navigator.userAgent);
        if (app === 'amazon') window.location.href = isAndroid ? "intent://#Intent;package=com.amazon.mp3;end" : "amznmp3://";
        else if (app === 'finamp') window.location.href = isAndroid ? "intent://#Intent;package=com.unicornsonlsd.finamp;end" : "finamp://";
    },

    triggerAlert(text, isCritical = false) {
        VoiceEngine.speak(text, isCritical, this.state, () => this.duckMusic(true), () => this.duckMusic(false));
    },

    testVoiceAlert() {
        const range = Math.round(this.state.currentFuel * this.state.efficiency);
        const msg = `Hola Mario. Tienes ${this.state.currentFuel.toFixed(1)} litros en el tanque, para unos ${range} kilómetros reales. ${this.weatherSummary || 'Buen camino.'}`;
        this.triggerAlert(msg, false);
    },

    toggleHudMode() { document.body.classList.toggle('hud-mirror'); },

    openParkedCarLocation() {
        if (!this.state.parkedCoords?.lat) return alert('Se guardará automáticamente al finalizar un viaje con GPS.');
        const { lat, lon, time } = this.state.parkedCoords;
        if (confirm(`Último estacionamiento (${time || 'Reciente'}).\n¿Abrir ruta caminando en Google Maps?`)) {
            window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=walking`, '_blank');
        }
    },

    saveLocalState(mark = true) {
        if (mark) this.state.lastUpdated = Date.now();
        localStorage.setItem('platina_state_v4', JSON.stringify(this.state));
        this.updateUI();
    },

    async syncWithFirebase(manual = false) {
        const el = document.getElementById('cloud-status');
        if (!navigator.onLine) { el.innerText = '📴'; return; }
        el.innerText = '🔄';
        try {
            const res = await fetch(FIREBASE_URL);
            const remote = await res.json();
            if (!remote) { await this.pushToFirebase(); }
            else {
                const trips = this.mergeById(this.state.trips || [], remote.trips || []);
                const cycles = this.mergeById(this.state.refuelCycles || [], remote.refuelCycles || []);
                const favs = this.mergeById(this.state.favoriteTrips || [], remote.favoriteTrips || []);

                if ((remote.lastUpdated || 0) > (this.state.lastUpdated || 0)) {
                    this.state = {
                        ...this.state, ...remote,
                        trips, refuelCycles: cycles, favoriteTrips: favs,
                        geminiApiKey: this.state.geminiApiKey || remote.geminiApiKey || ""
                    };
                    this.saveLocalState(false);
                    if (manual) this.triggerAlert('Datos sincronizados con la nube.', false);
                } else {
                    this.state.trips = trips; this.state.refuelCycles = cycles; this.state.favoriteTrips = favs;
                    await this.pushToFirebase();
                }
            }
            el.innerText = '☁️ OK';
        } catch (e) { el.innerText = '⚠️'; }
    },

    async pushToFirebase() {
        if (!navigator.onLine) return;
        try {
            await fetch(FIREBASE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.state) });
            document.getElementById('cloud-status').innerText = '☁️ OK';
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
        return Array.from(map.values()).sort((x, y) => String(y.id).localeCompare(String(x.id)));
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
        VoiceEngine.initAudio();
        if (this.watchId !== null) { this.stopTrip(); return; }
        const today = new Date().toLocaleDateString('es-MX');
        if (this.state.lastAskedDate !== today) {
            document.getElementById('daily-question-modal').style.display = 'flex';
        } else {
            if (this.state.planToRefuelToday) this.triggerAlert('Recuerda que hoy planeaste pasar a la gasolinera.', false);
            this.startTripGPS();
        }
    },

    answerDailyRefuel(val) {
        this.state.lastAskedDate = new Date().toLocaleDateString('es-MX');
        this.state.planToRefuelToday = val;
        this.closeModal('daily-question-modal');
        this.saveLocalState(true); this.pushToFirebase();
        if (val) this.triggerAlert('Perfecto Mario, yo te recuerdo registrar la carga.', false);
        this.startTripGPS();
    },

    async startTripGPS() {
        if (!navigator.geolocation) return alert('GPS no soportado.');
        if ('wakeLock' in navigator) { try { await navigator.wakeLock.request('screen'); } catch (e) {} }
        this.currentTripKm = 0.0; this.lastPos = null; this.tripStartCoords = null; this.tripEndCoords = null; this.tripStartTime = new Date();
        document.getElementById('btn-gps-toggle').innerText = '⏹ Finalizar';
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
        document.getElementById('btn-gps-toggle').innerText = '▶ Iniciar Viaje';
        document.getElementById('btn-gps-toggle').className = 'btn-cobalt';
        document.getElementById('gps-dot').className = 'dot';
        document.getElementById('gps-status').innerText = 'GPS: Off';

        const now = new Date();
        if (this.tripEndCoords) {
            this.state.parkedCoords = {
                lat: this.tripEndCoords.lat, lon: this.tripEndCoords.lon,
                time: now.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'})
            };
        }

        if (this.currentTripKm >= 0.02) {
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
        if (this.state.planToRefuelToday) this.triggerAlert('Viaje finalizado. No olvides registrar tus litros si recargaste.', false);
        else VoiceEngine.playBeep('normal');
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
        this.triggerAlert(`Listo Mario, sumamos ${liters.toFixed(1)} litros al tanque. Odómetro parcial en cero.`, false);
    },

    adjustTrafficFuel() {
        this.state.currentFuel = Math.max(0, this.state.currentFuel - 1.0);
        this.saveLocalState(true); this.pushToFirebase(); VoiceEngine.playBeep('normal');
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
            <div class="log-card"><div class="log-header"><span>⛽ ${c.endDate}</span><span class="log-badge">+${c.litersAdded} L ${c.costPaid ? '($'+c.costPaid+')' : ''}</span></div>
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
        const analysis = this.computeHistoricalEfficiency();
        document.getElementById('historical-calc-summary').innerHTML = analysis.detail;
        document.getElementById('btn-apply-hist-eff').innerText = `✨ Aplicar ${analysis.avg} km/L al Tablero`;

        document.getElementById('input-efficiency').value = this.state.efficiency;
        document.getElementById('input-current-fuel').value = this.state.currentFuel.toFixed(1);
        document.getElementById('input-plate-digit').value = this.state.plateDigit || '5';
        document.getElementById('input-hologram').value = this.state.hologram || '1';
        document.getElementById('input-ai-voice').value = this.state.aiVoice || 'Aoede';
        document.getElementById('input-gemini-key').value = this.state.geminiApiKey || '';
        document.getElementById('input-stream-url').value = this.state.streamUrl || '';
        document.getElementById('settings-modal').style.display = 'flex';
    },

    saveSettings() {
        const eff = parseFloat(document.getElementById('input-efficiency').value);
        const cur = parseFloat(document.getElementById('input-current-fuel').value);
        if (!isNaN(eff) && eff > 0) this.state.efficiency = eff;
        if (!isNaN(cur) && cur >= 0) this.state.currentFuel = Math.min(this.state.tankCapacity, cur);
        this.state.plateDigit = document.getElementById('input-plate-digit').value;
        this.state.hologram = document.getElementById('input-hologram').value;
        this.state.aiVoice = document.getElementById('input-ai-voice').value;
        this.state.geminiApiKey = document.getElementById('input-gemini-key').value.trim();
        this.state.streamUrl = document.getElementById('input-stream-url').value.trim();
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

        const analysis = this.computeHistoricalEfficiency();
        const histBadge = document.getElementById('hist-eff-badge');
        if (histBadge && analysis.avg) histBadge.innerText = `(Hist: ${analysis.avg})`;

        this.renderFavoritesUI();
        this.evaluateHoyNoCircula();

        const paidCycles = (this.state.refuelCycles || []).filter(c => c.costPaid > 0 && c.kmDriven > 0);
        if (paidCycles.length > 0) {
            const totalCost = paidCycles.reduce((s, c) => s + c.costPaid, 0);
            const totalKm = paidCycles.reduce((s, c) => s + c.kmDriven, 0);
            document.getElementById('cost-per-km').innerText = `$${(totalCost / totalKm).toFixed(2)}`;
        } else {
            document.getElementById('cost-per-km').innerText = `$${(24.5 / this.state.efficiency).toFixed(2)} est.`;
        }

        if (this.state.parkedCoords?.time) {
            document.getElementById('footer-parked-status').innerText = `PIN: ${this.state.parkedCoords.time}`;
        }

        const banner = document.getElementById('alert-banner');
        if (pct <= 15) {
            banner.style.display = 'flex'; banner.innerText = `🚨 RESERVA CRÍTICA: ${this.state.currentFuel.toFixed(1)} L`;
            if (!this.state.criticalFuelAlerted) { this.triggerAlert(`Oye Mario, estamos en reserva crítica. Quedan solo ${Math.round(this.state.currentFuel)} litros.`, true); this.state.criticalFuelAlerted = true; }
        } else if (pct <= 25) {
            banner.style.display = 'flex'; banner.innerText = `⚠️ NIVEL BAJO: ${this.state.currentFuel.toFixed(1)} L`;
            if (!this.state.lowFuelAlerted) { this.triggerAlert(`Aviso de cabina: nivel bajo de gasolina, nos quedan ${Math.round(this.state.currentFuel)} litros.`, false); this.state.lowFuelAlerted = true; }
        } else { banner.style.display = 'none'; this.state.lowFuelAlerted = false; this.state.criticalFuelAlerted = false; }
    },

    haversine(lat1, lon1, lat2, lon2) {
        const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2)**2;
        return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
    }
};

window.onload = () => App.init();