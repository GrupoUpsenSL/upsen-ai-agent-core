/**
 * Widget de chat embebible — Kit 02 (canal web).
 *
 * Uso en cualquier página HTML (una sola línea):
 *
 *   <script src="https://TU-DOMINIO/widget.js"
 *           data-agent-name="ClinicBot"
 *           data-color="#0ea5e9"
 *           data-welcome="¡Hola! ¿En qué puedo ayudarte?"
 *           data-api-url="https://TU-DOMINIO"></script>
 *
 * Todo es configurable por atributos data-*; si se omiten, se usan valores
 * por defecto razonables. `data-api-url` es opcional: si no se indica, se
 * calcula automáticamente a partir de la URL de este mismo script (así
 * funciona sin tocar nada al moverlo de dominio).
 *
 * Vanilla JS puro — sin React, sin Vue, sin dependencias externas. Los
 * estilos van con prefijo "uw-" e inyectados en su propio <style>, para
 * minimizar choques con el CSS de la página anfitriona.
 */
(function () {
  "use strict";

  // Evita cargar el widget dos veces si el script se incluye por error más de una vez.
  if (window.__upsenWidgetLoaded) return;
  window.__upsenWidgetLoaded = true;

  // --- Config: atributos data-* del propio <script>, con override opcional
  //     vía window.ChatWidgetConfig para uso programático. ---
  var scriptEl = document.currentScript || (function () {
    var scripts = document.getElementsByTagName("script");
    return scripts[scripts.length - 1];
  })();

  function scriptOrigin() {
    try {
      var src = scriptEl.src;
      if (!src) return "";
      var a = document.createElement("a");
      a.href = src;
      return a.protocol + "//" + a.host;
    } catch (e) {
      return "";
    }
  }

  var data = (scriptEl && scriptEl.dataset) || {};
  var override = window.ChatWidgetConfig || {};

  var cfg = {
    agentName: override.agentName || data.agentName || "Asistente",
    color: override.primaryColor || data.color || "#0ea5e9",
    welcome:
      override.welcomeText ||
      data.welcome ||
      "¡Hola! ¿En qué puedo ayudarte hoy?",
    apiUrl: (override.apiUrl || data.apiUrl || scriptOrigin() || "").replace(/\/$/, ""),
  };

  if (!cfg.apiUrl) {
    console.error(
      "[widget] No se pudo determinar la URL de la API. Añade data-api-url=\"https://tu-dominio\" al <script>."
    );
    return;
  }

  // --- Sesión: un id estable por visitante, para que el agente lo recuerde entre visitas. ---
  var SESSION_KEY = "upsen_widget_session";
  function getSessionId() {
    try {
      var id = localStorage.getItem(SESSION_KEY);
      if (!id) {
        id =
          "w_" +
          Date.now().toString(36) +
          "_" +
          Math.random().toString(36).slice(2, 10);
        localStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (e) {
      // localStorage puede fallar (modo privado, cookies bloqueadas...): id de solo esta carga.
      return "w_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
    }
  }
  var sessionId = getSessionId();

  // --- Estilos ---
  var style = document.createElement("style");
  style.textContent =
    ".uw-btn{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;" +
    "background:" + cfg.color + ";box-shadow:0 4px 14px rgba(0,0,0,.25);border:none;cursor:pointer;" +
    "z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .15s ease;}" +
    ".uw-btn:hover{transform:scale(1.06);}" +
    ".uw-btn svg{width:28px;height:28px;fill:#fff;}" +
    ".uw-panel{position:fixed;bottom:92px;right:20px;width:360px;max-width:calc(100vw - 24px);" +
    "height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;" +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    "z-index:2147483000;opacity:0;pointer-events:none;transform:translateY(12px);" +
    "transition:opacity .18s ease,transform .18s ease;}" +
    ".uw-panel.uw-open{opacity:1;pointer-events:auto;transform:translateY(0);}" +
    ".uw-header{background:" + cfg.color + ";color:#fff;padding:16px;display:flex;" +
    "align-items:center;justify-content:space-between;flex-shrink:0;}" +
    ".uw-header-title{font-weight:600;font-size:15px;}" +
    ".uw-header-sub{font-size:12px;opacity:.85;margin-top:2px;}" +
    ".uw-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;" +
    "line-height:1;padding:4px;opacity:.9;}" +
    ".uw-close:hover{opacity:1;}" +
    ".uw-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;" +
    "background:#f7f8fa;}" +
    ".uw-msg{max-width:80%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.4;" +
    "white-space:pre-wrap;word-wrap:break-word;}" +
    ".uw-msg-bot{align-self:flex-start;background:#fff;color:#1a1a1a;border:1px solid #e6e8eb;" +
    "border-bottom-left-radius:4px;}" +
    ".uw-msg-user{align-self:flex-end;background:" + cfg.color + ";color:#fff;" +
    "border-bottom-right-radius:4px;}" +
    ".uw-typing{align-self:flex-start;background:#fff;border:1px solid #e6e8eb;border-radius:14px;" +
    "border-bottom-left-radius:4px;padding:10px 14px;display:flex;gap:4px;}" +
    ".uw-dot{width:6px;height:6px;border-radius:50%;background:#9aa0a6;animation:uw-bounce 1.2s infinite;}" +
    ".uw-dot:nth-child(2){animation-delay:.15s;}.uw-dot:nth-child(3){animation-delay:.3s;}" +
    "@keyframes uw-bounce{0%,60%,100%{transform:translateY(0);opacity:.5;}30%{transform:translateY(-4px);opacity:1;}}" +
    ".uw-inputbar{display:flex;gap:8px;padding:12px;border-top:1px solid #eceef0;flex-shrink:0;background:#fff;}" +
    ".uw-input{flex:1;border:1px solid #dde1e5;border-radius:20px;padding:10px 14px;font-size:14px;" +
    "outline:none;font-family:inherit;}" +
    ".uw-input:focus{border-color:" + cfg.color + ";}" +
    ".uw-send{background:" + cfg.color + ";border:none;border-radius:50%;width:38px;height:38px;" +
    "flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;}" +
    ".uw-send svg{width:17px;height:17px;fill:#fff;}" +
    ".uw-send:disabled{opacity:.5;cursor:default;}" +
    "@media (max-width: 480px){" +
    ".uw-panel{right:8px;left:8px;width:auto;bottom:84px;height:calc(100vh - 104px);" +
    "max-height:none;border-radius:14px;}" +
    ".uw-btn{right:16px;bottom:16px;}" +
    "}";
  document.head.appendChild(style);

  // --- Markup ---
  var btn = document.createElement("button");
  btn.className = "uw-btn";
  btn.setAttribute("aria-label", "Abrir chat");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';

  var panel = document.createElement("div");
  panel.className = "uw-panel";
  panel.innerHTML =
    '<div class="uw-header">' +
    '<div><div class="uw-header-title">' + escapeHtml(cfg.agentName) + "</div>" +
    '<div class="uw-header-sub">Normalmente responde al momento</div></div>' +
    '<button class="uw-close" aria-label="Cerrar chat">&times;</button>' +
    "</div>" +
    '<div class="uw-messages"></div>' +
    '<div class="uw-inputbar">' +
    '<input class="uw-input" type="text" placeholder="Escribe un mensaje..." maxlength="1000" />' +
    '<button class="uw-send" aria-label="Enviar">' +
    '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
    "</button>" +
    "</div>";

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var messagesEl = panel.querySelector(".uw-messages");
  var inputEl = panel.querySelector(".uw-input");
  var sendEl = panel.querySelector(".uw-send");
  var closeEl = panel.querySelector(".uw-close");

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function addMessage(text, who) {
    var el = document.createElement("div");
    el.className = "uw-msg " + (who === "user" ? "uw-msg-user" : "uw-msg-bot");
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    var el = document.createElement("div");
    el.className = "uw-typing";
    el.id = "uw-typing-indicator";
    el.innerHTML = '<span class="uw-dot"></span><span class="uw-dot"></span><span class="uw-dot"></span>';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    var el = document.getElementById("uw-typing-indicator");
    if (el) el.remove();
  }

  var opened = false;
  function togglePanel() {
    opened = !opened;
    panel.classList.toggle("uw-open", opened);
    if (opened) {
      if (!messagesEl.childElementCount) addMessage(cfg.welcome, "bot");
      inputEl.focus();
    }
  }

  btn.addEventListener("click", togglePanel);
  closeEl.addEventListener("click", togglePanel);

  var sending = false;
  function send() {
    var text = inputEl.value.trim();
    if (!text || sending) return;

    addMessage(text, "user");
    inputEl.value = "";
    sending = true;
    sendEl.disabled = true;
    showTyping();

    fetch(cfg.apiUrl + "/api/widget/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId, message: text }),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        hideTyping();
        var replies = (data && data.replies) || [];
        if (!replies.length) {
          addMessage("Perdona, no he podido responder ahora mismo. ¿Lo intentas de nuevo?", "bot");
          return;
        }
        replies.forEach(function (r) {
          addMessage(r, "bot");
        });
      })
      .catch(function () {
        hideTyping();
        addMessage("No he podido conectar. Revisa tu conexión e inténtalo de nuevo.", "bot");
      })
      .finally(function () {
        sending = false;
        sendEl.disabled = false;
        inputEl.focus();
      });
  }

  sendEl.addEventListener("click", send);
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") send();
  });
})();