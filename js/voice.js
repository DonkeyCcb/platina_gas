const VoiceEngine = {
    audioCtx: null,

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
            const freqs = type === 'critical' ? [950, 950, 950] : [587.33, 880];
            freqs.forEach((f, i) => {
                const osc = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();
                osc.type = type === 'critical' ? 'square' : 'sine';
                osc.frequency.setValueAtTime(f, now + i * 0.16);
                gain.gain.setValueAtTime(0.25, now + i * 0.16);
                gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.16 + 0.14);
                osc.connect(gain); gain.connect(this.audioCtx.destination);
                osc.start(now + i * 0.16); osc.stop(now + i * 0.16 + 0.15);
            });
        } catch (e) {}
    },

    async speak(text, isCritical, state, onStartCallback, onEndCallback) {
        const vBadge = document.getElementById('voice-engine-badge');
        if (onStartCallback) onStartCallback();
        this.playBeep(isCritical ? 'critical' : 'normal');

        if (navigator.onLine && state.geminiApiKey && state.aiVoice !== 'local') {
            try {
                if (vBadge) vBadge.innerText = `🎙️ IA: ${state.aiVoice}...`;
                const directorPrompt = `Actúa como una copiloto de cabina moderna, cálida, expresiva y carismática de México. Usa entonación conversacional muy natural, ritmo fluido y cero tono robótico para decir exactamente esto: "${text}"`;

                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${state.geminiApiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: directorPrompt }] }],
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: state.aiVoice || "Aoede" } } }
                        }
                    })
                });
                const data = await res.json();
                const pcmBase64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                if (pcmBase64) {
                    if (vBadge) vBadge.innerText = `🎙️ IA Neural (${state.aiVoice})`;
                    this.playPcmAudio(pcmBase64, 24000, onEndCallback);
                    return;
                }
            } catch (e) {}
        }

        if (vBadge) vBadge.innerText = !state.geminiApiKey ? `🔊 Local (Sin API Key)` : `🔊 Voz Local`;
        this.speakLocalEnhanced(text, onEndCallback);
    },

    playPcmAudio(base64, sampleRate = 24000, onEndCallback) {
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
        source.onended = () => { if (onEndCallback) onEndCallback(); };
        source.start();
    },

    speakLocalEnhanced(text, onEndCallback) {
        if (!('speechSynthesis' in window)) { if (onEndCallback) onEndCallback(); return; }
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();
        const preferred = voices.find(v => v.lang.includes('es') && /Natural|Online|Paulina|Monica|Sabina|Google español/i.test(v.name))
                       || voices.find(v => v.lang === 'es-MX') || voices.find(v => v.lang.startsWith('es'));
        if (preferred) utter.voice = preferred;
        utter.lang = 'es-MX'; utter.rate = 1.04; utter.pitch = 1.05;
        utter.onend = () => { if (onEndCallback) onEndCallback(); };
        setTimeout(() => window.speechSynthesis.speak(utter), 350);
    }
};