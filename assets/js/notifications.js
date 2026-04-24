(function () {

    const CONFIG = {
        duracao: { sucesso: 3500, erro: 5000, aviso: 4000, info: 3500 },
        icones: { sucesso: "✓", erro: "✕", aviso: "!", info: "ℹ" }
    };

    let container;

    function createEl(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text) el.textContent = text;
        return el;
    }

    function injectStyles() {
        if (document.getElementById("notif-style")) return;

        const style = document.createElement("style");
        style.id = "notif-style";
        style.textContent = `
            :root {
                --notif-bg: #ffffff;
                --notif-border: #e0ddd8;
                --notif-text: #1c1a17;
                --notif-sub: #6b6560;

                --notif-success: #1a6641;
                --notif-error: #b83232;
                --notif-warning: #c8a84b;
                --notif-info: #185fa5;
            }

            #toast-container {
                position: fixed;
                top: 76px;
                right: 20px;
                z-index: 99999;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            .toast {
                display: flex;
                gap: 12px;
                background: var(--notif-bg);
                border: 1px solid var(--notif-border);
                border-radius: 12px;
                padding: 14px 16px;
                min-width: 280px;
                max-width: 360px;
                box-shadow: 0 6px 24px rgba(0,0,0,0.12);
                animation: toastIn .25s ease forwards;
                position: relative;
                overflow: hidden;
            }

            .toast.saindo {
                animation: toastOut .2s ease forwards;
            }

            .toast-icone {
                font-weight: bold;
            }

            .toast-corpo {
                flex: 1;
            }

            .toast-titulo {
                font-size: 0.9rem;
                font-weight: 600;
                color: var(--notif-text);
            }

            .toast-msg {
                font-size: 0.82rem;
                color: var(--notif-sub);
            }

            .toast-fechar {
                background: none;
                border: none;
                cursor: pointer;
                color: #999;
            }

            .toast-fechar:hover {
                color: #333;
            }

            .toast-barra {
                position: absolute;
                bottom: 0;
                left: 0;
                height: 3px;
                animation: barra linear forwards;
            }

            .toast.sucesso .toast-barra { background: var(--notif-success); }
            .toast.erro .toast-barra { background: var(--notif-error); }
            .toast.aviso .toast-barra { background: var(--notif-warning); }
            .toast.info .toast-barra { background: var(--notif-info); }

            @keyframes toastIn {
                from { opacity: 0; transform: translateX(40px); }
                to { opacity: 1; transform: translateX(0); }
            }

            @keyframes toastOut {
                to { opacity: 0; transform: translateX(40px); }
            }

            @keyframes barra {
                from { width: 100%; }
                to { width: 0%; }
            }

            #dialog-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 99998;
            }

            .dialog-card {
                background: white;
                padding: 2rem;
                border-radius: 16px;
                width: 100%;
                max-width: 360px;
                text-align: center;
                animation: pop .2s ease;
            }

            .dialog-btns {
                display: flex;
                gap: 10px;
                justify-content: center;
                margin-top: 1rem;
            }

            .dialog-btn {
                padding: 8px 20px;
                border-radius: 8px;
                cursor: pointer;
                border: none;
                font-weight: 600;
            }

            .confirmar { background: var(--notif-error); color: white; }
            .cancelar { background: transparent; border: 1px solid #ccc; }

            @keyframes pop {
                from { transform: scale(.9); opacity: 0; }
                to { transform: scale(1); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }

    function createContainer() {
        container = document.createElement("div");
        container.id = "toast-container";
        container.setAttribute("aria-live", "polite");
        document.body.appendChild(container);
    }

    function showToast(tipo, titulo, msg) {
        const duracao = CONFIG.duracao[tipo] || 3000;

        const toast = createEl("div", `toast ${tipo}`);
        toast.setAttribute("role", "status");

        const icon = createEl("span", "toast-icone", CONFIG.icones[tipo]);
        const body = createEl("div", "toast-corpo");
        const titleEl = createEl("div", "toast-titulo", titulo);
        const msgEl = msg ? createEl("div", "toast-msg", msg) : null;

        const close = createEl("button", "toast-fechar", "✕");
        close.addEventListener("click", () => removeToast(toast));

        const bar = createEl("div", "toast-barra");
        bar.style.animationDuration = duracao + "ms";

        body.appendChild(titleEl);
        if (msgEl) body.appendChild(msgEl);

        toast.append(icon, body, close, bar);
        container.appendChild(toast);

        setTimeout(() => removeToast(toast), duracao);
    }

    function removeToast(toast) {
        if (!toast) return;
        toast.classList.add("saindo");
        setTimeout(() => toast.remove(), 200);
    }

    function confirmDialog(titulo, msg, icone) {
        return new Promise(resolve => {
            const overlay = createEl("div");
            overlay.id = "dialog-overlay";

            const card = createEl("div", "dialog-card");

            const icon = createEl("div", null, icone || "⚠️");
            const title = createEl("div", null, titulo);
            const text = createEl("div", null, msg);

            const btns = createEl("div", "dialog-btns");

            const yes = createEl("button", "dialog-btn confirmar", "Confirmar");
            const no = createEl("button", "dialog-btn cancelar", "Cancelar");

            yes.onclick = () => { overlay.remove(); resolve(true); };
            no.onclick = () => { overlay.remove(); resolve(false); };

            btns.append(yes, no);
            card.append(icon, title, text, btns);
            overlay.appendChild(card);

            document.body.appendChild(overlay);
        });
    }

    function init() {
        injectStyles();
        createContainer();

        window.Notif = {
            sucesso: (t, m) => showToast("sucesso", t, m),
            erro: (t, m) => showToast("erro", t, m),
            aviso: (t, m) => showToast("aviso", t, m),
            info: (t, m) => showToast("info", t, m),
            confirmar: confirmDialog
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();