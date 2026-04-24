;(function () { // IIFE para isolar estado do escopo global

    // ── Estado ────────────────────────────────────────────────────────────────
    // Renomeado internamente para evitar conflito com `state` de analise.js
    // caso ambos sejam carregados na mesma página.

    const state = {
        registros: [],
        modal: { data: null, turno: null, registros: [] }
    };

    // ── Init ──────────────────────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", () => {
        bind();
        carregar();
    });

    function bind() {
        getEl("filtroData").oninput  = render;
        getEl("filtroTurno").onchange = render;
        getEl("btnLimpar").onclick   = limparFiltros;

        getEl("modalOverlay").onclick = e => {
            if (e.target.id === "modalOverlay") closeModal();
        };

        getEl("modalClose").onclick = closeModal;
        getEl("btnPDF").onclick     = gerarPDFModal;

        // Delegação de eventos para os botões PDF gerados dinamicamente via innerHTML.
        // Corrige o bug onde os botões eram criados mas nunca recebiam listeners.
        getEl("historicoContainer").addEventListener("click", e => {
            const btn = e.target.closest(".pdf-btn");
            if (btn) {
                const card = btn.closest(".hist-turno-card");
                if (card) {
                    openModal(card.dataset.dia, card.dataset.turno);
                }
                return;
            }

            // Clique em qualquer área do card de turno abre o modal
            const card = e.target.closest(".hist-turno-card");
            if (card) {
                openModal(card.dataset.dia, card.dataset.turno);
            }
        });
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────

    async function carregar() {
        try {
            const { data, error } = await db
                .from("presencas")
                .select("horario_chegada, alunos(nome,turma,turno)")
                .order("horario_chegada", { ascending: false });

            if (error) throw error;

            state.registros = data || [];

            renderStats();
            render();

        } catch (e) {
            Notif.erro("Erro ao carregar", e.message);
            renderErro();
        }
    }

    // ── Stats ─────────────────────────────────────────────────────────────────

    function renderStats() {
        const dias = new Set(state.registros.map(r => r.horario_chegada.slice(0, 10)));

        updateText("totalDias",      dias.size);
        updateText("totalRegistros", state.registros.length);

        // `.at(-1)` retorna o mais antigo (order ascending = false, então o array
        // vem decrescente; o último item é o mais antigo = "primeiro dia").
        const ultimo = state.registros.at(-1);
        updateText("primeiroDia", ultimo ? formatDate(ultimo.horario_chegada) : "—");
    }

    // ── Render ────────────────────────────────────────────────────────────────

    function render() {
        const dados = filtrar();

        if (!dados.length) {
            renderEmpty();
            return;
        }

        const agrupado = agrupar(dados);
        getEl("historicoContainer").innerHTML = renderDias(agrupado);
    }

    // ── Filtro ────────────────────────────────────────────────────────────────

    function filtrar() {
        const data  = getEl("filtroData")?.value  || "";
        const turno = getEl("filtroTurno")?.value || "";

        return state.registros.filter(r =>
            (!data  || r.horario_chegada.startsWith(data)) &&
            (!turno || r.alunos?.turno === turno)
        );
    }

    // ── Agrupamento ───────────────────────────────────────────────────────────

    function agrupar(lista) {
        const map = new Map();

        for (const r of lista) {
            const dia   = r.horario_chegada.slice(0, 10);
            const turno = r.alunos?.turno || "Outros";

            if (!map.has(dia)) map.set(dia, new Map());
            const turnos = map.get(dia);

            if (!turnos.has(turno)) turnos.set(turno, []);
            turnos.get(turno).push(r);
        }

        return map;
    }

    // ── Render HTML ───────────────────────────────────────────────────────────

    function renderDias(map) {
        return [...map.keys()]
            .sort((a, b) => b.localeCompare(a))
            .map(dia => renderDia(dia, map.get(dia)))
            .join("");
    }

    function renderDia(dia, turnos) {
        const total = [...turnos.values()].reduce((s, arr) => s + arr.length, 0);

        return `
        <div class="hist-dia-card">
            <div class="hist-dia-header">
                <div>
                    <span class="hist-dia-label">${formatDate(dia)}</span>
                    <span class="hist-dia-sub">${formatWeekday(dia)}</span>
                </div>
                <span class="hist-dia-total">${total}</span>
            </div>
            <div class="hist-turnos-grid">
                ${[...turnos.keys()].map(t => renderTurno(dia, t, turnos.get(t))).join("")}
            </div>
        </div>`;
    }

    function renderTurno(dia, turno, regs) {
        const preview = regs.slice(0, 3).map(r => escapeHtml(r.alunos?.nome || "—")).join(", ");
        const extra   = regs.length > 3 ? ` +${regs.length - 3}` : "";

        // data-dia e data-turno são lidos pelo listener delegado em bind()
        return `
        <div class="hist-turno-card" data-dia="${escapeHtml(dia)}" data-turno="${escapeHtml(turno)}">
            <div class="hist-turno-header">
                <span class="badge">${escapeHtml(turno)}</span>
                <span>${regs.length}</span>
                <button class="btn sm pdf-btn" type="button">PDF</button>
            </div>
            <div class="hist-turno-preview">${preview}${extra}</div>
        </div>`;
    }

    // ── Modal ─────────────────────────────────────────────────────────────────

    function openModal(dia, turno) {
        if (!dia || !turno) return;

        const regs = state.registros
            .filter(r => r.horario_chegada.startsWith(dia) && r.alunos?.turno === turno)
            .sort((a, b) => a.horario_chegada.localeCompare(b.horario_chegada));

        state.modal = { data: dia, turno, registros: regs };

        updateText("modalTituloHist", `${formatDate(dia)} — ${turno}`);

        getEl("modalListaHist").innerHTML = regs.map(r => `
            <tr>
                <td>${escapeHtml(r.alunos?.nome)}</td>
                <td>${escapeHtml(r.alunos?.turma)}</td>
                <td>${formatTime(r.horario_chegada)}</td>
            </tr>
        `).join("");

        getEl("modalOverlay").style.display = "flex";
    }

    function closeModal() {
        getEl("modalOverlay").style.display = "none";
    }

    // ── PDF ───────────────────────────────────────────────────────────────────

    function gerarPDFModal() {
        gerarPDF(state.modal.data, state.modal.turno, state.modal.registros);
    }

    function gerarPDF(dia, turno, regs) {
        if (!dia || !regs || !regs.length) return;

        if (!window.jspdf) {
            Notif.erro("PDF indisponível", "Biblioteca jsPDF não carregada.");
            return;
        }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

        const PW  = 210; // largura A4
        const PH  = 297; // altura A4
        const ML  = 14;  // margem esquerda
        const MR  = 14;  // margem direita
        const CW  = PW - ML - MR; // largura útil

        // ── Paleta ────────────────────────────────────────────────────────────
        const COR_VERDE      = [26,  102,  65];   // #1a6641
        const COR_VERDE_LIGHT= [235, 245, 240];   // fundo cabeçalho da tabela
        const COR_CINZA_LINHA= [245, 245, 245];   // linha zebrada
        const COR_BORDA      = [200, 200, 200];
        const COR_TEXTO      = [30,  30,  30];
        const COR_SUBTEXTO   = [100, 100, 100];
        const COR_BRANCO     = [255, 255, 255];

        // ── Helpers ───────────────────────────────────────────────────────────

        function setFill(rgb)   { doc.setFillColor(...rgb); }
        function setDraw(rgb)   { doc.setDrawColor(...rgb); }
        function setTextC(rgb)  { doc.setTextColor(...rgb); }
        function setFont(style, size) {
            doc.setFont("helvetica", style);
            doc.setFontSize(size);
        }

        function rect(x, y, w, h, fill) {
            setFill(fill);
            doc.rect(x, y, w, h, "F");
        }

        function hline(x1, x2, y, rgb, lw = 0.25) {
            setDraw(rgb);
            doc.setLineWidth(lw);
            doc.line(x1, y, x2, y);
        }

        // ── CABEÇALHO ─────────────────────────────────────────────────────────

        // Faixa verde superior
        rect(0, 0, PW, 32, COR_VERDE);

        // Logo (tenta carregar; se falhar, desenha placeholder)
        try {
            doc.addImage("/assets/images/lllogo.png", "PNG", ML, 4, 20, 20);
        } catch (_) {
            // Placeholder circular caso a imagem não esteja acessível no contexto jsPDF
            setFill(COR_BRANCO);
            doc.circle(ML + 10, 14, 10, "F");
            setFont("bold", 8);
            setTextC([26, 102, 65]);
            doc.text("LOGO", ML + 10, 15.5, { align: "center" });
        }

        // Nome do colégio
        setFont("bold", 11);
        setTextC(COR_BRANCO);
        doc.text("Colégio Estadual Desembargador Antônio F.F da Costa", ML + 25, 12);

        setFont("normal", 8);
        setTextC([200, 230, 215]);
        doc.text("Sistema de Controle de Presença", ML + 25, 18);

        // Linha dourada decorativa abaixo da faixa verde
        rect(0, 32, PW, 1.5, [212, 160, 23]); // dourado

        // ── BLOCO DE INFORMAÇÕES DO RELATÓRIO ─────────────────────────────────

        let y = 42;

        setFont("bold", 14);
        setTextC(COR_VERDE);
        doc.text("Relatório de Presença", ML, y);
        y += 7;

        hline(ML, PW - MR, y, COR_VERDE, 0.5);
        y += 5;

        // Metadados em 2 colunas
        const metaCol2 = ML + CW / 2;

        function metaItem(label, value, x, cy) {
            setFont("bold", 8);
            setTextC(COR_SUBTEXTO);
            doc.text(label.toUpperCase(), x, cy);
            setFont("normal", 9);
            setTextC(COR_TEXTO);
            doc.text(value, x, cy + 5);
        }

        metaItem("Data",           formatDate(dia),          ML,       y);
        metaItem("Turno",          turno,                    metaCol2, y);
        y += 12;
        metaItem("Total de alunos", String(regs.length),     ML,       y);
        metaItem("Emitido em",     new Date().toLocaleString("pt-BR"), metaCol2, y);
        y += 14;

        hline(ML, PW - MR, y, COR_BORDA);
        y += 6;

        // ── TABELA ────────────────────────────────────────────────────────────

        // Definição de colunas: [label, largura relativa, alinhamento]
        const COLS = [
            { label: "#",          w: 10,  align: "center" },
            { label: "Nome",       w: 72,  align: "left"   },
            { label: "Turma",      w: 28,  align: "center" },
            { label: "Horário",    w: 28,  align: "center" },
            { label: "Status",     w: 30,  align: "center" },
        ];

        const ROW_H    = 8;
        const HEAD_H   = 9;
        const FONT_ROW = 8.5;

        // Cabeçalho da tabela
        rect(ML, y, CW, HEAD_H, COR_VERDE);

        let cx = ML;
        setFont("bold", 8.5);
        setTextC(COR_BRANCO);
        for (const col of COLS) {
            const tx = col.align === "center" ? cx + col.w / 2 : cx + 2;
            doc.text(col.label, tx, y + 6, { align: col.align === "center" ? "center" : "left" });
            cx += col.w;
        }
        y += HEAD_H;

        // Linhas de dados
        regs.forEach((r, i) => {
            // Quebra de página
            if (y + ROW_H > PH - 20) {
                _addPageFooter(doc, PW, PH, ML, MR, COR_VERDE, COR_SUBTEXTO, dia, turno);
                doc.addPage();
                y = 20;

                // Repete cabeçalho da tabela
                rect(ML, y, CW, HEAD_H, COR_VERDE);
                cx = ML;
                setFont("bold", 8.5);
                setTextC(COR_BRANCO);
                for (const col of COLS) {
                    const tx = col.align === "center" ? cx + col.w / 2 : cx + 2;
                    doc.text(col.label, tx, y + 6, { align: col.align === "center" ? "center" : "left" });
                    cx += col.w;
                }
                y += HEAD_H;
            }

            // Fundo zebrado
            const bgRow = i % 2 === 0 ? COR_BRANCO : COR_CINZA_LINHA;
            rect(ML, y, CW, ROW_H, bgRow);

            // Borda inferior da linha
            hline(ML, ML + CW, y + ROW_H, COR_BORDA, 0.15);

            const status   = r.status || "presente";
            const nome     = r.alunos?.nome  || "—";
            const turma    = r.alunos?.turma || "—";
            const horario  = formatTime(r.horario_chegada);

            const statusLabel = status === "atrasado" ? "Atrasado" : "Presente";
            const statusCor   = status === "atrasado" ? [180, 50, 50] : [26, 102, 65];

            const valores = [String(i + 1), nome, turma, horario, statusLabel];

            cx = ML;
            setFont("normal", FONT_ROW);
            for (let c = 0; c < COLS.length; c++) {
                const col = COLS[c];
                const tx  = col.align === "center" ? cx + col.w / 2 : cx + 2;
                const ty  = y + ROW_H - 2.2;

                // Coluna de status recebe cor especial
                if (c === 4) {
                    setFont("bold", FONT_ROW);
                    setTextC(statusCor);
                } else {
                    setFont("normal", FONT_ROW);
                    setTextC(COR_TEXTO);
                }

                // Trunca texto longo para caber na coluna
                const maxW  = col.w - 4;
                const texto = doc.splitTextToSize(String(valores[c]), maxW)[0] || "";
                doc.text(texto, tx, ty, { align: col.align === "center" ? "center" : "left" });
                cx += col.w;
            }

            y += ROW_H;
        });

        // Borda da tabela inteira
        setDraw(COR_BORDA);
        doc.setLineWidth(0.4);
        doc.rect(ML, 42 + 7 + 5 + 12 + 14 + 6, CW, (HEAD_H + ROW_H * regs.length), "S");

        // ── RODAPÉ ────────────────────────────────────────────────────────────
        _addPageFooter(doc, PW, PH, ML, MR, COR_VERDE, COR_SUBTEXTO, dia, turno);

        // ── SALVAR ────────────────────────────────────────────────────────────
        doc.save(`relatorio_${dia}_${turno.toLowerCase()}.pdf`);
        Notif.sucesso("PDF gerado", `Relatório de ${turno} em ${formatDate(dia)} exportado.`);
    }

    function _addPageFooter(doc, PW, PH, ML, MR, COR_VERDE, COR_SUBTEXTO, dia, turno) {
        const footerY = PH - 12;

        doc.setDrawColor(...COR_VERDE);
        doc.setLineWidth(0.4);
        doc.line(ML, footerY - 3, PW - MR, footerY - 3);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(...COR_SUBTEXTO);
        doc.text(
            "Colégio Estadual Desembargador Antônio F.F da Costa  •  Sistema de Presença",
            PW / 2,
            footerY,
            { align: "center" }
        );
        doc.text(
            `Relatório: ${dia} — ${turno}`,
            ML,
            footerY
        );
        doc.text(
            `Página ${doc.internal.getCurrentPageInfo().pageNumber}`,
            PW - MR,
            footerY,
            { align: "right" }
        );
    }

    // ── UI States ─────────────────────────────────────────────────────────────

    function renderEmpty() {
        getEl("historicoContainer").innerHTML = `<div class="empty">Nenhum registro</div>`;
    }

    function renderErro() {
        getEl("historicoContainer").innerHTML = `<div class="empty">Erro ao carregar</div>`;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function getEl(id) {
        return document.getElementById(id);
    }

    function updateText(id, v) {
        const el = getEl(id);
        if (el) el.textContent = v;
    }

    function formatDate(d) {
        // Recebe "YYYY-MM-DD" ou ISO string completa
        const parte = d.slice(0, 10);
        const [y, m, day] = parte.split("-");
        return `${day}/${m}/${y}`;
    }

    function formatWeekday(d) {
        // Corrige bug de fuso horário: "2024-01-15" interpretado como UTC
        // deslocava o dia em locales com offset negativo (ex: Brasil).
        // Adiciona T12:00:00 para garantir interpretação como hora local.
        return new Date(`${d}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "long" });
    }

    function formatTime(d) {
        return new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }

    /**
     * Sanitiza string para inserção em innerHTML.
     * Renomeado de `escape` para evitar shadowing de `window.escape` (deprecated).
     */
    function escapeHtml(str) {
        return String(str || "—").replace(/[&<>"]/g, s => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;"
        }[s]));
    }

    function limparFiltros() {
        const data  = getEl("filtroData");
        const turno = getEl("filtroTurno");
        if (data)  data.value  = "";
        if (turno) turno.value = "";
        render();
    }

})();