// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  leitor.js — CÂMERA / SCANNER ADAPTATIVO  (seção substituível)          ║
// ║                                                                          ║
// ║  Integra o ScannerVisual v2 com:                                        ║
// ║    • Extração de bounding box validada (multi-path)                     ║
// ║    • Constraints avançados (foco + exposição contínuos)                 ║
// ║    • Controle de tocha (auto + manual, botão de toggle)                 ║
// ║    • Fallback de câmera frontal quando traseira indisponível            ║
// ║    • Parada segura e reinício                                            ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ===================== EXTRAÇÃO DE BOUNDING BOX =====================
/**
 * Extrai bounding box normalizada do resultado do html5-qrcode.
 *
 * Estrutura do html5-qrcode v2.x:
 *   decodedResult.result.points          ← caminho principal
 *   decodedResult.decodedResult.result.points ← fallback interno
 *
 * Validações aplicadas:
 *   • Array com ≥ 4 pontos (QR Code tem 4 cantos)
 *   • Todos os valores numéricos e finitos
 *   • Caixa não-degenerada (w > 0, h > 0)
 *   • Nunca lança exceção
 *
 * @param {object} decodedResult — segundo argumento do callback onScanSuccess
 * @returns {{ x:number, y:number, width:number, height:number } | null}
 */
function _extrairBoundingBox(decodedResult) {
    try {
        const points =
            decodedResult?.result?.points ??
            decodedResult?.decodedResult?.result?.points ??
            null

        // Exige mínimo de 4 pontos (corners do QR)
        if (!Array.isArray(points) || points.length < 4) return null

        // Aceita {x,y} e {X,Y} (variações entre versões da biblioteca)
        const xs = points.map(p => p?.x ?? p?.X)
        const ys = points.map(p => p?.y ?? p?.Y)

        // Rejeita qualquer ponto inválido ou infinito
        if (xs.some(v => typeof v !== "number" || !isFinite(v))) return null
        if (ys.some(v => typeof v !== "number" || !isFinite(v))) return null

        const minX = Math.min(...xs), maxX = Math.max(...xs)
        const minY = Math.min(...ys), maxY = Math.max(...ys)
        const w = maxX - minX, h = maxY - minY

        // Caixa degenerada (ponto único ou linha)
        if (w <= 0 || h <= 0) return null

        return { x: minX, y: minY, width: w, height: h }

    } catch {
        return null   // estrutura totalmente inesperada — descarta
    }
}

// ===================== CÂMERA — ESTADO GLOBAL =====================
let _html5QrCode    = null
let _cameraRunning  = false

// ===================== CONSTRAINTS AVANÇADOS =====================
/**
 * Aplica foco/exposição contínuos após câmera estar ativa.
 * Falha silenciosamente em dispositivos sem suporte.
 * @param {HTMLVideoElement} videoEl
 */
function _aplicarConstraintsAvancados(videoEl) {
    try {
        const track = videoEl?.srcObject?.getVideoTracks?.()[0]
        if (!track || typeof track.applyConstraints !== "function") return

        track.applyConstraints({
            advanced: [
                { focusMode:    "continuous" },
                { exposureMode: "continuous" }
            ]
        }).catch(() => { /* sem suporte — degradação silenciosa */ })
    } catch { /* getVideoTracks pode não existir — ignora */ }
}

// ===================== BOTÃO DE TOCHA (TORCH) =====================
/**
 * Cria ou actualiza o botão de toggle da lanterna no DOM.
 * Só é inserido se o dispositivo suportar torch.
 */
function _setupTorchButton() {
    if (!ScannerVisual.torch.isSupported()) return

    // Evita duplicar o botão
    if (document.getElementById("btnTorch")) return

    const wrap = document.querySelector(".scanner-card .card-header")
    if (!wrap) return

    const btn = document.createElement("button")
    btn.id        = "btnTorch"
    btn.type      = "button"
    btn.className = "btn sm"
    btn.title     = "Alternar lanterna"
    btn.textContent = "🔦 Lanterna"

    btn.onclick = () => {
        const isOn = ScannerVisual.torch.toggle()
        btn.textContent = isOn ? "🔦 Desligar" : "🔦 Lanterna"
        btn.classList.toggle("active", isOn)
    }

    wrap.appendChild(btn)
}

// ===================== INICIAR CÂMERA =====================
async function iniciarCamera() {
    const statusEl = document.getElementById("scannerStatus")
    const btn      = document.getElementById("btnStartCamera")
    const idle     = document.getElementById("scannerIdle")
    const wrap     = document.getElementById("scannerWrap")

    if (!btn || _cameraRunning) return

    btn.disabled = true
    if (statusEl) {
        statusEl.className   = "scanner-status"
        statusEl.textContent = "Solicitando permissão..."
    }

    try {
        // ── Pré-verificação de permissão (devolve stream imediatamente) ──
        // Paramos a stream logo depois — o html5-qrcode abre a sua própria.
        const testStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } }
        })
        testStream.getTracks().forEach(t => t.stop())

        if (statusEl) {
            statusEl.className   = "scanner-status ok"
            statusEl.textContent = "✅ Câmera ativa — aponte para o QR Code"
        }

        _html5QrCode = new Html5Qrcode("reader")

        // ── Estratégia de câmera: traseira ideal → traseira exact → qualquer ──
        const cameraConstraints = [
            { facingMode: { ideal: "environment" } },
            { facingMode: "environment" },
            { facingMode: "user" }        // último recurso (desktop sem câmera traseira)
        ]

        let started = false
        for (const constraint of cameraConstraints) {
            try {
                await _html5QrCode.start(
                    constraint,
                    {
                        fps: 10,               // 10 FPS: eficiente e suficiente para QR
                        qrbox: (w, h) => {
                            const s = Math.floor(Math.min(w, h) * 0.75)
                            return { width: s, height: s }
                        },
                        aspectRatio: 1.0,
                        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
                        // Mantém varredura ativa mesmo em frames sem QR
                        rememberLastUsedCamera: true,
                    },

                    // ── Callback: QR detectado ─────────────────────────────────
                    // NÃO usar await aqui — não deve bloquear o render loop.
                    (decodedText, decodedResult) => {
                        // Atualiza ScannerVisual ANTES de iniciar qualquer I/O
                        const box = _extrairBoundingBox(decodedResult)
                        ScannerVisual.update(box)

                        // Fire-and-forget: erros capturados internamente
                        onScanSuccess(decodedText).catch(err => {
                            console.error("[leitor] onScanSuccess error:", err)
                        })
                    },

                    // ── Callback: nenhum QR no frame ──────────────────────────
                    () => { ScannerVisual.update(null) }
                )

                started = true
                break   // saiu com sucesso — não tenta próximo constraint

            } catch (startErr) {
                // Tenta próximo constraint se este falhou
                if (constraint === cameraConstraints.at(-1)) throw startErr
                console.warn("[leitor] Fallback de câmera:", constraint, startErr.message)
            }
        }

        if (!started) throw new Error("Nenhuma câmera disponível")

        // ── Conecta ScannerVisual ao vídeo gerado pelo html5-qrcode ──────────
        // O html5-qrcode injeta um <video> dentro de #reader.
        const videoEl  = document.querySelector("#reader video")
        const canvasEl = document.getElementById("scannerCanvas")

        if (videoEl && canvasEl) {
            // Aguarda metadados do vídeo antes de inicializar (garante dimensões)
            const _attach = () => {
                ScannerVisual.init(videoEl, canvasEl)
                _aplicarConstraintsAvancados(videoEl)
                _setupTorchButton()
            }

            if (videoEl.readyState >= 1) {
                _attach()
            } else {
                videoEl.addEventListener("loadedmetadata", _attach, { once: true })
            }
        }

        _cameraRunning = true
        if (wrap)  wrap.classList.add("ativo")
        if (idle)  idle.style.display = "none"
        btn.style.display = "none"

        Notif.sucesso("Câmera ativa", "Aponte o QR Code do aluno para a câmera.")

        // ── Botão de parar câmera (criado dinamicamente) ─────────────────────
        _insertStopButton()

    } catch (err) {
        btn.disabled = false

        if (!statusEl) return

        const map = {
            NotAllowedError:  "❌ Permissão negada. Habilite a câmera nas configurações do navegador.",
            NotFoundError:    "❌ Nenhuma câmera encontrada neste dispositivo.",
            NotReadableError: "❌ Câmera em uso por outro aplicativo.",
            OverconstrainedError: "❌ Câmera não suporta as configurações necessárias.",
        }
        const mensagem = map[err.name] ?? ("❌ " + (err.message || "Erro desconhecido ao acessar a câmera."))

        statusEl.className   = "scanner-status erro"
        statusEl.textContent = mensagem
        Notif.erro("Erro na câmera", mensagem.replace("❌ ", ""))
    }
}

// ===================== PARAR CÂMERA =====================
async function pararCamera() {
    if (!_html5QrCode || !_cameraRunning) return

    ScannerVisual.reset()
    _cameraRunning = false

    try {
        if (_html5QrCode.isScanning) {
            await _html5QrCode.stop()
        }
    } catch (e) {
        console.warn("[leitor] Erro ao parar câmera:", e)
    }

    _html5QrCode = null

    const idle = document.getElementById("scannerIdle")
    const wrap = document.getElementById("scannerWrap")
    const btn  = document.getElementById("btnStartCamera")
    const stopBtn = document.getElementById("btnStopCamera")
    const torchBtn = document.getElementById("btnTorch")

    if (idle)     idle.style.display = ""
    if (wrap)     wrap.classList.remove("ativo")
    if (btn)      { btn.style.display = ""; btn.disabled = false }
    if (stopBtn)  stopBtn.remove()
    if (torchBtn) torchBtn.remove()

    const statusEl = document.getElementById("scannerStatus")
    if (statusEl) {
        statusEl.className   = "scanner-status"
        statusEl.textContent = "Câmera desativada"
    }
}

// ── Botão "Parar câmera" injetado dinamicamente ─────────────────────────────
function _insertStopButton() {
    if (document.getElementById("btnStopCamera")) return

    const footer = document.querySelector(".scanner-card")
    if (!footer) return

    const btn = document.createElement("button")
    btn.id        = "btnStopCamera"
    btn.type      = "button"
    btn.className = "btn secondary full"
    btn.style.marginTop = "8px"
    btn.textContent = "Desativar câmera"
    btn.onclick = pararCamera

    // Insere após o botão de exportar, dentro do card
    const exportBtn = document.getElementById("btnExportar")
    if (exportBtn) {
        exportBtn.parentNode.insertBefore(btn, exportBtn.nextSibling)
    } else {
        footer.appendChild(btn)
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