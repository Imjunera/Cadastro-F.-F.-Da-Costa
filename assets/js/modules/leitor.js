// leitor.js — controle de presença com detecção de atraso
// Refatorado: validação de turno fail-fast, extração segura de bounding box,
// callback não-bloqueante, pipeline de registro corrigido.

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
    const turno  = turnoAtual()
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

    const m       = minutosDoDia()
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
    const turno = TURNOS.find(t => t.fim === virada)
    if (!turno) return

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
let _modalTimer = null

/**
 * @param {{ tipo: string, nome?: string, turma?: string, turno?: string, status?: string, texto?: string }} opts
 * `texto` substitui a mensagem padrão do tipo quando fornecido.
 */
function mostrarModal({ tipo, nome, turma, turno, status, texto }) {
    const cfg = {
        sucesso:   {
            icon:  status === "atrasado" ? "⚠" : "✓",
            texto: status === "atrasado" ? "Presença registrada — Atrasado!" : "Presença registrada!"
        },
        duplicado: { icon: "!", texto: "Já registrado neste turno."   },
        turno:     { icon: "⊘", texto: "Turno incorreto."            },
        erro:      { icon: "✕", texto: texto ?? "Aluno não encontrado." }
    }
    const c = cfg[tipo] ?? cfg.erro

    // Variante visual: "atrasado" herda aparência de "sucesso"
    const iconClass = (tipo === "sucesso" && status === "atrasado") ? "atrasado" : tipo

    const iconEl  = document.getElementById("modalIcon")
    const nomeEl  = document.getElementById("modalNome")
    const infoEl  = document.getElementById("modalInfo")
    const badgeEl = document.getElementById("modalBadge")
    const overlay = document.getElementById("modalOverlay")

    if (!iconEl || !nomeEl || !infoEl || !badgeEl || !overlay) return

    iconEl.className   = `modal-icon ${iconClass}`
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
    const turno    = turnoAtual()
    const tbody    = document.getElementById("listaPresencas")
    const totalEl  = document.getElementById("totalPresentes")
    const ultimaEl = document.getElementById("ultimaEntrada")
    const atrasEl  = document.getElementById("totalAtrasados")

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

/**
 * Extrai o ID do aluno de múltiplos formatos de QR suportados:
 *   - URL com query param `id`
 *   - Prefixo "ID: <valor>"
 *   - UUID puro
 * Retorna null se nenhum formato for reconhecido.
 * @param {string} texto
 * @returns {string|null}
 */
function _extrairId(texto) {
    if (typeof texto !== "string" || !texto.trim()) return null

    // 1. URL com ?id=
    try {
        const url = new URL(texto.trim())
        const id  = url.searchParams.get("id")
        if (id) return id
    } catch { /* não é URL */ }

    // 2. Prefixo "ID: <valor>"
    const mPrefixo = texto.match(/ID[:\s]+(\S+)/i)
    if (mPrefixo) return mPrefixo[1]

    // 3. UUID puro
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (UUID.test(texto.trim())) return texto.trim()

    return null
}

async function onScanSuccess(texto) {
    if (_registrando) return

    const id = _extrairId(texto)

    if (!id) return
    if (id === _ultimoId) return

    _registrando = true
    try {
        const ok = await _registrar(id)
        if (ok) {
            _ultimoId = id
            setTimeout(() => { _ultimoId = null }, 5000)
        }
    } finally {
        _registrando = false
    }
}

/**
 * Pipeline de registro estrito:
 *   1. Busca aluno
 *   2. Valida turno (fail-fast — bloqueia tudo se incorreto)
 *   3. Verifica duplicata dentro do turno ativo
 *   4. Insere presença
 *
 * @param {string} id UUID do aluno
 * @returns {Promise<boolean>}
 */
async function _registrar(id) {
    try {
        // ── Passo 1: Buscar aluno ──────────────────────────────────────────────
        const { data: aluno, error: errAluno } = await db
            .from("alunos")
            .select("id, nome, turma, turno")
            .eq("id", id)
            .single()

        if (errAluno || !aluno) {
            mostrarModal({ tipo: "erro" })
            Notif.erro("Aluno não encontrado", "ID não corresponde a nenhum aluno cadastrado.")
            ScannerVisual.confirm("erro")
            return false
        }

        // ── Passo 2: Validação de turno (FAIL-FAST) ───────────────────────────
        // Nenhuma operação adicional ocorre se o turno for inválido.
        const turno = turnoAtual()

        if (!turno) {
            mostrarModal({
                tipo: "erro",
                nome:  aluno.nome,
                turma: aluno.turma,
                turno: aluno.turno,
                texto: "Fora do horário de aulas."
            })
            Notif.aviso("Fora do horário", "Não há turno ativo no momento. Nenhuma presença registrada.")
            ScannerVisual.confirm("erro")
            return false
        }

        if (aluno.turno !== turno.nome) {
            mostrarModal({
                tipo:  "turno",
                nome:  aluno.nome,
                turma: aluno.turma,
                turno: aluno.turno
            })
            Notif.aviso(
                "Turno incorreto",
                `${aluno.nome} pertence ao turno ${aluno.turno}. Turno ativo: ${turno.nome}.`
            )
            ScannerVisual.confirm("erro")
            return false
        }

        // ── Passo 3: Verificar duplicata no turno ativo ────────────────────────
        // Usa intervalo do turno (não o dia inteiro) para consistência com carregarPresencas.
        const { inicio, fim } = intervaloPorTurno(turno)

        const { data: existe, error: errDup } = await db
            .from("presencas")
            .select("id")
            .eq("aluno_id", id)
            .gte("horario_chegada", inicio)
            .lte("horario_chegada", fim)
            .limit(1)

        if (errDup) throw errDup

        if (existe && existe.length > 0) {
            mostrarModal({ tipo: "duplicado", nome: aluno.nome, turma: aluno.turma, turno: aluno.turno })
            ScannerVisual.confirm("duplicado")
            return false
        }

        // ── Passo 4: Inserir presença ──────────────────────────────────────────
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
        console.error("Erro ao registrar presença:", err)
        Notif.erro("Erro ao registrar presença", err.message ?? "Erro desconhecido.")
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
        const doc       = new jsPDF()
        const dataFmt   = new Date().toLocaleDateString("pt-BR")
        const lista     = data || []
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

/**
 * Extrai bounding box normalizada do resultado do html5-qrcode.
 * Tenta múltiplos caminhos conhecidos na estrutura do resultado.
 * Retorna null em qualquer falha — nunca lança exceção.
 *
 * @param {object} decodedResult
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function _extrairBoundingBox(decodedResult) {
    try {
        // html5-qrcode v2.x expõe os pontos em result.result.points
        // Algumas versões colocam em decodedResult diretamente
        const points = (
            decodedResult?.result?.points ??
            decodedResult?.decodedResult?.result?.points ??
            null
        )

        if (!Array.isArray(points) || points.length < 2) return null

        // Aceita tanto {x, y} quanto {X, Y} (variações da API)
        const xs = points.map(p => p?.x ?? p?.X)
        const ys = points.map(p => p?.y ?? p?.Y)

        // Rejeita qualquer ponto não-numérico ou infinito
        if (xs.some(v => typeof v !== "number" || !isFinite(v))) return null
        if (ys.some(v => typeof v !== "number" || !isFinite(v))) return null

        const minX = Math.min(...xs)
        const minY = Math.min(...ys)
        const maxX = Math.max(...xs)
        const maxY = Math.max(...ys)

        const w = maxX - minX
        const h = maxY - minY

        // Caixa degenerada (ponto ou linha) — descarta
        if (w <= 0 || h <= 0) return null

        return { x: minX, y: minY, width: w, height: h }

    } catch {
        // Estrutura inesperada — nunca deve chegar aqui, mas garantimos
        return null
    }
}

/**
 * Aplica constraints avançadas de câmera (foco e exposição contínuos).
 * Degrada graciosamente se o dispositivo não suportar.
 * @param {HTMLVideoElement} videoEl
 */
function _aplicarConstraintsAvancados(videoEl) {
    try {
        const stream = videoEl?.srcObject
        if (!stream || typeof stream.getVideoTracks !== "function") return

        const track = stream.getVideoTracks()[0]
        if (!track || typeof track.applyConstraints !== "function") return

        track.applyConstraints({
            advanced: [
                { focusMode:    "continuous" },
                { exposureMode: "continuous" }
            ]
        }).catch(() => {
            // Browser não suporta — degradação silenciosa intencional
        })
    } catch {
        // getVideoTracks pode não existir em alguns ambientes — ignora
    }
}

async function iniciarCamera() {
    const statusEl = document.getElementById("scannerStatus")
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
        // Verifica permissão de câmera antes de iniciar o html5-qrcode
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
                // 10 FPS: estável, baixo custo de CPU, suficiente para detecção QR
                fps: 10,
                qrbox: (w, h) => {
                    const s = Math.floor(Math.min(w, h) * 0.75)
                    return { width: s, height: s }
                },
                aspectRatio: 1.0,
                experimentalFeatures: { useBarCodeDetectorIfSupported: true }
            },

            // ── Callback de sucesso ──────────────────────────────────────────
            // IMPORTANTE: NÃO usar await aqui — o callback não deve bloquear o
            // render loop do ScannerVisual. onScanSuccess roda em paralelo.
            (decodedText, decodedResult) => {
                const box = _extrairBoundingBox(decodedResult)
                ScannerVisual.update(box)

                // Fire-and-forget: erros capturados internamente em onScanSuccess
                onScanSuccess(decodedText).catch(err => {
                    console.error("onScanSuccess falhou inesperadamente:", err)
                })
            },

            // ── Callback de falha (nenhum QR no frame) ───────────────────────
            () => { ScannerVisual.update(null) }
        )

        // Conecta o ScannerVisual ao elemento de vídeo gerado pelo html5-qrcode
        const video  = document.querySelector("#reader video")
        const canvas = document.getElementById("scannerCanvas")

        if (video && canvas) {
            ScannerVisual.init(video, canvas)
            // Tenta ativar foco/exposição contínuos após o vídeo estar pronto
            _aplicarConstraintsAvancados(video)
        }

        if (wrap)  wrap.classList.add("ativo")
        if (idle)  idle.style.display = "none"
        btn.style.display = "none"

        Notif.sucesso("Câmera ativa", "Aponte o QR Code do aluno para a câmera.")

    } catch (err) {
        btn.disabled = false

        if (!statusEl) return

        let mensagem
        if (err.name === "NotAllowedError") {
            mensagem = "❌ Permissão negada. Habilite a câmera nas configurações."
        } else if (err.name === "NotFoundError") {
            mensagem = "❌ Câmera não encontrada."
        } else {
            mensagem = "❌ " + (err.message || "Erro desconhecido ao acessar a câmera.")
        }

        statusEl.className   = "scanner-status erro"
        statusEl.textContent = mensagem
        Notif.erro("Erro na câmera", mensagem.replace("❌ ", ""))
    }
}

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

    const btnCamera = document.getElementById("btnStartCamera")
    if (btnCamera) btnCamera.onclick = iniciarCamera

    const btnExportar = document.getElementById("btnExportar")
    if (btnExportar) btnExportar.onclick = gerarRelatorioPresencas

    const btnRefresh = document.getElementById("btnRefresh")
    if (btnRefresh) btnRefresh.onclick = carregarPresencas

    const overlay = document.getElementById("modalOverlay")
    if (overlay) overlay.addEventListener("click", e => {
        if (e.target.id === "modalOverlay") _fecharModal()
    })

    const modalClose = document.getElementById("modalClose")
    if (modalClose) modalClose.onclick = _fecharModal
})