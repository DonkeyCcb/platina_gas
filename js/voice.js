/* ==========================================================================
   PLATINA · Voz del asistente
   1) Voz neuronal Gemini (si hay API key y red), con caché local en IndexedDB:
      las frases repetidas suenan al instante y también sin conexión.
   2) Respaldo: mejor voz en español instalada en el dispositivo, elegida por
      calidad (Natural/Neural/Premium > Google > básicas) y leída frase por frase
      para que tenga pausas naturales.
   ========================================================================== */
const Voice = {
    GEMINI_MODELS: ['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts'],
    GEMINI_VOICES: [
        ['Aoede', 'Aoede · femenina, ligera y cálida'],
        ['Kore', 'Kore · femenina, firme y clara'],
        ['Leda', 'Leda · femenina, juvenil'],
        ['Zephyr', 'Zephyr · femenina, brillante'],
        ['Puck', 'Puck · masculina, animada'],
        ['Charon', 'Charon · masculina, informativa'],
        ['Orus', 'Orus · masculina, firme'],
        ['Fenrir', 'Fenrir · masculina, enérgica']
    ],
    CACHE_LIMIT: 60,
    TIMEOUT_MS: 8000,

    prefs: { localVoice: 'auto', rate: 1.0 },
    ctx: null, source: null, _token: 0, _dbp: null, _voicesP: null,

    /* ---------- Preferencias (por dispositivo, no se sincronizan) ---------- */
    init() {
        try { Object.assign(this.prefs, JSON.parse(localStorage.getItem('platina_voice_prefs') || '{}')); } catch (e) {}
        if ('speechSynthesis' in window) {
            speechSynthesis.addEventListener?.('voiceschanged', () => { this._voicesP = null; });
            this.voices();
        }
    },
    savePrefs(p) {
        Object.assign(this.prefs, p);
        try { localStorage.setItem('platina_voice_prefs', JSON.stringify(this.prefs)); } catch (e) {}
    },

    /* ---------- Audio base ---------- */
    unlock() {
        if (!this.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) this.ctx = new Ctx();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
    },

    beep(type = 'normal') {
        try {
            const ctx = this.unlock(); if (!ctx) return;
            const now = ctx.currentTime;
            const freqs = type === 'critical' ? [880, 880, 880] : [660, 880];
            freqs.forEach((f, i) => {
                const t = now + i * 0.17;
                const osc = ctx.createOscillator(), g = ctx.createGain();
                osc.type = type === 'critical' ? 'triangle' : 'sine';
                osc.frequency.setValueAtTime(f, t);
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
                osc.connect(g); g.connect(ctx.destination);
                osc.start(t); osc.stop(t + 0.16);
            });
        } catch (e) {}
    },

    stop() {
        this._token++;
        try { this.source?.stop(); } catch (e) {}
        this.source = null;
        if ('speechSynthesis' in window) speechSynthesis.cancel();
    },

    /* ---------- API principal ---------- */
    // opts: { critical, apiKey, geminiVoice, silentBeep }
    async speak(text, opts = {}) {
        this.stop();
        const token = this._token;
        if (!opts.silentBeep) this.beep(opts.critical ? 'critical' : 'normal');

        const useGemini = opts.apiKey && opts.geminiVoice && opts.geminiVoice !== 'local';
        if (useGemini) {
            const pcm = await this._neural(text, opts);
            if (token !== this._token) return 'cancelled';
            if (pcm) { this._playPcm(pcm); return 'gemini'; }
        }
        if (token !== this._token) return 'cancelled';
        await this._speakLocal(text, token);
        return 'local';
    },

    /* ---------- Gemini + caché ---------- */
    async _neural(text, opts) {
        const key = `${opts.geminiVoice}|${opts.critical ? 'c' : 'n'}|${text}`;
        const cached = await this._cacheGet(key);
        if (cached) return cached;
        if (!navigator.onLine) return null;

        const tone = opts.critical
            ? 'con tono firme, claro y sereno, sin dramatismo'
            : 'con tono natural, cálido y amable, como una copiloto de confianza';
        const prompt = `Habla en español de México, ${tone}, con ritmo conversacional y pausas breves entre frases. Di exactamente este texto, sin añadir nada:\n\n${text}`;
        const body = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.geminiVoice } } }
            }
        });

        let models = [...this.GEMINI_MODELS];
        const remembered = localStorage.getItem('platina_tts_model');
        if (remembered) models = [remembered, ...models.filter(m => m !== remembered)];

        for (const model of models) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), this.TIMEOUT_MS);
            try {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                    method: 'POST', signal: ctrl.signal,
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
                    body
                });
                if (!res.ok) { if (res.status === 404) continue; return null; }   // 404 = modelo no disponible: probar el siguiente
                const data = await res.json();
                const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
                if (!part) return null;
                const rate = parseInt((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1] || '24000', 10);
                const pcm = { rate, samples: this._b64ToInt16(part.inlineData.data) };
                localStorage.setItem('platina_tts_model', model);
                this._cachePut(key, pcm);
                return pcm;
            } catch (e) { return null; }
            finally { clearTimeout(timer); }
        }
        return null;
    },

    _b64ToInt16(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length - (bin.length % 2));
        for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Int16Array(bytes.buffer);
    },

    _playPcm({ rate, samples }) {
        const ctx = this.unlock(); if (!ctx) return;
        const buf = ctx.createBuffer(1, samples.length, rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
        const src = ctx.createBufferSource(), g = ctx.createGain();
        const t = ctx.currentTime + 0.05, dur = buf.duration;
        g.gain.setValueAtTime(0.0001, t);                       // entrada/salida suaves: sin "clics"
        g.gain.linearRampToValueAtTime(1, t + 0.03);
        g.gain.setValueAtTime(1, Math.max(t + 0.03, t + dur - 0.08));
        g.gain.linearRampToValueAtTime(0.0001, t + dur);
        src.buffer = buf; src.connect(g); g.connect(ctx.destination);
        src.start(t);
        this.source = src;
    },

    /* ---------- Caché IndexedDB ---------- */
    _db() {
        if (!this._dbp) {
            this._dbp = new Promise((res, rej) => {
                if (!('indexedDB' in window)) return rej();
                const r = indexedDB.open('platina-voice', 1);
                r.onupgradeneeded = () => r.result.createObjectStore('pcm');
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
        }
        return this._dbp;
    },
    async _cacheGet(key) {
        try {
            const db = await this._db();
            return await new Promise(res => {
                const q = db.transaction('pcm').objectStore('pcm').get(key);
                q.onsuccess = () => res(q.result ? { rate: q.result.rate, samples: new Int16Array(q.result.buf) } : null);
                q.onerror = () => res(null);
            });
        } catch (e) { return null; }
    },
    async _cachePut(key, pcm) {
        try {
            const db = await this._db();
            db.transaction('pcm', 'readwrite').objectStore('pcm').put({ rate: pcm.rate, buf: pcm.samples.buffer, ts: Date.now() }, key);
            this._prune(db);
        } catch (e) {}
    },
    _prune(db) {
        const st = db.transaction('pcm', 'readwrite').objectStore('pcm'), items = [];
        st.openCursor().onsuccess = e => {
            const c = e.target.result;
            if (c) { items.push({ k: c.key, ts: c.value.ts }); c.continue(); return; }
            items.sort((x, y) => x.ts - y.ts).slice(0, Math.max(0, items.length - this.CACHE_LIMIT)).forEach(x => st.delete(x.k));
        };
    },

    /* ---------- Voz local ---------- */
    voices() {
        if (!('speechSynthesis' in window)) return Promise.resolve([]);
        if (!this._voicesP) {
            this._voicesP = new Promise(res => {
                const have = speechSynthesis.getVoices();
                if (have.length) return res(have);
                const done = () => res(speechSynthesis.getVoices());
                speechSynthesis.addEventListener?.('voiceschanged', done, { once: true });
                setTimeout(done, 1500);
            });
        }
        return this._voicesP;
    },

    // Puntaje de calidad: más alto = suena mejor
    score(v) {
        const n = v.name || '', l = (v.lang || '').replace('_', '-').toLowerCase();
        if (!l.startsWith('es')) return -1;
        let s = 0;
        if (/natural|neural|online/i.test(n)) s += 60;                       // Microsoft Edge/Windows (Dalia, Jorge…)
        if (/premium|enhanced|mejorad|siri/i.test(n)) s += 45;               // iOS / macOS
        if (/google/i.test(n)) s += 30;                                      // Chrome / Android
        if (/paulina|dalia|jorge|angélica|angelica|sabina|juan|mónica|monica|luciana|diego/i.test(n)) s += 12;
        if (l === 'es-mx') s += 30; else if (l === 'es-us' || l === 'es-419') s += 18; else if (l === 'es-es') s += 6;
        if (/compact|espeak|robot|novelty/i.test(n)) s -= 40;
        return s;
    },
    async localList() {
        const vs = await this.voices();
        return vs.filter(v => this.score(v) >= 0).sort((a, b) => this.score(b) - this.score(a));
    },
    async pickVoice(preferredURI) {
        const list = await this.localList();
        if (preferredURI && preferredURI !== 'auto') {
            const m = list.find(v => v.voiceURI === preferredURI);
            if (m) return m;
        }
        return list[0] || null;
    },

    // Números decimales dichos como una persona: 12.7 → "12 punto 7"
    _prepLocal(text) {
        return text.replace(/(\d)\.(\d)/g, '$1 punto $2').replace(/\bkm\b/gi, 'kilómetros').replace(/\bL\b/g, 'litros');
    },

    async _speakLocal(text, token, over = {}) {
        if (!('speechSynthesis' in window)) return;
        const voice = await this.pickVoice(over.localVoice ?? this.prefs.localVoice);
        if (token !== this._token) return;
        speechSynthesis.cancel();
        const rate = over.rate ?? this.prefs.rate ?? 1;
        const parts = this._prepLocal(text).match(/[^.!?¡¿]+[.!?]*/g) || [text];
        await new Promise(r => setTimeout(r, 250));                           // deja respirar el pitido
        if (token !== this._token) return;
        parts.map(s => s.trim()).filter(Boolean).forEach(s => {
            const u = new SpeechSynthesisUtterance(s);
            if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'es-MX'; }
            u.rate = rate; u.pitch = 1; u.volume = 1;
            speechSynthesis.speak(u);
        });
    },

    // Para la vista previa de ajustes sin guardar
    async previewLocal(text, over) {
        this.stop(); const token = this._token;
        await this._speakLocal(text, token, over);
    }
};
Voice.init();
