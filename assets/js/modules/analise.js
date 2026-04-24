;(function () { // IIFE para evitar poluição do escopo global

    // ── Estado ────────────────────────────────────────────────────────────────

    const state = {
        registros: [],
        alunos: new Map(),
        charts: {}
    };

    // ── Constantes ────────────────────────────────────────────────────────────

    const COLORS = {
        presente: "#1a6641",
        atrasado: "#e53e3e",
        grid: "rgba(255,255,255,0.05)",
        turnos: {
            "Manhã":  "#1a6641",
            "Tarde":  "#d4a017",
            "Noite":  "#3a3a6e",
            "Outros": "#888"
        }
    };

    const TURNOS = ["Manhã", "Tarde", "Noite"];

    const SORTERS = {
        presencas: (a, b) => b.presencas - a.presencas,
        atrasos:   (a, b) => b.atrasos   - a.atrasos,
        nome:      (a, b) => a.nome.localeCompare(b.nome)
    };

    // ── Helper: seletor por ID ────────────────────────────────────────────────
    // Declarado antes de qualquer uso — evitava ReferenceError com const hoisting.

    function getEl(id) {
        return document.getElementById(id);
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", () => {
        setDefaultDates();
        bindEvents();
        carregar();
    });

    function bindEvents() {
        getEl("btnFiltrar").onclick  = carregar;
        getEl("btnLimpar").onclick   = limparFiltros;
        getEl("buscaAluno").oninput  = renderTabela;
        getEl("ordenarPor").onchange = renderTabela;
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────

    async function carregar() {
        try {
            const { inicio, fim, turno } = getFiltros();

            let query = db
                .from("presencas")
                .select("horario_chegada, status, aluno_id, alunos(nome,turma,turno)")
                .order("horario_chegada");

            if (inicio) query = query.gte("horario_chegada", `${inicio}T00:00:00`);
            if (fim)    query = query.lte("horario_chegada", `${fim}T23:59:59`);

            const { data, error } = await query;
            if (error) throw error;

            state.registros = (data || []).filter(p =>
                !turno || p.alunos?.turno === turno
            );

            processar();
            render();

        } catch (e) {
            Notif.erro("Erro ao carregar", e.message);
        }
    }

    // ── Processamento ─────────────────────────────────────────────────────────

    function processar() {
        state.alunos.clear();

        for (const p of state.registros) {
            const id = p.aluno_id;
            const a  = p.alunos || {};

            if (!state.alunos.has(id)) {
                state.alunos.set(id, {
                    nome:     a.nome  || "—",
                    turma:    a.turma || "—",
                    turno:    a.turno || "—",
                    presencas: 0,
                    atrasos:   0
                });
            }

            const aluno = state.alunos.get(id);
            aluno.presencas++;
            if (p.status === "atrasado") aluno.atrasos++;
        }
    }

    // ── Render raiz ───────────────────────────────────────────────────────────

    function render() {
        renderStats();
        renderCharts();
        renderTabela();
    }

    // ── Stats ─────────────────────────────────────────────────────────────────

    function renderStats() {
        const total    = state.registros.length;
        const atrasos  = state.registros.filter(p => p.status === "atrasado").length;
        const pontuais = total - atrasos;

        updateText("statTotal",        total);
        updateText("statAtrasos",      atrasos);
        updateText("statPontualidade", total ? `${Math.round(pontuais / total * 100)}%` : "0%");
        updateText("statAlunos",       state.alunos.size);
    }

    // ── Charts ────────────────────────────────────────────────────────────────

    function renderCharts() {
        renderTempo();
        renderPizza();
        renderTurno();
        renderAtrasoTurno();
    }

    function destroyChart(name) {
        try {
            if (state.charts[name]) {
                state.charts[name].destroy();
                state.charts[name] = null;
            }
        } catch (e) {
            // Canvas pode ter sido removido do DOM; ignora silenciosamente.
            state.charts[name] = null;
        }
    }

    function renderTempo() {
        destroyChart("tempo");

        const map = {};

        for (const p of state.registros) {
            const dia = p.horario_chegada.split("T")[0];
            if (!map[dia]) map[dia] = { p: 0, a: 0 };
            if (p.status === "atrasado") {
                map[dia].a++;
            } else {
                map[dia].p++;
            }
        }

        const dias = Object.keys(map).sort();

        state.charts.tempo = new Chart(getEl("chartTempo"), {
            type: "line",
            data: {
                labels: dias.map(formatDate),
                datasets: [
                    {
                        label: "Presentes",
                        data: dias.map(d => map[d].p),
                        borderColor: COLORS.presente,
                        backgroundColor: COLORS.presente + "22",
                        tension: .3,
                        fill: true
                    },
                    {
                        label: "Atrasados",
                        data: dias.map(d => map[d].a),
                        borderColor: COLORS.atrasado,
                        backgroundColor: COLORS.atrasado + "22",
                        tension: .3,
                        fill: true
                    }
                ]
            },
            options: chartBase()
        });
    }

    function renderPizza() {
        destroyChart("pizza");

        const total   = state.registros.length;
        const atrasos = state.registros.filter(p => p.status === "atrasado").length;

        state.charts.pizza = new Chart(getEl("chartPizza"), {
            type: "doughnut",
            data: {
                labels: ["Pontuais", "Atrasados"],
                datasets: [{
                    data: [total - atrasos, atrasos],
                    backgroundColor: [COLORS.presente, COLORS.atrasado]
                }]
            },
            options: chartBase(false)
        });
    }

    function renderTurno() {
        destroyChart("turno");

        state.charts.turno = new Chart(getEl("chartTurno"), {
            type: "bar",
            data: {
                labels: TURNOS,
                datasets: [{
                    data: TURNOS.map(t =>
                        state.registros.filter(p => p.alunos?.turno === t).length
                    ),
                    backgroundColor: TURNOS.map(t => (COLORS.turnos[t] || COLORS.turnos["Outros"]) + "cc")
                }]
            },
            options: chartBase()
        });
    }

    function renderAtrasoTurno() {
        destroyChart("atrasoTurno");

        state.charts.atrasoTurno = new Chart(getEl("chartAtrasoTurno"), {
            type: "bar",
            data: {
                labels: TURNOS,
                datasets: [{
                    data: TURNOS.map(t =>
                        state.registros.filter(p =>
                            p.alunos?.turno === t && p.status === "atrasado"
                        ).length
                    ),
                    backgroundColor: COLORS.atrasado
                }]
            },
            options: chartBase()
        });
    }

    function chartBase(grid = true) {
        return {
            responsive: true,
            plugins: {
                legend: { position: "bottom" }
            },
            scales: grid ? {
                x: { grid: { color: COLORS.grid } },
                y: { beginAtZero: true, grid: { color: COLORS.grid } }
            } : {}
        };
    }

    // ── Tabela ────────────────────────────────────────────────────────────────

    function renderTabela() {
        const busca   = (getEl("buscaAluno")?.value || "").toLowerCase();
        const ordenar = getEl("ordenarPor")?.value || "presencas";

        let lista = [...state.alunos.values()]
            .filter(a => a.nome.toLowerCase().includes(busca));

        const sorter = SORTERS[ordenar] || SORTERS.presencas;
        lista.sort(sorter);

        const tbody = getEl("tabelaAlunos");
        if (!tbody) return;

        if (!lista.length) {
            tbody.innerHTML = `<tr><td colspan="7">Nenhum resultado</td></tr>`;
            return;
        }

        // Usa índice sequencial da lista filtrada (não do Map original)
        tbody.innerHTML = lista.map((a, i) => renderRow(a, i)).join("");
    }

    function renderRow(a, i) {
        // pct é sempre um número inteiro — seguro inserir diretamente
        const pct = a.presencas
            ? Math.round((a.presencas - a.atrasos) / a.presencas * 100)
            : 0;

        return `
        <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(a.nome)}</td>
            <td>${escapeHtml(a.turma)}</td>
            <td>${escapeHtml(a.turno)}</td>
            <td>${a.presencas}</td>
            <td>${a.atrasos}</td>
            <td>${pct}%</td>
        </tr>`;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function updateText(id, val) {
        const el = getEl(id);
        if (el) el.textContent = val;
    }

    function formatDate(d) {
        const [, m, day] = d.split("-");
        return `${day}/${m}`;
    }

    function getFiltros() {
        return {
            inicio: getEl("filtroInicio")?.value || "",
            fim:    getEl("filtroFim")?.value    || "",
            turno:  getEl("filtroTurno")?.value  || ""
        };
    }

    function limparFiltros() {
        setDefaultDates();
        const turno  = getEl("filtroTurno");
        const busca  = getEl("buscaAluno");
        if (turno) turno.value = "";
        if (busca) busca.value = "";
        carregar();
    }

    function setDefaultDates() {
        const hoje  = new Date();
        const fim   = hoje.toISOString().split("T")[0];
        const inicio = new Date(hoje - 29 * 86400000).toISOString().split("T")[0];

        const elInicio = getEl("filtroInicio");
        const elFim    = getEl("filtroFim");
        if (elInicio) elInicio.value = inicio;
        if (elFim)    elFim.value    = fim;
    }

    /**
     * Sanitiza string para inserção em innerHTML.
     * Renomeado de `escape` para evitar shadowing de `window.escape` (deprecated).
     */
    function escapeHtml(str) {
        return String(str).replace(/[&<>"]/g, s => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;"
        }[s]));
    }

})();