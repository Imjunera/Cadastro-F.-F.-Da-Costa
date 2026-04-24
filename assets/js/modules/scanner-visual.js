const ScannerVisual = (() => {

    // ── Referências de DOM ────────────────────────────────────────────────────

    let _video  = null;
    let _canvas = null;
    let _ctx    = null;

    // ── Estado da animação ────────────────────────────────────────────────────

    let _rafId       = null;
    let _running     = false;
    let _initialized = false;

    const _smooth = { x: 0.5, y: 0.5, w: 0.4, h: 0.4 };
    const _target = { x: 0.5, y: 0.5, w: 0.4, h: 0.4 };

    let _qrVisible       = false;
    let _framesWithoutQr = 0;

    let _zoomCurrent = 1.0;
    let _zoomTarget  = 1.0;

    let _dimAlpha  = 0.0;
    let _dimTarget = 0.0;

    let _flashAlpha  = 0.0;
    let _flashColor  = "#1a6641";
    let _pulsePhase  = 0.0;
    let _pulseActive = false;

    // ── Constantes ────────────────────────────────────────────────────────────

    const IDLE_FRAMES      = 8;
    const LERP_BOX         = 0.12;
    const LERP_ZOOM        = 0.08;
    const LERP_DIM         = 0.10;
    const ZOOM_THRESHOLD   = 0.20;
    const ZOOM_MAX         = 2.8;
    const BOX_PADDING      = 0.06;
    const ZOOM_IDENTITY    = 1.02; // limiar abaixo do qual não aplicamos zoom
    const MAX_EXPOSURE_AREA = 90000; // pixels — evita travar em mobile

    const CONFIRM_COLORS = {
        presente:  "#1a6641",
        atrasado:  "#e53e3e",
        duplicado: "#c8a84b",
        erro:      "#b83232"
    };

    // ── API Pública ───────────────────────────────────────────────────────────

    /**
     * Inicializa o scanner visual com os elementos de vídeo e canvas.
     * @param {HTMLVideoElement} videoEl
     * @param {HTMLCanvasElement} canvasEl
     */
    function init(videoEl, canvasEl) {
        if (_initialized) reset();

        _video  = videoEl;
        _canvas = canvasEl;
        _ctx    = canvasEl.getContext("2d", { willReadFrequently: true });

        _running     = true;
        _initialized = true;

        _rafId = requestAnimationFrame(_loop);
    }

    /**
     * Atualiza a posição e tamanho do QR detectado.
     * Chame com `null` quando nenhum QR for visível no frame atual.
     * @param {{ x: number, y: number, width: number, height: number } | null} box
     */
    function update(box) {
        if (!_running) return;

        if (!box) {
            _framesWithoutQr++;
            if (_framesWithoutQr > IDLE_FRAMES) {
                _qrVisible = false;
                _dimTarget = 0;
                _zoomTarget = 1;
                Object.assign(_target, { x: 0.5, y: 0.5, w: 0.4, h: 0.4 });
            }
            return;
        }

        _framesWithoutQr = 0;
        _qrVisible = true;

        const vw = _video?.videoWidth  || _canvas.width;
        const vh = _video?.videoHeight || _canvas.height;

        _target.x = (box.x + box.width  / 2) / vw;
        _target.y = (box.y + box.height / 2) / vh;
        _target.w = box.width  / vw;
        _target.h = box.height / vh;

        const size = Math.max(_target.w, _target.h);
        _zoomTarget = size < ZOOM_THRESHOLD
            ? Math.min(ZOOM_MAX, (ZOOM_THRESHOLD / size) * 1.2)
            : 1;

        _dimTarget = 0.55;
    }

    /**
     * Dispara feedback visual de confirmação (flash colorido).
     * @param {"presente"|"atrasado"|"duplicado"|"erro"} status
     */
    function confirm(status) {
        _flashColor  = CONFIRM_COLORS[status] || CONFIRM_COLORS.presente;
        _flashAlpha  = 1;
        _pulseActive = true;
        _pulsePhase  = 0;
    }

    /**
     * Para o loop de animação e libera referências de DOM.
     */
    function reset() {
        _running     = false;
        _initialized = false;

        if (_rafId) {
            cancelAnimationFrame(_rafId);
            _rafId = null;
        }

        if (_ctx && _canvas) {
            _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
        }

        // Libera referências para permitir GC
        _video  = null;
        _canvas = null;
        _ctx    = null;

        // Reseta estado de animação
        _qrVisible       = false;
        _framesWithoutQr = 0;
        _zoomCurrent     = 1.0;
        _zoomTarget      = 1.0;
        _dimAlpha        = 0.0;
        _dimTarget       = 0.0;
        _flashAlpha      = 0.0;
        _pulseActive     = false;
        _pulsePhase      = 0.0;
        Object.assign(_smooth, { x: 0.5, y: 0.5, w: 0.4, h: 0.4 });
        Object.assign(_target, { x: 0.5, y: 0.5, w: 0.4, h: 0.4 });
    }

    // ── Loop principal ────────────────────────────────────────────────────────

    function _loop() {
        if (!_running) return;
        _rafId = requestAnimationFrame(_loop);

        // Só roda animação e render quando o vídeo tem dados
        if (!_video || _video.readyState < 2) return;

        _syncCanvasSize();
        _animate();
        _render();
    }

    function _syncCanvasSize() {
        const rect = _canvas.getBoundingClientRect();
        if (_canvas.width !== rect.width || _canvas.height !== rect.height) {
            _canvas.width  = rect.width;
            _canvas.height = rect.height;
        }
    }

    // ── Animação (interpolação de valores) ────────────────────────────────────

    const _lerp = (a, b, t) => a + (b - a) * t;

    function _animate() {
        _smooth.x = _lerp(_smooth.x, _target.x, LERP_BOX);
        _smooth.y = _lerp(_smooth.y, _target.y, LERP_BOX);
        _smooth.w = _lerp(_smooth.w, _target.w, LERP_BOX);
        _smooth.h = _lerp(_smooth.h, _target.h, LERP_BOX);

        _zoomCurrent = _lerp(_zoomCurrent, _zoomTarget, LERP_ZOOM);
        _dimAlpha    = _lerp(_dimAlpha,    _dimTarget,  LERP_DIM);

        if (_flashAlpha > 0) _flashAlpha = Math.max(0, _flashAlpha - 0.04);

        if (_pulseActive) {
            _pulsePhase += 0.18;
            if (_pulsePhase > Math.PI * 4) {
                _pulseActive = false;
                _pulsePhase  = 0;
            }
        }
    }

    // ── Render ────────────────────────────────────────────────────────────────

    function _render() {
        if (!_ctx || !_canvas) return;

        const cw = _canvas.width;
        const ch = _canvas.height;

        _ctx.clearRect(0, 0, cw, ch);

        _drawZoomedVideo(cw, ch);
        _drawDimOverlay(cw, ch);
        _drawTrackingBox(cw, ch);

        if (_qrVisible && _dimAlpha > 0.1) {
            _applyLocalExposure(cw, ch);
        }

        if (_flashAlpha > 0.01) {
            _drawFlash(cw, ch);
        }
    }

    function _drawZoomedVideo(cw, ch) {
        const zoom = _zoomCurrent;

        if (zoom <= ZOOM_IDENTITY) {
            _ctx.drawImage(_video, 0, 0, cw, ch);
            return;
        }

        const vw = _video.videoWidth;
        const vh = _video.videoHeight;

        const cropW = vw / zoom;
        const cropH = vh / zoom;

        // Centraliza o crop sobre o ponto de interesse suavizado
        let srcX = _smooth.x * vw - cropW / 2;
        let srcY = _smooth.y * vh - cropH / 2;

        // Garante que o crop não ultrapasse as bordas do vídeo
        srcX = Math.max(0, Math.min(vw - cropW, srcX));
        srcY = Math.max(0, Math.min(vh - cropH, srcY));

        _ctx.drawImage(_video, srcX, srcY, cropW, cropH, 0, 0, cw, ch);
    }

    function _drawDimOverlay(cw, ch) {
        if (_dimAlpha < 0.01) return;

        const { bx, by, bw, bh } = _getBoxCoords(cw, ch);

        _ctx.save();
        _ctx.beginPath();
        _ctx.rect(0, 0, cw, ch);
        _ctx.rect(bx, by, bw, bh);
        _ctx.clip("evenodd");

        _ctx.fillStyle = `rgba(10,10,10,${_dimAlpha * 0.72})`;
        _ctx.fillRect(0, 0, cw, ch);
        _ctx.restore();
    }

    function _drawTrackingBox(cw, ch) {
        const { bx, by, bw, bh } = _getBoxCoords(cw, ch);

        let color;
        if (_flashAlpha > 0.05) {
            color = _flashColor;
        } else if (_qrVisible) {
            color = "#1a6641";
        } else {
            color = "rgba(180,180,180,0.5)";
        }

        _ctx.strokeStyle = color;
        _ctx.lineWidth   = _qrVisible ? 2.5 : 1.5;
        _ctx.strokeRect(bx, by, bw, bh);
    }

    function _applyLocalExposure(cw, ch) {
        const { bx, by, bw, bh } = _getBoxCoords(cw, ch);

        // Garante dimensões inteiras e positivas para getImageData
        const x = Math.max(0, Math.floor(bx));
        const y = Math.max(0, Math.floor(by));
        const w = Math.min(Math.ceil(bw), cw - x);
        const h = Math.min(Math.ceil(bh), ch - y);

        if (w <= 0 || h <= 0 || w * h > MAX_EXPOSURE_AREA) return;

        // getImageData pode lançar SecurityError se o canvas estiver "tainted"
        // (vídeo cross-origin). Capturamos o erro sem engolir silenciosamente,
        // e desativamos a exposição local para não tentar novamente em cada frame.
        let imageData;
        try {
            imageData = _ctx.getImageData(x, y, w, h);
        } catch (e) {
            // Canvas tainted por restrição de CORS — desativa exposição local
            // redefinindo _dimTarget para evitar entrar neste path novamente.
            _dimTarget = 0;
            return;
        }

        const data = imageData.data;

        // Amostragem para calcular brilho médio (1 em cada 4 pixels)
        let sum = 0, count = 0;
        for (let i = 0; i < data.length; i += 16) {
            sum += data[i];
            count++;
        }

        if (count === 0) return;

        const avg   = sum / count;
        const delta = (160 - avg) * 0.35;

        for (let i = 0; i < data.length; i += 4) {
            data[i]     = Math.min(255, Math.max(0, data[i]     + delta));
            data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + delta));
            data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + delta));
            // data[i + 3] = alpha, não alterado
        }

        _ctx.putImageData(imageData, x, y);
    }

    function _drawFlash(cw, ch) {
        _ctx.globalAlpha = _flashAlpha * 0.3;
        _ctx.fillStyle   = _flashColor;
        _ctx.fillRect(0, 0, cw, ch);
        _ctx.globalAlpha = 1;
    }

    // ── Utilitário de coordenadas ──────────────────────────────────────────────

    function _getBoxCoords(cw, ch) {
        // Com zoom ativo, a caixa fica sempre centrada na tela
        const relX = _zoomCurrent > ZOOM_IDENTITY ? 0.5 : _smooth.x;
        const relY = _zoomCurrent > ZOOM_IDENTITY ? 0.5 : _smooth.y;

        const bw = (_smooth.w + BOX_PADDING * 2) * cw;
        const bh = (_smooth.h + BOX_PADDING * 2) * ch;

        return {
            bx: relX * cw - bw / 2,
            by: relY * ch - bh / 2,
            bw,
            bh
        };
    }

    // ── Export ────────────────────────────────────────────────────────────────

    return { init, update, confirm, reset };

})();