const ScannerVisual = (() => {

    // ── Referências de DOM ────────────────────────────────────────────────────

    let _video  = null
    let _canvas = null
    let _ctx    = null

    // ── Estado da animação ────────────────────────────────────────────────────

    let _rafId       = null
    let _running     = false
    let _initialized = false

    const _smooth = { x: 0.5, y: 0.5, w: 0.4, h: 0.4 }
    const _target = { x: 0.5, y: 0.5, w: 0.4, h: 0.4 }

    let _qrVisible       = false
    let _framesWithoutQr = 0

    let _zoomCurrent = 1.0
    let _zoomTarget  = 1.0

    let _dimAlpha  = 0.0
    let _dimTarget = 0.0

    let _flashAlpha  = 0.0
    let _flashColor  = "#1a6641"
    let _pulsePhase  = 0.0
    let _pulseActive = false

    // ── Constantes ────────────────────────────────────────────────────────────

    const IDLE_FRAMES       = 8
    const LERP_BOX          = 0.12
    const LERP_ZOOM         = 0.08
    const LERP_DIM          = 0.10
    const ZOOM_THRESHOLD    = 0.20
    const ZOOM_MAX          = 2.8
    const BOX_PADDING       = 0.06
    const ZOOM_IDENTITY     = 1.02
    const MAX_EXPOSURE_AREA = 90_000  // pixels — cap de segurança em mobile

    const CONFIRM_COLORS = {
        presente:  "#1a6641",
        atrasado:  "#e53e3e",
        duplicado: "#c8a84b",
        turno:     "#7c3aed",   // violeta — turno incorreto
        erro:      "#b83232"
    }

    // ── API Pública ───────────────────────────────────────────────────────────

    /**
     * Inicializa o scanner visual com os elementos de vídeo e canvas.
     * @param {HTMLVideoElement} videoEl
     * @param {HTMLCanvasElement} canvasEl
     */
    function init(videoEl, canvasEl) {
        if (_initialized) reset()

        _video  = videoEl
        _canvas = canvasEl
        _ctx    = canvasEl.getContext("2d", { willReadFrequently: true })

        _running     = true
        _initialized = true

        _rafId = requestAnimationFrame(_loop)
    }

    /**
     * Atualiza a posição e tamanho do QR detectado.
     * Chame com `null` quando nenhum QR for visível no frame atual.
     * @param {{ x: number, y: number, width: number, height: number } | null} box
     */
    function update(box) {
        if (!_running) return

        if (!box) {
            _framesWithoutQr++
            if (_framesWithoutQr > IDLE_FRAMES) {
                _qrVisible = false
                _dimTarget = 0
                _zoomTarget = 1
                Object.assign(_target, { x: 0.5, y: 0.5, w: 0.4, h: 0.4 })
            }
            return
        }

        _framesWithoutQr = 0
        _qrVisible = true

        const vw = _video?.videoWidth  || _canvas.width
        const vh = _video?.videoHeight || _canvas.height

        _target.x = (box.x + box.width  / 2) / vw
        _target.y = (box.y + box.height / 2) / vh
        _target.w = box.width  / vw
        _target.h = box.height / vh

        const size = Math.max(_target.w, _target.h)
        _zoomTarget = size < ZOOM_THRESHOLD
            ? Math.min(ZOOM_MAX, (ZOOM_THRESHOLD / size) * 1.2)
            : 1

        _dimTarget = 0.55
    }

    /**
     * Dispara feedback visual de confirmação (flash colorido).
     * @param {"presente"|"atrasado"|"duplicado"|"turno"|"erro"} status
     */
    function confirm(status) {
        _flashColor  = CONFIRM_COLORS[status] ?? CONFIRM_COLORS.erro
        _flashAlpha  = 1
        _pulseActive = true
        _pulsePhase  = 0
    }

    /**
     * Para o loop de animação e libera referências de DOM.
     */
    function reset() {
        _running     = false
        _initialized = false

        if (_rafId) {
            cancelAnimationFrame(_rafId)
            _rafId = null
        }

        if (_ctx && _canvas) {
            _ctx.clearRect(0, 0, _canvas.width, _canvas.height)
        }

        _video  = null
        _canvas = null
        _ctx    = null

        _qrVisible       = false
        _framesWithoutQr = 0
        _zoomCurrent     = 1.0
        _zoomTarget      = 1.0
        _dimAlpha        = 0.0
        _dimTarget       = 0.0
        _flashAlpha      = 0.0
        _pulseActive     = false
        _pulsePhase      = 0.0
        Object.assign(_smooth, { x: 0.5, y: 0.5, w: 0.4, h: 0.4 })
        Object.assign(_target, { x: 0.5, y: 0.5, w: 0.4, h: 0.4 })
    }

    // ── Loop principal ────────────────────────────────────────────────────────

    function _loop() {
        if (!_running) return
        _rafId = requestAnimationFrame(_loop)

        if (!_video || _video.readyState < 2) return

        _syncCanvasSize()
        _animate()
        _render()
    }

    function _syncCanvasSize() {
        const rect = _canvas.getBoundingClientRect()
        if (_canvas.width !== rect.width || _canvas.height !== rect.height) {
            _canvas.width  = rect.width
            _canvas.height = rect.height
        }
    }

    // ── Animação ──────────────────────────────────────────────────────────────

    const _lerp = (a, b, t) => a + (b - a) * t

    function _animate() {
        _smooth.x = _lerp(_smooth.x, _target.x, LERP_BOX)
        _smooth.y = _lerp(_smooth.y, _target.y, LERP_BOX)
        _smooth.w = _lerp(_smooth.w, _target.w, LERP_BOX)
        _smooth.h = _lerp(_smooth.h, _target.h, LERP_BOX)

        _zoomCurrent = _lerp(_zoomCurrent, _zoomTarget, LERP_ZOOM)
        _dimAlpha    = _lerp(_dimAlpha,    _dimTarget,  LERP_DIM)

        if (_flashAlpha > 0) _flashAlpha = Math.max(0, _flashAlpha - 0.04)

        if (_pulseActive) {
            _pulsePhase += 0.18
            if (_pulsePhase > Math.PI * 4) {
                _pulseActive = false
                _pulsePhase  = 0
            }
        }
    }

    // ── Render ────────────────────────────────────────────────────────────────

    function _render() {
        if (!_ctx || !_canvas) return

        const cw = _canvas.width
        const ch = _canvas.height

        _ctx.clearRect(0, 0, cw, ch)

        _drawZoomedVideo(cw, ch)
        _drawDimOverlay(cw, ch)
        _drawTrackingBox(cw, ch)

        if (_qrVisible && _dimAlpha > 0.1) {
            _applyLocalExposure(cw, ch)
        }

        if (_flashAlpha > 0.01) {
            _drawFlash(cw, ch)
        }
    }

    function _drawZoomedVideo(cw, ch) {
        const zoom = _zoomCurrent

        if (zoom <= ZOOM_IDENTITY) {
            _ctx.drawImage(_video, 0, 0, cw, ch)
            return
        }

        const vw = _video.videoWidth
        const vh = _video.videoHeight

        const cropW = vw / zoom
        const cropH = vh / zoom

        let srcX = _smooth.x * vw - cropW / 2
        let srcY = _smooth.y * vh - cropH / 2

        srcX = Math.max(0, Math.min(vw - cropW, srcX))
        srcY = Math.max(0, Math.min(vh - cropH, srcY))

        _ctx.drawImage(_video, srcX, srcY, cropW, cropH, 0, 0, cw, ch)
    }

    function _drawDimOverlay(cw, ch) {
        if (_dimAlpha < 0.01) return

        const { bx, by, bw, bh } = _getBoxCoords(cw, ch)

        _ctx.save()
        _ctx.beginPath()
        _ctx.rect(0, 0, cw, ch)
        _ctx.rect(bx, by, bw, bh)
        _ctx.clip("evenodd")

        _ctx.fillStyle = `rgba(10,10,10,${_dimAlpha * 0.72})`
        _ctx.fillRect(0, 0, cw, ch)
        _ctx.restore()
    }

    function _drawTrackingBox(cw, ch) {
        const { bx, by, bw, bh } = _getBoxCoords(cw, ch)

        let color
        if (_flashAlpha > 0.05) {
            color = _flashColor
        } else if (_qrVisible) {
            color = "#1a6641"
        } else {
            color = "rgba(180,180,180,0.5)"
        }

        _ctx.strokeStyle = color
        _ctx.lineWidth   = _qrVisible ? 2.5 : 1.5
        _ctx.strokeRect(bx, by, bw, bh)
    }

    /**
     * Melhora localmente a exposição da região do QR detectado.
     *
     * Algoritmo:
     *   1. Amostra o brilho médio dos pixels da região (1:4 para performance).
     *   2. Calcula delta de brilho para aproximar luminância-alvo de 160.
     *   3. Aplica delta + correção de contraste adaptativa.
     *   4. Escreve o resultado de volta no canvas.
     *
     * Limites de segurança:
     *   - Região máxima: MAX_EXPOSURE_AREA pixels (evita travamento em mobile).
     *   - SecurityError por canvas tainted: desativa silenciosamente.
     */
    function _applyLocalExposure(cw, ch) {
        const { bx, by, bw, bh } = _getBoxCoords(cw, ch)

        const x = Math.max(0, Math.floor(bx))
        const y = Math.max(0, Math.floor(by))
        const w = Math.min(Math.ceil(bw), cw - x)
        const h = Math.min(Math.ceil(bh), ch - y)

        if (w <= 0 || h <= 0 || w * h > MAX_EXPOSURE_AREA) return

        let imageData
        try {
            imageData = _ctx.getImageData(x, y, w, h)
        } catch {
            // Canvas tainted (CORS) — desativa exposição local
            _dimTarget = 0
            return
        }

        const data = imageData.data

        // Amostragem de brilho (luma aproximada, 1 em cada 4 pixels)
        let sum = 0, count = 0
        for (let i = 0; i < data.length; i += 16) {
            // Luma ponderada: 0.299R + 0.587G + 0.114B
            sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
            count++
        }

        if (count === 0) return

        const avg = sum / count

        // Delta de brilho para atingir luminância-alvo (160)
        // Multiplicador 0.55 evita over-exposure em cenas já claras
        const delta = (160 - avg) * 0.55

        // Contraste adaptativo: mais forte quanto mais escura a cena
        // Range: [1.10 .. 1.45]
        const darkness  = Math.max(0, Math.min(1, (160 - avg) / 160))
        const contrast  = 1.10 + darkness * 0.35
        const intercept = 128 * (1 - contrast)

        for (let i = 0; i < data.length; i += 4) {
            // 1. Corrige brilho
            const r = data[i]     + delta
            const g = data[i + 1] + delta
            const b = data[i + 2] + delta

            // 2. Aplica contraste em torno de 128
            data[i]     = Math.min(255, Math.max(0, r * contrast + intercept))
            data[i + 1] = Math.min(255, Math.max(0, g * contrast + intercept))
            data[i + 2] = Math.min(255, Math.max(0, b * contrast + intercept))
            // Alpha (i+3) permanece intocado
        }

        _ctx.putImageData(imageData, x, y)
    }

    function _drawFlash(cw, ch) {
        _ctx.globalAlpha = _flashAlpha * 0.3
        _ctx.fillStyle   = _flashColor
        _ctx.fillRect(0, 0, cw, ch)
        _ctx.globalAlpha = 1
    }

    // ── Utilitário de coordenadas ──────────────────────────────────────────────

    function _getBoxCoords(cw, ch) {
        const relX = _zoomCurrent > ZOOM_IDENTITY ? 0.5 : _smooth.x
        const relY = _zoomCurrent > ZOOM_IDENTITY ? 0.5 : _smooth.y

        const bw = (_smooth.w + BOX_PADDING * 2) * cw
        const bh = (_smooth.h + BOX_PADDING * 2) * ch

        return {
            bx: relX * cw - bw / 2,
            by: relY * ch - bh / 2,
            bw,
            bh
        }
    }

    // ── Export ────────────────────────────────────────────────────────────────

    return { init, update, confirm, reset }

})()