// ===================== ENV =====================
const ENV = Object.freeze({
    BASE_URL:     "https://imjunera.github.io/CadastroAlunos",
    SUPABASE_URL: "https://yhfrfziqehannqbfgpaw.supabase.co",
    SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloZnJmemlxZWhhbm5xYmZncGF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3OTMyMDYsImV4cCI6MjA5MTM2OTIwNn0.Uj6JKsH4cKsvAs__xZqOkD9TPf0ntOkCxunFy0TubiY"
})

// ===================== SUPABASE =====================
const db = (() => {
    const { createClient } = window.supabase
    return createClient(ENV.SUPABASE_URL, ENV.SUPABASE_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true
        }
    })
})()

// ===================== TURNOS =====================
const TURNOS = Object.freeze([
    { nome: "Manhã", inicio: 405,  fim: 780  },   // 06:45 – 13:00
    { nome: "Tarde", inicio: 780,  fim: 1080 },   // 13:00 – 18:00
    { nome: "Noite", inicio: 1140, fim: 1440 }    // 19:00 – 24:00
])

// ===================== TIME UTILS =====================
const Time = {

    nowMinutes() {
        const d = new Date()
        return d.getHours() * 60 + d.getMinutes()
    },

    getTurnoAtual() {
        const m = this.nowMinutes()
        return TURNOS.find(t => m >= t.inicio && m < t.fim) || null
    },

    intervalo(turno) {
        if (!turno) return null

        const hoje = new Date().toISOString().split("T")[0]

        return {
            inicio: `${hoje}T${_formatMin(turno.inicio)}`,
            fim: turno.fim === 1440
                ? `${hoje}T23:59:59`
                : `${hoje}T${_formatMin(turno.fim)}`
        }
    }

}

// ===================== ALIASES GLOBAIS =====================
// Estes aliases existem para compatibilidade com leitor.js, registar.html
// e qualquer outro módulo que chame turnoAtual() / intervaloPorTurno()
// diretamente (sem prefixo Time.).
function turnoAtual() {
    return Time.getTurnoAtual()
}

function intervaloPorTurno(turno) {
    return Time.intervalo(turno)
}

function minutosDoDia() {
    return Time.nowMinutes()
}

// ===================== HELPERS (privados) =====================
function _formatMin(min) {
    const h = Math.floor(min / 60)
    const m = min % 60
    return `${_pad(h)}:${_pad(m)}:00`
}

function _pad(n) {
    return String(n).padStart(2, "0")
}

// Aliases legados expostos para retrocompatibilidade (registar.html usa direto)
const formatMin = _formatMin
const pad = _pad