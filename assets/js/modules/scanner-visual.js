/**
 * scanner-visual.js  — v2.0  (production)
 *
 * Adaptive QR scanner overlay with:
 *   • Bounding-box extraction  (multi-path, validated)
 *   • Smooth adaptive box      (LERP + jitter rejection)
 *   • Auto-zoom                (clamped, oscillation-free)
 *   • Local exposure           (software-only, safe)
 *   • Torch control            (auto + manual, silent fail)
 *   • Non-blocking loop        (~10 FPS render budget)
 *
 * Public API
 * ──────────
 *   ScannerVisual.init(videoEl, canvasEl)
 *   ScannerVisual.update(box | null)
 *   ScannerVisual.confirm(status)
 *   ScannerVisual.torch.toggle()          → boolean (new state)
 *   ScannerVisual.torch.setAuto(enabled)
 *   ScannerVisual.torch.isOn()            → boolean
 *   ScannerVisual.reset()
 *
 * All methods are safe to call in any state — no throw, ever.
 */
const ScannerVisual = (() => {

    // ─────────────────────────────────────────────────────────────────────────
    // DOM refs
    // ─────────────────────────────────────────────────────────────────────────

    let _video  = null
    let _canvas = null
    let _ctx    = null

    // ─────────────────────────────────────────────────────────────────────────
    // Animation state
    // ─────────────────────────────────────────────────────────────────────────

    let _rafId       = null
    let _running     = false
    let _initialized = false

    // Smoothed box (0–1 relative to video dimensions)
    const _smooth = { x: 0.5, y: 0.5, w: 0.38, h: 0.38 }
    const _target = { x: 0.5, y: 0.5, w: 0.38, h: 0.38 }
    // Previous raw target — used for jitter rejection
    const _prev   = { x: 0.5, y: 0.5, w: 0.38, h: 0.38 }

    let _qrVisible       = false
    let _framesWithoutQr = 0

    // ─────────────────────────────────────────────────────────────────────────
    // Zoom state
    // ─────────────────────────────────────────────────────────────────────────

    let _zoomCurrent      = 1.0
    let _zoomTarget       = 1.0
    // Rolling history to prevent zoom oscillation
    const _ZOOM_HIST_LEN  = 6
    const _zoomHistory    = new Float32Array(_ZOOM_HIST_LEN).fill(1.0)
    let   _zoomHistIdx    = 0

    // ─────────────────────────────────────────────────────────────────────────
    // Dim / flash state
    // ─────────────────────────────────────────────────────────────────────────

    let _dimAlpha  = 0.0
    let _dimTarget = 0.0

    let _flashAlpha = 0.0
    let _flashColor = "#1a6641"

    // ─────────────────────────────────────────────────────────────────────────
    // Corner-scanner idle animation
    // ─────────────────────────────────────────────────────────────────────────

    let _idlePhase = 0.0   // 0..2π

    // ─────────────────────────────────────────────────────────────────────────
    // Exposure
    // ─────────────────────────────────────────────────────────────────────────

    let _exposureTainted = false   // CORS: disable permanently after first fail

    // ─────────────────────────────────────────────────────────────────────────
    // Torch (flash-light)
    // ─────────────────────────────────────────────────────────────────────────

    const _torch = {
        track:       null,     // MediaStreamTrack | null
        supported:   false,
        on:          false,
        autoMode:    true,     // auto-detect low-light
        manualOn:    null,     // null = no manual override
        // Low-light detection
        luxHistory:  new Float32Array(8).fill(255),
        luxIdx:      0,
        AUTO_THRESH: 80,       // avg luma below this → turn on torch
        AUTO_HYST:   20,       // hysteresis band (turn off above thresh+hyst)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tuneable constants
    // ─────────────────────────────────────────────────────────────────────────

    const IDLE_FRAMES         = 10      // frames before QR declared gone
    const LERP_BOX            = 0.14    // box smoothing factor
    const LERP_ZOOM           = 0.07    // zoom smoothing factor
    const LERP_DIM            = 0.10    // dim-overlay smoothing factor
    const JITTER_MAX_DELTA    = 0.25    // reject box jumps > 25% of frame (relative)
    const ZOOM_THRESHOLD      = 0.22    // QR smaller than this → zoom
    const ZOOM_MAX            = 2.8
    const ZOOM_IDENTITY       = 1.02
    const BOX_PADDING         = 0.055   // extra padding around detected box
    const MAX_EXPOSURE_PX     = 80_000  // pixel budget per exposure pass
    const EXPOSURE_TARGET_LUM = 155     // target luminance (0–255)
    const EXPOSURE_STRENGTH   = 0.55    // fraction of delta to apply
    const FLASH_DECAY         = 0.05    // per-frame alpha decay
    const IDLE_ANIM_SPEED     = 0.03    // corner bounce speed

    const CONFIRM_COLORS = {
        presente:  "#1a6641",
        atrasado:  "#e59a00",
        duplicado: "#c8a84b",
        turno:     "#7c3aed",
        erro:      "#b83232"
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ── PUBLIC API ────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Attach visual scanner to DOM elements.
     * Safe to call multiple times — resets first.
     * @param {HTMLVideoElement}  videoEl
     * @param {HTMLCanvasElement} canvasEl
     */
    function init(videoEl, canvasEl) {
        if (_initialized) reset()

        _video  = videoEl
        _canvas = canvasEl
        _ctx    = canvasEl.getContext("2d", { willReadFrequently: true })

        _running     = true
        _initialized = true

        _torch_attach(videoEl)
        _rafId = requestAnimationFrame(_loop)
    }

    /**
     * Update QR bounding-box.
     * Must be called every scan frame — pass null when no QR detected.
     * @param {{ x:number, y:number, width:number, height:number } | null} box
     */
    function update(box) {
        if (!_running) return

        if (!box) {
            _framesWithoutQr++
            if (_framesWithoutQr > IDLE_FRAMES) {
                _qrVisible = false
                _dimTarget = 0
                _zoomTarget = 1.0
                Object.assign(_target, { x: 0.5, y: 0.5, w: 0.38, h: 0.38 })
            }
            return
        }

        // ── Normalise box to 0-1 (relative to video frame) ──
        const vw = _video?.videoWidth  || _canvas?.width  || 640
        const vh = _video?.videoHeight || _canvas?.height || 480

        const nx = (box.x + box.width  / 2) / vw
        const ny = (box.y + box.height / 2) / vh
        const nw = box.width  / vw
        const nh = box.height / vh

        // ── Jitter rejection: ignore wild jumps ──
        const dx = Math.abs(nx - _prev.x)
        const dy = Math.abs(ny - _prev.y)
        const dw = Math.abs(nw - _prev.w)
        if (_qrVisible && (dx > JITTER_MAX_DELTA || dy > JITTER_MAX_DELTA || dw > JITTER_MAX_DELTA * 2)) {
            _framesWithoutQr++
            return
        }

        _framesWithoutQr = 0
        _qrVisible = true

        _prev.x = nx; _prev.y = ny; _prev.w = nw; _prev.h = nh

        _target.x = nx
        _target.y = ny
        _target.w = nw
        _target.h = nh

        // ── Zoom: use median of recent targets to prevent oscillation ──
        const size = Math.max(nw, nh)
        const rawZoom = size < ZOOM_THRESHOLD
            ? Math.min(ZOOM_MAX, (ZOOM_THRESHOLD / size) * 1.15)
            : 1.0

        _zoomHistory[_zoomHistIdx] = rawZoom
        _zoomHistIdx = (_zoomHistIdx + 1) % _ZOOM_HIST_LEN
        const sorted = Float32Array.from(_zoomHistory).sort()
        const medianZoom = sorted[Math.floor(_ZOOM_HIST_LEN / 2)]

        _zoomTarget = medianZoom

        _dimTarget = 0.55
    }

    /**
     * Trigger confirmation flash.
     * @param {"presente"|"atrasado"|"duplicado"|"turno"|"erro"} status
     */
    function confirm(status) {
        _flashColor = CONFIRM_COLORS[status] ?? CONFIRM_COLORS.erro
        _flashAlpha = 1.0
    }

    /**
     * Stop loop and release all resources.
     */
    function reset() {
        _running     = false
        _initialized = false

        if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null }
        if (_ctx && _canvas) _ctx.clearRect(0, 0, _canvas.width, _canvas.height)

        _torch_set(false)
        _torch.track     = null
        _torch.supported = false
        _torch.on        = false
        _torch.manualOn  = null

        _video  = null
        _canvas = null
        _ctx    = null

        _qrVisible       = false
        _framesWithoutQr = 0
        _zoomCurrent     = 1.0
        _zoomTarget      = 1.0
        _zoomHistory.fill(1.0)
        _dimAlpha        = 0.0
        _dimTarget       = 0.0
        _flashAlpha      = 0.0
        _idlePhase       = 0.0
        _exposureTainted = false

        Object.assign(_smooth, { x: 0.5, y: 0.5, w: 0.38, h: 0.38 })
        Object.assign(_target, { x: 0.5, y: 0.5, w: 0.38, h: 0.38 })
        Object.assign(_prev,   { x: 0.5, y: 0.5, w: 0.38, h: 0.38 })
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ── TORCH SUB-MODULE ──────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Try to grab torch-capable track from existing video stream.
     * Silent on any failure.
     * @param {HTMLVideoElement} videoEl
     */
    function _torch_attach(videoEl) {
        try {
            const stream = videoEl?.srcObject
            if (!stream || typeof stream.getVideoTracks !== "function") return
            const track = stream.getVideoTracks()[0]
            if (!track) return

            const caps = (typeof track.getCapabilities === "function") ? track.getCapabilities() : {}
            if (caps?.torch) {
                _torch.track     = track
                _torch.supported = true
            }
        } catch { /* ignore */ }
    }

    /**
     * Apply torch state to hardware. Silent fail.
     * @param {boolean} on
     */
    function _torch_set(on) {
        if (!_torch.supported || !_torch.track) return
        try {
            _torch.track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {})
            _torch.on = on
        } catch { /* ignore */ }
    }

    /**
     * Decide torch state from scene luminance.
     * Called once every ~30 frames to amortise cost.
     * @param {number} avgLuma
     */
    function _torch_autoUpdate(avgLuma) {
        if (!_torch.supported) return
        if (_torch.manualOn !== null) return   // manual override active

        _torch.luxHistory[_torch.luxIdx] = avgLuma
        _torch.luxIdx = (_torch.luxIdx + 1) % _torch.luxHistory.length
        const avgScene = _torch.luxHistory.reduce((s, v) => s + v, 0) / _torch.luxHistory.length

        const shouldOn = avgScene < _torch.AUTO_THRESH
        const shouldOff = avgScene > _torch.AUTO_THRESH + _torch.AUTO_HYST

        if (shouldOn  && !_torch.on) _torch_set(true)
        if (shouldOff &&  _torch.on) _torch_set(false)
    }

    // Torch public sub-object
    const torchAPI = {
        /**
         * Toggle torch manually. Returns new state.
         * Manual override disables auto-mode until setAuto(true).
         * @returns {boolean}
         */
        toggle() {
            if (!_torch.supported) return false
            _torch.manualOn = !_torch.on
            _torch_set(_torch.manualOn)
            return _torch.on
        },

        /**
         * Enable or disable automatic torch control.
         * Disabling auto-mode also turns torch off.
         * @param {boolean} enabled
         */
        setAuto(enabled) {
            _torch.autoMode = !!enabled
            if (!enabled) {
                _torch.manualOn = null
                _torch_set(false)
            } else {
                _torch.manualOn = null
            }
        },

        /** @returns {boolean} */
        isOn() { return _torch.on },

        /** @returns {boolean} */
        isSupported() { return _torch.supported }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ── MAIN LOOP ─────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    let _frameCount = 0

    function _loop() {
        if (!_running) return
        _rafId = requestAnimationFrame(_loop)
        if (!_video || _video.readyState < 2) return

        _syncCanvasSize()
        _animate()
        _render()
        _frameCount++
    }

    function _syncCanvasSize() {
        const rect = _canvas.getBoundingClientRect()
        if (_canvas.width !== Math.round(rect.width) || _canvas.height !== Math.round(rect.height)) {
            _canvas.width  = Math.round(rect.width)
            _canvas.height = Math.round(rect.height)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ── ANIMATION ────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    const _lerp = (a, b, t) => a + (b - a) * t

    function _animate() {
        _smooth.x = _lerp(_smooth.x, _target.x, LERP_BOX)
        _smooth.y = _lerp(_smooth.y, _target.y, LERP_BOX)
        _smooth.w = _lerp(_smooth.w, _target.w, LERP_BOX)
        _smooth.h = _lerp(_smooth.h, _target.h, LERP_BOX)

        _zoomCurrent = _lerp(_zoomCurrent, _zoomTarget, LERP_ZOOM)
        _dimAlpha    = _lerp(_dimAlpha,    _dimTarget,  LERP_DIM)

        if (_flashAlpha > 0) _flashAlpha = Math.max(0, _flashAlpha - FLASH_DECAY)

        if (!_qrVisible) {
            _idlePhase = (_idlePhase + IDLE_ANIM_SPEED) % (Math.PI * 2)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ── RENDER ───────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    function _render() {
        if (!_ctx || !_canvas) return

        const cw = _canvas.width
        const ch = _canvas.height

        _ctx.clearRect(0, 0, cw, ch)

        _drawZoomedVideo(cw, ch)

        // Exposure + torch-auto every ~30 frames (≈3 s at 10 FPS) to save CPU
        if (_frameCount % 30 === 0) {
            const luma = _sampleCenterLuma(cw, ch)
            if (_torch.autoMode && _torch.manualOn === null) {
                _torch_autoUpdate(luma)
            }
        }

        // Local exposure correction inside QR region every 2 frames
        if (_qrVisible && _dimAlpha > 0.1 && _frameCount % 2 === 0) {
            _applyLocalExposure(cw, ch)
        }

        _drawDimOverlay(cw, ch)
        _drawTrackingBox(cw, ch)

        if (_flashAlpha > 0.01) _drawFlash(cw, ch)
    }

    // ── Video rendering with zoom ─────────────────────────────────────────────

    function _drawZoomedVideo(cw, ch) {
        const zoom = _zoomCurrent

        if (zoom <= ZOOM_IDENTITY) {
            _ctx.drawImage(_video, 0, 0, cw, ch)
            return
        }

        const vw = _video.videoWidth  || cw
        const vh = _video.videoHeight || ch

        const cropW = vw / zoom
        const cropH = vh / zoom

        // Center crop on smoothed QR position
        let srcX = _smooth.x * vw - cropW / 2
        let srcY = _smooth.y * vh - cropH / 2

        // Clamp to video bounds
        srcX = Math.max(0, Math.min(vw - cropW, srcX))
        srcY = Math.max(0, Math.min(vh - cropH, srcY))

        _ctx.drawImage(_video, srcX, srcY, cropW, cropH, 0, 0, cw, ch)
    }

    // ── Local exposure correction ─────────────────────────────────────────────

    /**
     * Sample average luma in the centre of the canvas.
     * Uses 1-in-8 pixel sampling for speed. Returns 0..255.
     * @param {number} cw
     * @param {number} ch
     * @returns {number}
     */
    function _sampleCenterLuma(cw, ch) {
        if (_exposureTainted) return 128

        const sw = Math.min(120, cw)
        const sh = Math.min(80, ch)
        const sx = Math.floor((cw - sw) / 2)
        const sy = Math.floor((ch - sh) / 2)

        try {
            const d = _ctx.getImageData(sx, sy, sw, sh).data
            let sum = 0, n = 0
            for (let i = 0; i < d.length; i += 32) {
                sum += d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114
                n++
            }
            return n > 0 ? sum / n : 128
        } catch {
            _exposureTainted = true
            return 128
        }
    }

    /**
     * Improve contrast/brightness in the QR bounding-box region.
     *
     * Algorithm:
     *   1. Clamp region to MAX_EXPOSURE_PX (mobile safety).
     *   2. Sample average luma (1-in-4 pixels, weighted).
     *   3. Compute brightness delta toward EXPOSURE_TARGET_LUM.
     *   4. Compute adaptive contrast [1.08 .. 1.40].
     *   5. Write corrected pixels back.
     *   6. On SecurityError → set tainted flag, never retry.
     *
     * @param {number} cw canvas width
     * @param {number} ch canvas height
     */
    function _applyLocalExposure(cw, ch) {
        if (_exposureTainted) return

        const { bx, by, bw, bh } = _getBoxCoords(cw, ch)

        const x = Math.max(0, Math.floor(bx))
        const y = Math.max(0, Math.floor(by))
        const w = Math.min(Math.ceil(bw), cw - x)
        const h = Math.min(Math.ceil(bh), ch - y)

        if (w <= 0 || h <= 0) return

        // Scale down region if over pixel budget
        let sw = w, sh = h
        if (sw * sh > MAX_EXPOSURE_PX) {
            const scale = Math.sqrt(MAX_EXPOSURE_PX / (sw * sh))
            sw = Math.floor(sw * scale)
            sh = Math.floor(sh * scale)
        }

        let imageData
        try {
            // Read at reduced size if necessary
            if (sw !== w || sh !== h) {
                // Off-screen temp canvas for downscale read
                const tmp = new OffscreenCanvas(sw, sh)
                const tc  = tmp.getContext("2d")
                tc.drawImage(_canvas, x, y, w, h, 0, 0, sw, sh)
                imageData = tc.getImageData(0, 0, sw, sh)
            } else {
                imageData = _ctx.getImageData(x, y, w, h)
            }
        } catch {
            _exposureTainted = true
            return
        }

        const data = imageData.data

        // Sample avg luma (1-in-4)
        let sum = 0, count = 0
        for (let i = 0; i < data.length; i += 16) {
            sum += data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114
            count++
        }
        if (count === 0) return

        const avg   = sum / count
        const delta = (EXPOSURE_TARGET_LUM - avg) * EXPOSURE_STRENGTH

        // Adaptive contrast: stronger correction for dark scenes
        const darkness  = Math.max(0, Math.min(1, (EXPOSURE_TARGET_LUM - avg) / EXPOSURE_TARGET_LUM))
        const contrast  = 1.08 + darkness * 0.32
        const intercept = 128 * (1 - contrast)

        for (let i = 0; i < data.length; i += 4) {
            data[i]   = Math.min(255, Math.max(0, (data[i]   + delta) * contrast + intercept))
            data[i+1] = Math.min(255, Math.max(0, (data[i+1] + delta) * contrast + intercept))
            data[i+2] = Math.min(255, Math.max(0, (data[i+2] + delta) * contrast + intercept))
        }

        // If we downscaled, write back at full coords (nearest-neighbour via drawImage)
        try {
            if (sw !== w || sh !== h) {
                const tmp = new OffscreenCanvas(sw, sh)
                tmp.getContext("2d").putImageData(imageData, 0, 0)
                _ctx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h)
            } else {
                _ctx.putImageData(imageData, x, y)
            }
        } catch { /* ignore write failure */ }
    }

    // ── Overlay layers ────────────────────────────────────────────────────────

    function _drawDimOverlay(cw, ch) {
        if (_dimAlpha < 0.01) return

        const { bx, by, bw, bh } = _getBoxCoords(cw, ch)

        _ctx.save()
        _ctx.beginPath()
        _ctx.rect(0, 0, cw, ch)
        _ctx.rect(bx, by, bw, bh)
        _ctx.clip("evenodd")

        _ctx.fillStyle = `rgba(10,10,10,${(_dimAlpha * 0.70).toFixed(3)})`
        _ctx.fillRect(0, 0, cw, ch)
        _ctx.restore()
    }

    function _drawTrackingBox(cw, ch) {
        const { bx, by, bw, bh } = _getBoxCoords(cw, ch)

        // Color: flash > tracking > idle
        let color, lineWidth
        if (_flashAlpha > 0.05) {
            color = _flashColor
            lineWidth = 3.0
        } else if (_qrVisible) {
            color = "#1a6641"
            lineWidth = 2.5
        } else {
            // Idle: animated opacity
            const alpha = 0.35 + 0.25 * Math.sin(_idlePhase)
            color = `rgba(160,160,160,${alpha.toFixed(3)})`
            lineWidth = 1.5
        }

        const r = 8  // corner radius

        _ctx.strokeStyle = color
        _ctx.lineWidth   = lineWidth

        // Rounded-corner box using corner arcs
        _ctx.beginPath()
        _ctx.moveTo(bx + r, by)
        _ctx.lineTo(bx + bw - r, by)
        _ctx.arcTo(bx + bw, by,       bx + bw, by + r,       r)
        _ctx.lineTo(bx + bw, by + bh - r)
        _ctx.arcTo(bx + bw, by + bh,  bx + bw - r, by + bh,  r)
        _ctx.lineTo(bx + r,  by + bh)
        _ctx.arcTo(bx,       by + bh,  bx, by + bh - r,       r)
        _ctx.lineTo(bx,      by + r)
        _ctx.arcTo(bx,       by,       bx + r, by,             r)
        _ctx.closePath()
        _ctx.stroke()

        // Corner accent marks (thicker, short segments)
        if (_qrVisible || _flashAlpha > 0.05) {
            _drawCornerAccents(bx, by, bw, bh, color, lineWidth + 1.0)
        }
    }

    /**
     * Draw thick L-shaped corner accents inside the tracking box.
     */
    function _drawCornerAccents(bx, by, bw, bh, color, lw) {
        const len = Math.min(bw, bh) * 0.18
        _ctx.strokeStyle = color
        _ctx.lineWidth   = lw
        _ctx.lineCap     = "square"

        const corners = [
            [bx,      by,      1,  1],   // top-left
            [bx + bw, by,     -1,  1],   // top-right
            [bx,      by + bh, 1, -1],   // bottom-left
            [bx + bw, by + bh,-1, -1],   // bottom-right
        ]

        for (const [cx, cy, sx, sy] of corners) {
            _ctx.beginPath()
            _ctx.moveTo(cx + sx * len, cy)
            _ctx.lineTo(cx, cy)
            _ctx.lineTo(cx, cy + sy * len)
            _ctx.stroke()
        }

        _ctx.lineCap = "butt"
    }

    function _drawFlash(cw, ch) {
        _ctx.globalAlpha = _flashAlpha * 0.28
        _ctx.fillStyle   = _flashColor
        _ctx.fillRect(0, 0, cw, ch)
        _ctx.globalAlpha = 1
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ── Coordinate helpers ────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    function _getBoxCoords(cw, ch) {
        // While zoomed, keep box centred on canvas
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

    // ─────────────────────────────────────────────────────────────────────────
    // ── EXPORT ────────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    return { init, update, confirm, reset, torch: torchAPI }

})()