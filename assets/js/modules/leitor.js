// leitor.js — controle de presença com detecção de atraso

// ===================== LIMITES DE ATRASO POR TURNO =====================
const LIMITES_ATRASO = {
    "Manhã": 7 * 60 + 45,   // 07:45
    "Tarde": 13 * 60 + 15,  // 13:15
    "Noite": 19 * 60 + 15   // 19:15
}

function calcularStatus(turnoAluno) {
    const agora = new Date()
    const minutosAgora = agora.getHours() * 60 + agora.getMinutes()
    const limite = LIMITES_ATRASO[turnoAluno]
    if (limite === undefined) return "presente"
    return minutosAgora <= limite ? "presente" : "atrasado"
}

// ===================== DATA / RELÓGIO =====================
function _atualizarRelogio() {
    const el = document.getElementById("relogioChip")
    if (el) el.textContent = new Date().toLocaleTimeString("pt-BR", {
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    })
}

// IIFE movida para dentro do DOMContentLoaded — evita rodar antes do DOM
function _iniciarInfo() {
    const hoje = new Date()
    const opts = { weekday: "long", day: "numeric", month: "long", year: "numeric" }
    const str  = hoje.toLocaleDateString("pt-BR", opts)
    const dataEl = document.getElementById("dataHoje")
    if (dataEl) dataEl.textContent = str.charAt(0).toUpperCase() + str.slice(1)

    _atualizarRelogio()
    setInterval(_atualizarRelogio, 1000)
}

// ===================== TURNO =====================
function _atualizarTurnoBanner() {
    const turno  = turnoAtual()          // alias de config.js
    const banner = document.getElementById("turnoBanner")
    const txt    = document.getElementById("turnoTxt")
    const stat   = document.getElementById("turnoAtualStat")

    if (!banner || !txt || !stat) return

    if (turno) {
        banner.className = "turno-banner"
        txt.textContent  = `Turno ativo: ${turno.nome}`
        stat.textContent = turno.nome
    } else {
        banner.className = "turno-banner fora"
        txt.textContent  = "Fora do horário de aulas"
        stat.textContent = "—"
    }
}

function _chaveUltimoTurno() {
    return `turno_limpo_${new Date().toISOString().split("T")[0]}`
}

async function _verificarTrocaTurno() {
    _atualizarTurnoBanner()

    const m      = minutosDoDia()     // alias de config.js
    const viradas = [13 * 60, 18 * 60, 24 * 60]

    for (const virada of viradas) {
        if (m >= virada && m < virada + 1) {
            const chave = _chaveUltimoTurno() + "_" + virada
            if (!localStorage.getItem(chave)) {
                localStorage.setItem(chave, "1")
                await _limparPresencasTurnoAnterior(virada)
            }
        }
    }
}

async function _limparPresencasTurnoAnterior(virada) {
    // Usa os mesmos limites do TURNOS de config.js para consistência
    const turno = TURNOS.find(t => t.fim === virada)
    if (!turno) return

    // intervaloPorTurno é alias de config.js (Time.intervalo)
    const intervalo = intervaloPorTurno(turno)
    if (!intervalo) return

    try {
        const { error } = await db
            .from("presencas")
            .delete()
            .gte("horario_chegada", intervalo.inicio)
            .lte("horario_chegada", intervalo.fim)

        if (!error) {
            Notif.info(`Turno ${turno.nome} encerrado`, "Lista de presença foi limpa automaticamente.")
            carregarPresencas()
        }
    } catch (err) {
        console.error("Erro ao limpar presenças do turno:", err)
    }
}

// ===================== MODAL =====================
// Timer encapsulado — sem vazamento para window
let _modalTimer = null

function mostrarModal({ tipo, nome, turma, turno, status }) {
    const cfg = {
        sucesso:   {
            icon:  status === "atrasado" ? "⚠" : "✓",
            texto: status === "atrasado" ? "Presença registrada — Atrasado!" : "Presença registrada!"
        },
        duplicado: { icon: "!", texto: "Já registrado neste turno." },
        erro:      { icon: "✕", texto: "Aluno não encontrado." }
    }
    const c = cfg[tipo] || cfg.erro

    // "atrasado" como variante visual do sucesso
    const iconClass = (tipo === "sucesso" && status === "atrasado") ? "atrasado" : tipo

    const iconEl  = document.getElementById("modalIcon")
    const nomeEl  = document.getElementById("modalNome")
    const infoEl  = document.getElementById("modalInfo")
    const badgeEl = document.getElementById("modalBadge")
    const overlay = document.getElementById("modalOverlay")

    if (!iconEl || !nomeEl || !infoEl || !badgeEl || !overlay) return

    iconEl.className  = `modal-icon ${iconClass}`
    iconEl.textContent = c.icon
    nomeEl.textContent = nome || "—"
    nomeEl.className   = `modal-title ${tipo === "sucesso" ? (status === "atrasado" ? "nome-atrasado" : "nome-presente") : ""}`
    infoEl.textContent = turma ? `Turma: ${turma} — ${turno}` : ""
    badgeEl.className  = `modal-badge ${iconClass}`
    badgeEl.textContent = c.texto
    overlay.style.display = "flex"

    clearTimeout(_modalTimer)
    _modalTimer = setTimeout(() => {
        const o = document.getElementById("modalOverlay")
        if (o) o.style.display = "none"
    }, 4000)
}

function _fecharModal() {
    const o = document.getElementById("modalOverlay")
    if (o) o.style.display = "none"
    clearTimeout(_modalTimer)
}

// ===================== PRESENÇAS =====================
function _formatarHora(iso) {
    return new Date(iso).toLocaleTimeString("pt-BR", {
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    })
}

async function carregarPresencas() {
    const turno     = turnoAtual()
    const tbody     = document.getElementById("listaPresencas")
    const totalEl   = document.getElementById("totalPresentes")
    const ultimaEl  = document.getElementById("ultimaEntrada")
    const atrasEl   = document.getElementById("totalAtrasados")

    if (!tbody) return

    if (!turno) {
        tbody.innerHTML = `<tr><td colspan="4">
            <div class="empty"><div class="empty-icon">🌙</div><p>Fora do horário de aulas.</p></div>
        </td></tr>`
        if (totalEl)  totalEl.textContent  = "—"
        if (ultimaEl) ultimaEl.textContent = "—"
        if (atrasEl)  atrasEl.textContent  = "—"
        return
    }

    const { inicio, fim } = intervaloPorTurno(turno)

    try {
        const { data, error } = await db
            .from("presencas")
            .select("id, horario_chegada, status, alunos(nome, turma, turno)")
            .gte("horario_chegada", inicio)
            .lte("horario_chegada", fim)
            .order("horario_chegada", { ascending: false })

        if (error) throw error

        const lista     = data || []
        const total     = lista.length
        const atrasados = lista.filter(p => p.status === "atrasado").length

        if (totalEl)  totalEl.textContent  = total
        if (atrasEl)  atrasEl.textContent  = atrasados
        if (ultimaEl) ultimaEl.textContent = lista.length ? _formatarHora(lista[0].horario_chegada) : "—"

        if (!lista.length) {
            tbody.innerHTML = `<tr><td colspan="4">
                <div class="empty"><div class="empty-icon">📋</div><p>Nenhuma presença ainda.</p></div>
            </td></tr>`
            return
        }

        tbody.innerHTML = lista.map((p, i) => {
            const a          = p.alunos
            const isAtrasado = p.status === "atrasado"
            const tc = a?.turno === "Manhã" ? "badge-verde"
                     : a?.turno === "Tarde" ? "badge-amarelo"
                     : a?.turno === "Noite" ? "badge-noite"
                     : "badge-cinza"

            return `
            <tr class="${i === 0 ? "entrada-nova" : ""} ${isAtrasado ? "linha-atrasado" : "linha-presente"}">
                <td>
                    <strong class="${isAtrasado ? "nome-atrasado" : "nome-presente"}">${_escHtml(a?.nome ?? "—")}</strong>
                    ${isAtrasado ? `<span class="tag-atraso">Atrasado</span>` : ""}
                </td>
                <td>${a?.turma ? `<span class="badge ${tc}">${_escHtml(a.turma)}</span>` : "—"}</td>
                <td><span class="horario-chip">${_formatarHora(p.horario_chegada)}</span></td>
                <td>
                    <span class="status-chip ${isAtrasado ? "status-atrasado" : "status-presente"}">
                        ${isAtrasado ? "⚠ Atrasado" : "✓ Presente"}
                    </span>
                </td>
            </tr>`
        }).join("")

    } catch (err) {
        console.error(err)
        Notif.erro("Erro ao carregar presenças", err.message)
    }
}

// ===================== REGISTRAR =====================
let _ultimoId    = null
let _registrando = false

async function onScanSuccess(texto) {
    if (_registrando) return

    let id = null

    try {
        const url = new URL(texto)
        id = url.searchParams.get("id")
    } catch { /* não é uma URL válida */ }

    if (!id) {
        const m = texto.match(/ID[:\s]+(\S+)/i)
        if (m) id = m[1]
    }

    if (!id) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (uuidRegex.test(texto.trim())) id = texto.trim()
    }

    if (!id) { console.warn("QR lido mas ID não encontrado:", texto); return }
    if (id === _ultimoId) return

    _registrando = true
    const ok = await _registrar(id)
    _registrando = false

    if (ok) {
        _ultimoId = id
        setTimeout(() => { _ultimoId = null }, 5000)
    }
}

async function _registrar(id) {
    try {
        const { data: aluno, error: errAluno } = await db
            .from("alunos")
            .select("id, nome, turma, turno")
            .eq("id", id)
            .single()

        if (errAluno || !aluno) {
            mostrarModal({ tipo: "erro" })
            Notif.erro("Aluno não encontrado", "ID não corresponde a nenhum aluno.")
            ScannerVisual.confirm("erro")
            return false
        }

        const hoje = new Date().toISOString().split("T")[0]

        const { data: existe } = await db
            .from("presencas")
            .select("id")
            .eq("aluno_id", id)
            .gte("horario_chegada", hoje + "T00:00:00")
            .lte("horario_chegada", hoje + "T23:59:59")

        if (existe && existe.length > 0) {
            mostrarModal({ tipo: "duplicado", nome: aluno.nome, turma: aluno.turma, turno: aluno.turno })
            ScannerVisual.confirm("duplicado")
            return false
        }

        const status = calcularStatus(aluno.turno)

        const { error: errIns } = await db
            .from("presencas")
            .insert([{ aluno_id: id, status }])

        if (errIns) throw errIns

        mostrarModal({ tipo: "sucesso", nome: aluno.nome, turma: aluno.turma, turno: aluno.turno, status })
        ScannerVisual.confirm(status)

        if (status === "atrasado") {
            Notif.aviso(`${aluno.nome} — Atrasado`, `Chegou após o limite do turno ${aluno.turno}.`)
        } else {
            Notif.sucesso("Presença registrada", `${aluno.nome} chegou no horário.`)
        }

        carregarPresencas()
        return true

    } catch (err) {
        console.error(err)
        Notif.erro("Erro ao registrar presença", err.message)
        mostrarModal({ tipo: "erro" })
        ScannerVisual.confirm("erro")
        return false
    }
}

// ===================== RELATÓRIO =====================
async function gerarRelatorioPresencas() {
    if (!window.jspdf) {
        Notif.erro("jsPDF não carregado", "Adicione a biblioteca jsPDF ao projeto.")
        return
    }

    const turno = turnoAtual()
    Notif.info("Gerando relatório...", "Aguarde.")

    try {
        let query = db
            .from("presencas")
            .select("horario_chegada, status, alunos(nome, turma, turno)")
            .order("horario_chegada", { ascending: true })

        if (turno) {
            const { inicio, fim } = intervaloPorTurno(turno)
            query = query.gte("horario_chegada", inicio).lte("horario_chegada", fim)
        } else {
            const hoje = new Date().toISOString().split("T")[0]
            query = query
                .gte("horario_chegada", hoje + "T00:00:00")
                .lte("horario_chegada", hoje + "T23:59:59")
        }

        const { data, error } = await query
        if (error) throw error

        const { jsPDF } = window.jspdf
        const doc      = new jsPDF()
        const dataFmt  = new Date().toLocaleDateString("pt-BR")
        const lista    = data || []
        const atrasados = lista.filter(p => p.status === "atrasado").length

        doc.setFontSize(16)
        doc.text("Relatório de Presenças", 20, 20)
        doc.setFontSize(10)
        doc.text(
            `Data: ${dataFmt}  |  Turno: ${turno?.nome ?? "Todos"}  |  Total: ${lista.length}  |  Atrasos: ${atrasados}`,
            20, 30
        )

        let y = 44
        doc.setFont(undefined, "bold")
        doc.text("Nome", 20, y); doc.text("Turma", 90, y)
        doc.text("Horário", 140, y); doc.text("Status", 170, y)
        y += 5; doc.line(20, y, 195, y); y += 7
        doc.setFont(undefined, "normal")

        lista.forEach(p => {
            const a    = p.alunos
            const hora = new Date(p.horario_chegada).toLocaleTimeString("pt-BR", {
                hour: "2-digit", minute: "2-digit"
            })
            doc.setFontSize(9)
            doc.text(String(a?.nome ?? "—").substring(0, 32), 20, y)
            doc.text(String(a?.turma ?? "—"), 90, y)
            doc.text(hora, 140, y)
            doc.text(p.status === "atrasado" ? "Atrasado" : "Presente", 170, y)
            y += 7
            if (y > 280) { doc.addPage(); y = 20 }
        })

        const hoje = new Date().toISOString().split("T")[0]
        doc.save(`presencas_${hoje}_${turno?.nome ?? "geral"}.pdf`)
        Notif.sucesso("Relatório gerado!", `${lista.length} presença(s), ${atrasados} atraso(s).`)

    } catch (err) {
        Notif.erro("Erro ao gerar relatório", err.message)
    }
}

// ===================== CÂMERA =====================
let _html5QrCode = null

async function iniciarCamera() {
    const statusEl = document.getElementById("scannerStatus")
    // Corrigido: era "btnIniciar" — o HTML usa "btnStartCamera"
    const btn      = document.getElementById("btnStartCamera")
    const idle     = document.getElementById("scannerIdle")
    const wrap     = document.getElementById("scannerWrap")

    if (!btn) return

    btn.disabled = true
    if (statusEl) {
        statusEl.className   = "scanner-status"
        statusEl.textContent = "Solicitando permissão..."
    }

    try {
        // Verifica permissão antecipadamente para dar feedback imediato
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        stream.getTracks().forEach(t => t.stop())

        if (statusEl) {
            statusEl.className   = "scanner-status ok"
            statusEl.textContent = "✅ Câmera ativa — aponte para o QR Code"
        }

        _html5QrCode = new Html5Qrcode("reader")

        await _html5QrCode.start(
            { facingMode: "environment" },
            {
                fps: 20,
                qrbox: (w, h) => {
                    const s = Math.floor(Math.min(w, h) * 0.75)
                    return { width: s, height: s }
                },
                aspectRatio: 1.0,
                experimentalFeatures: { useBarCodeDetectorIfSupported: true }
            },
            // onScanSuccess alimenta o visual manualmente
                async (texto, result) => {
                    const box = result?.result?.points
                        ? _converterBox(result.result.points)
                        : null

                    ScannerVisual.update(box)
                    await onScanSuccess(texto)
                },
                () => {
                    ScannerVisual.update(null)
                }
        )

        // Conecta o ScannerVisual ao vídeo gerado pelo html5-qrcode
        const video  = document.querySelector("#reader video")
        const canvas = document.getElementById("scannerCanvas")
        if (video && canvas) {
            ScannerVisual.init(video, canvas)
        }

        if (wrap)  wrap.classList.add("ativo")
        if (idle)  idle.style.display = "none"
        btn.style.display = "none"

        Notif.sucesso("Câmera ativa", "Aponte o QR Code do aluno para a câmera.")

    } catch (err) {
        if (statusEl) {
            statusEl.className = "scanner-status erro"
            if (err.name === "NotAllowedError")
                statusEl.textContent = "❌ Permissão negada. Habilite a câmera nas configurações."
            else if (err.name === "NotFoundError")
                statusEl.textContent = "❌ Câmera não encontrada."
            else
                statusEl.textContent = "❌ " + (err.message || "Erro desconhecido.")

            Notif.erro("Erro na câmera", statusEl.textContent.replace("❌ ", ""))
        }
        btn.disabled = false
    }
}

function _converterBox(points) {
    if (!points || points.length < 4) return null

    const xs = points.map(p => p.x)
    const ys = points.map(p => p.y)

    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const maxX = Math.max(...xs)
    const maxY = Math.max(...ys)

    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    }
}

// ===================== EXPORT =====================
// Exporta carregarPresencas para uso em _limparPresencasTurnoAnterior
// (referência circular necessária — mantida intencional)

// ===================== HELPERS =====================
function _escHtml(str) {
    return String(str ?? "—")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

// ===================== INICIAR =====================
document.addEventListener("DOMContentLoaded", () => {
    _iniciarInfo()
    _atualizarTurnoBanner()
    carregarPresencas()
    _verificarTrocaTurno()

    setInterval(_verificarTrocaTurno, 60 * 1000)

    // Botão da câmera
    const btnCamera = document.getElementById("btnStartCamera")
    if (btnCamera) btnCamera.onclick = iniciarCamera

    // Botão exportar
    const btnExportar = document.getElementById("btnExportar")
    if (btnExportar) btnExportar.onclick = gerarRelatorioPresencas

    // Botão atualizar lista
    const btnRefresh = document.getElementById("btnRefresh")
    if (btnRefresh) btnRefresh.onclick = carregarPresencas

    // Modal: fechar ao clicar fora ou no botão
    const overlay = document.getElementById("modalOverlay")
    if (overlay) overlay.addEventListener("click", e => {
        if (e.target.id === "modalOverlay") _fecharModal()
    })

    const modalClose = document.getElementById("modalClose")
    if (modalClose) modalClose.onclick = _fecharModal
})