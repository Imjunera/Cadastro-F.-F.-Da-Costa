// ===================== STATE =====================
// Prefixado como _cadastroState para evitar colisão com outros módulos
// que também declaram `state` no escopo global (analise.js, historico.js).
const _cadastroState = {
    alunos: [],
    editandoId: null,
    loading: false
}

// ================= INIT =================
document.addEventListener("DOMContentLoaded", () => {
    _bindCadastro()
    _initCadastro()
})

function _bindCadastro() {
    _el("btnSalvar").onclick   = _salvar
    _el("btnCancelar").onclick = _limparForm
    _el("busca").oninput       = _debounce(_renderLista, 200)
    _el("btnRelatorio").onclick = _gerarRelatorio
    _el("btnApagar").onclick   = _apagarTodos

    // Delegação de clique para editar/deletar na tabela
    // Escopo restrito ao tbody para não disparar em cliques fora
    const tbody = _el("listaAlunos")
    if (tbody) {
        tbody.addEventListener("click", async (e) => {
            const edit = e.target.closest("[data-edit]")?.dataset.edit
            const del  = e.target.closest("[data-del]")?.dataset.del
            if (edit) _editar(edit)
            else if (del) _excluir(del)
        })
    }
}

async function _initCadastro() {
    await _carregar()
    _renderLista()
    _carregarPresentesHoje()
}

// ================= FETCH =================
async function _carregar() {
    try {
        const { data, error } = await db
            .from("alunos")
            .select("id,nome,idade,turma,turno,qr")
            .order("nome", { ascending: true })

        if (error) throw error
        _cadastroState.alunos = data || []

    } catch (e) {
        Notif.erro("Erro ao carregar", e.message)
        _cadastroState.alunos = []
    }
}

// ================= PRESENTES HOJE =================
async function _carregarPresentesHoje() {
    try {
        const hoje = new Date().toISOString().slice(0, 10)

        const { count, error } = await db
            .from("presencas")
            .select("*", { count: "exact", head: true })
            .gte("horario_chegada", hoje + "T00:00:00")
            .lte("horario_chegada", hoje + "T23:59:59")

        if (error) throw error
        _updateText("presentesHoje", count || 0)

    } catch {
        _updateText("presentesHoje", "—")
    }
}

// ================= SAVE =================
async function _salvar() {
    if (_cadastroState.loading) return
    if (!_validar()) return

    _cadastroState.loading = true
    _toggleBtn(true)

    const payload = _getForm()

    try {
        if (_cadastroState.editandoId) {
            await _atualizar(payload)
        } else {
            await _criar(payload)
        }

        await _carregar()
        _renderLista()
        _limparForm()

    } catch (e) {
        Notif.erro("Erro ao salvar", e.message)
    } finally {
        _cadastroState.loading = false
        _toggleBtn(false)
    }
}

async function _criar(payload) {
    const { data, error } = await db
        .from("alunos")
        .insert([payload])
        .select()
        .single()

    if (error) throw error

    await _atualizarQR(data.id)
    Notif.sucesso("Aluno cadastrado", payload.nome)
}

async function _atualizar(payload) {
    const { error } = await db
        .from("alunos")
        .update(payload)
        .eq("id", _cadastroState.editandoId)

    if (error) throw error

    await _atualizarQR(_cadastroState.editandoId)
    Notif.sucesso("Aluno atualizado", payload.nome)
}

// ================= QR =================
async function _atualizarQR(id) {
    const qr = _gerarQR(id)
    if (!qr) return
    await db.from("alunos").update({ qr }).eq("id", id)
}

function _gerarQR(id) {
    // Corrigido: ENV.BASE_URL (era BASE_URL — variável inexistente)
    const url = `${ENV.BASE_URL}/registrar.html?id=${id}`

    const el = document.createElement("div")
    el.style.cssText = "position:absolute;left:-9999px;top:-9999px;"
    document.body.appendChild(el)

    try {
        new QRCode(el, { text: url, width: 200, height: 200 })
        const canvas = el.querySelector("canvas")
        return canvas?.toDataURL() || ""
    } finally {
        el.remove()
    }
}

// ================= VALIDATION =================
function _validar() {
    const { nome, idade, turma, turno } = _getForm()

    if (!nome || !turma || !turno) {
        Notif.aviso("Campos obrigatórios")
        return false
    }

    if (isNaN(idade) || idade < 1 || idade > 99) {
        Notif.aviso("Idade inválida")
        return false
    }

    return true
}

function _getForm() {
    return {
        nome:  _el("nome").value.trim(),
        idade: parseInt(_el("idade").value, 10),
        turma: _el("turma").value,
        turno: _el("turno").value
    }
}

// ================= RENDER =================
function _renderLista() {
    const busca = (_el("busca")?.value || "").toLowerCase()

    const lista = _cadastroState.alunos.filter(a =>
        a.nome.toLowerCase().includes(busca)
    )

    _updateText("totalAlunos", _cadastroState.alunos.length)

    const tbody = _el("listaAlunos")
    if (!tbody) return

    tbody.innerHTML = lista.length
        ? lista.map(_rowAluno).join("")
        : `<tr><td colspan="6" class="table-empty">Nenhum aluno</td></tr>`
}

function _rowAluno(a) {
    // Corrigido: classe qr-img (era .qr — inexistente no CSS)
    return `
    <tr>
        <td>${_escHtml(a.nome)}</td>
        <td>${a.idade ?? "—"}</td>
        <td>${_escHtml(a.turma)}</td>
        <td>${_escHtml(a.turno)}</td>
        <td>${a.qr ? `<img src="${a.qr}" class="qr-img" alt="QR Code de ${_escHtml(a.nome)}">` : "—"}</td>
        <td>
            <button data-edit="${a.id}" class="btn sm" aria-label="Editar ${_escHtml(a.nome)}">✏️</button>
            <button data-del="${a.id}"  class="btn danger sm" aria-label="Excluir ${_escHtml(a.nome)}">🗑️</button>
        </td>
    </tr>`
}

// ================= EDIT =================
function _editar(id) {
    const a = _cadastroState.alunos.find(x => x.id === id)
    if (!a) return

    _el("nome").value  = a.nome
    _el("idade").value = a.idade || ""
    _el("turma").value = a.turma || ""
    _el("turno").value = a.turno || ""

    _cadastroState.editandoId = id
    _updateText("tituloForm", `Editando: ${a.nome}`)
}

// ================= DELETE =================
async function _excluir(id) {
    const ok = await Notif.confirmar("Excluir aluno?")
    if (!ok) return

    const { error } = await db.from("alunos").delete().eq("id", id)
    if (error) { Notif.erro("Erro ao excluir", error.message); return }

    await _carregar()
    _renderLista()
}

// ================= DELETE ALL =================
async function _apagarTodos() {
    const ok = await Notif.confirmar("Apagar todos os alunos? Esta ação é irreversível.")
    if (!ok) return

    const { error } = await db.from("alunos").delete().neq("id", "0")
    if (error) { Notif.erro("Erro ao apagar", error.message); return }

    _cadastroState.alunos = []
    _renderLista()
}

// ================= PDF =================
async function _gerarRelatorio() {
    // jsPDF já carregado via <script> em historico.html e páginas que precisam.
    // Fallback para dynamic import se não estiver disponível.
    let jsPDF = window.jspdf?.jsPDF

    if (!jsPDF) {
        try {
            const mod = await import("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.es.min.js")
            jsPDF = mod.jsPDF
        } catch {
            Notif.erro("jsPDF não disponível", "Recarregue a página e tente novamente.")
            return
        }
    }

    const doc = new jsPDF()

    let y = 20
    doc.text("Relatório de Alunos", 20, y)

    _cadastroState.alunos.forEach(a => {
        y += 8
        if (y > 280) { doc.addPage(); y = 20 }
        doc.text(`${a.nome} - ${a.turma}`, 20, y)
    })

    doc.save("alunos.pdf")
}

// ================= UTILS =================
const _el = id => document.getElementById(id)

function _updateText(id, v) {
    const el = _el(id)
    if (el) el.textContent = v
}

function _escHtml(str) {
    return String(str ?? "—")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

function _limparForm() {
    ;["nome", "idade", "turma", "turno"].forEach(id => {
        const el = _el(id)
        if (el) el.value = ""
    })
    _cadastroState.editandoId = null
    _updateText("tituloForm", "Novo aluno")
}

function _toggleBtn(loading) {
    const btn = _el("btnSalvar")
    if (!btn) return
    btn.disabled    = loading
    btn.textContent = loading ? "Salvando..." : "Salvar"
}

function _debounce(fn, delay) {
    let t
    return (...args) => {
        clearTimeout(t)
        t = setTimeout(() => fn(...args), delay)
    }
}