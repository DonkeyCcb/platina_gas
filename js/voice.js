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
                if (vBadge) vBadge.innerText = `🎙️ Conectando IA...`;
                const directorPrompt = `Lee en español de México con tono cálido, natural y expresivo de asistente moderno: ${text}`;

                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${state.geminiApiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: directorPrompt }] }],
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: { voiceName: state.aiVoice || "Aoede" }
                                }
                            }
                        }
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    const part = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
                    if (part?.data) {
                        if (vBadge) vBadge.innerText = `🎙️ IA (${state.aiVoice})`;
                        this.playRawPcmAsWav(part.data, 24000, onEndCallback);
                        return;
                    }
                } else {
                    const errInfo = await res.json().catch(() => ({}));
                    console.warn("Gemini TTS error:", res.status, errInfo);
                }
            } catch (e) {
                console.warn("Error red Gemini TTS:", e);
            }
        }

        if (vBadge) vBadge.innerText = !state.geminiApiKey ? `🔊 Local (Sin Key)` : `🔊 Voz Natural Local`;
        this.speakLocalModern(text, onEndCallback);
    },

    // Empaqueta PCM 16-bit en un contenedor WAV válido para iOS Safari y Android Chrome
    playRawPcmAsWav(base64Pcm, sampleRate = 24000, onEndCallback) {
        try {
            const binary = atob(base64Pcm);
            const pcmLen = binary.length;
            const wavBuffer = new ArrayBuffer(44 + pcmLen);
            const view = new DataView(wavBuffer);

            const writeStr = (offset, str) => {
                for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
            };

            writeStr(0, 'RIFF');
            view.setUint32(4, 36 + pcmLen, true);
            writeStr(8, 'WAVE');
            writeStr(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true); // PCM
            view.setUint16(22, 1, true); // Mono
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            writeStr(36, 'data');
            view.setUint32(40, pcmLen, true);

            for (let i = 0; i < pcmLen; i++) {
                view.setUint8(44 + i, binary.charCodeAt(i));
            }

            const blob = new Blob([wavBuffer], { type: 'audio/wav' });
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.onended = () => {
                URL.revokeObjectURL(url);
                if (onEndCallback) onEndCallback();
            };
            audio.play().catch(() => this.speakLocalModern("", onEndCallback));
        } catch (e) {
            if (onEndCallback) onEndCallback();
        }
    },

    // Selector inteligente de la voz más moderna/neuronal instalada en el dispositivo
    speakLocalModern(text, onEndCallback) {
        if (!text || !('speechSynthesis' in window)) { if (onEndCallback) onEndCallback(); return; }
        window.speechSynthesis.cancel();

        const utter = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();

        // Ranking de voces modernas en iOS (Enhanced/Premium/Paulina/Mónica) y Android (Google Network/Natural)
        const rankedVoice =
            voices.find(v => v.lang.includes('es') && /Enhanced|Premium|Natural|Neural/i.test(v.name)) ||
            voices.find(v => v.lang === 'es-MX' && /Paulina|Google/i.test(v.name)) ||
            voices.find(v => v.lang.includes('es') && /Monica|Mónica|Sabina|Helena|Google español/i.test(v.name)) ||
            voices.find(v => v.lang === 'es-MX') ||
            voices.find(v => v.lang.startsWith('es'));

        if (rankedVoice) utter.voice = rankedVoice;
        utter.lang = 'es-MX';
        utter.rate = 0.98;  // Ritmo pausado y natural
        utter.pitch = 1.03; // Entonación cálida
        utter.onend = () => { if (onEndCallback) onEndCallback(); };
        setTimeout(() => window.speechSynthesis.speak(utter), 300);
    }
};