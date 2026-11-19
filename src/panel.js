/* Integração Chatwoot dentro do manager do Evolution Go.
 * Servido pela ponte (/admin/panel.js) e carregado por 1 linha no index.html do manager.
 * - Adiciona um ícone "Chatwoot" na barra de ações de cada cartão de instância (/manager/instances).
 * - Autentica com a chave global que o manager já guarda em localStorage["evolution-auth"].
 * - Não depende do código minificado do manager, só da estrutura do cartão (ver UPGRADE-EVOGO.md §6).
 * Plano B: no console do navegador, window.__evogoChatwoot.open("nome-da-instancia"). */
(function () {
  'use strict';
  if (window.__evogoChatwoot) return;
  var API = new URL(document.currentScript.src).origin + '/admin';

  function auth() {
    try { var a = JSON.parse(localStorage.getItem('evolution-auth') || 'null'); a = a && (a.state || a); return a && a.apiKey ? a.apiKey : null; }
    catch (e) { return null; }
  }
  function call(method, path, body) {
    return fetch(API + path, { method: method, headers: { apikey: auth() || '', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Erro ' + r.status); return j; }); });
  }
  // cria elementos; aceita strings, nós e listas (achatadas) como filhos
  function h(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') e.className = attrs[k]; else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (function add(list) {
      list.forEach(function (c) {
        if (c == null || c === false) return;
        if (Array.isArray(c)) return add(c);
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    })(Array.prototype.slice.call(arguments, 2));
    return e;
  }

  var css = '.ecw-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.ecw-box{background:#fff;color:#1b1f23;width:min(560px,100%);max-height:90vh;overflow:auto;border-radius:12px;padding:20px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.4)}' +
    '.ecw-box h2{margin:0 0 4px;font-size:18px}.ecw-sub{color:#667;margin:0 0 6px;font-size:13px}' +
    '.ecw-box label{display:block;font-weight:600;margin:12px 0 4px}.ecw-box input[type=text],.ecw-box input[type=password],.ecw-box input[type=number]{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #bbc;border-radius:6px;font:inherit;background:#fff;color:#111}' +
    '.ecw-chk{display:flex;gap:8px;align-items:center;margin:6px 0;font-weight:400!important}.ecw-chk input{margin:0}' +
    '.ecw-act{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}.ecw-b{border:1px solid #bbc;background:#f4f5f8;color:#111;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}.ecw-b.p{background:#1f93ff;border-color:#1f93ff;color:#fff}.ecw-b:disabled{opacity:.6;cursor:wait}' +
    '.ecw-msg{margin-top:12px;padding:8px 10px;border-radius:6px;font-size:13px;background:#eef;color:#336}.ecw-msg.err{background:#fde8e8;color:#8a1c1c}.ecw-msg.ok{background:#e0f7e6;color:#116b2c}.ecw-hint{color:#667;font-size:12px;margin-top:3px}' +
    '.ecw-hist{margin-left:4px}.ecw-sec{border:1px solid #dde;border-radius:8px;padding:10px 12px;margin-top:12px}.ecw-sech{font-weight:700;font-size:15px;margin:0 0 4px}.ecw-sec label.ecw-sech{margin-top:0}.ecw-tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#e0f7e6;color:#116b2c;margin-top:6px}' +
    '.ecw-ibtn{color:#0ea5e9}.ecw-ibtn:hover{color:#38bdf8;background:rgba(14,165,233,.1)}.ecw-ibtn.on{color:#22c55e}.ecw-ibtn.on:hover{color:#4ade80;background:rgba(34,197,94,.1)}';
  document.head.appendChild(h('style', {}, css));

  /* ---------- estado (cache curto) ---------- */
  var cache = { at: 0, data: null, pending: null };
  function loadState(force) {
    if (!force && cache.data && Date.now() - cache.at < 15000) return Promise.resolve(cache.data);
    if (cache.pending) return cache.pending;
    cache.pending = call('GET', '/state').then(function (s) { cache.data = s; cache.at = Date.now(); return s; })
      .finally(function () { cache.pending = null; });
    return cache.pending;
  }

  /* ---------- modal ---------- */
  var overlay = null;
  function close() { if (overlay) { overlay.remove(); overlay = null; } }
  function openFor(name) {
    close();
    var box = h('div', { class: 'ecw-box' }, h('h2', {}, 'Integrações · ' + name), h('p', { class: 'ecw-sub' }, 'Carregando…'));
    overlay = h('div', { class: 'ecw-ov', onclick: function (e) { if (e.target === overlay) close(); } }, box);
    document.body.appendChild(overlay);
    loadState(true).then(function (s) {
      var inst = s.instances.filter(function (i) { return i.name === name; })[0];
      if (!inst) throw new Error('Instância "' + name + '" não encontrada no Evolution Go.');
      form(box, s, inst);
    }).catch(function (e) {
      box.replaceChildren(h('h2', {}, 'Integrações · ' + name), h('div', { class: 'ecw-msg err' }, e.message), h('div', { class: 'ecw-act' }, h('button', { class: 'ecw-b', onclick: close }, 'Fechar')));
    });
  }

  function importInfo(r) {
    if (!r) return null;
    var st = { running: 'em andamento', concluida: 'concluída', concluida_com_falhas: 'concluída com falhas', erro: 'com erro' }[r.status] || r.status;
    var t = 'Última importação: ' + st + ' — ' + r.chatsDone + '/' + r.chats + ' conversas, ' + r.msgsDone + '/' + r.msgs + ' mensagens' + (r.failed ? ', ' + r.failed + ' falhas' : '') + (r.error ? ' (' + r.error + ')' : '') + '.';
    return h('div', { class: 'ecw-msg' + (r.status === 'erro' || r.failed ? ' err' : r.status === 'concluida' ? ' ok' : '') }, t);
  }

  function form(box, s, inst) {
    var b = inst.bridge && inst.bridge.enabled ? inst.bridge : null;
    var o = (b && b.options) || { sign: false, reopen: false, pending: false, ignoreGroups: true, importHistory: false };
    var f = {
      cwOn: h('input', { type: 'checkbox' }),
      account: h('input', { type: 'number', min: '1', value: b && b.accountId ? String(b.accountId) : '' }),
      token: h('input', { type: 'password', autocomplete: 'off', placeholder: 'Deixe vazio se a conta já foi cadastrada' }),
      inbox: h('input', { type: 'text', value: b && b.inboxName ? b.inboxName : inst.name + '-evogo' }),
      fwUrl: h('input', { type: 'text', placeholder: 'https://seu-n8n/webhook/entrada', value: b ? b.forwardUrl : '' }),
      fwV2: h('input', { type: 'checkbox' }),
      bot: h('input', { type: 'text', placeholder: 'Ex.: Lis', value: b ? b.botName || '' : '' }),
      histDays: h('input', { type: 'number', min: '0', value: String(((b && b.options) || {}).historyDays != null ? b.options.historyDays : 90) }),
    };
    f.cwOn.checked = b ? !!b.chatwootEnabled : true;
    f.fwV2.checked = b ? b.forwardFormat !== 'raw' : true;
    function chk(key, label, on, disabled) {
      var i = h('input', { type: 'checkbox', disabled: disabled ? 'disabled' : false }); i.checked = !!on; f[key] = i;
      return h('label', { class: 'ecw-chk' }, i, label);
    }
    var cwFields = h('div', {},
      h('label', {}, 'ID da conta no Chatwoot'), f.account,
      h('div', { class: 'ecw-hint' }, s.accounts.length ? 'Contas já cadastradas: ' + s.accounts.join(', ') + '.' : 'Nenhuma conta cadastrada ainda.'),
      h('label', {}, 'Token de acesso do Chatwoot'), f.token,
      h('div', { class: 'ecw-hint' }, 'Perfil → Token de acesso (usuário administrador da conta). Só na primeira vez de cada conta.'),
      h('label', {}, 'Nome da inbox'), f.inbox,
      h('label', {}, 'Opções'),
      chk('sign', 'Assinar mensagens com o nome do atendente (e da automação, se o nome estiver definido)', o.sign), chk('reopen', 'Reabrir conversa resolvida', o.reopen),
      chk('pending', 'Criar conversas como pendentes', o.pending), chk('ignoreGroups', 'Ignorar grupos', o.ignoreGroups),
      chk('importHistory', 'Importar o histórico do WhatsApp quando o número for pareado (QR)', o.importHistory),
      h('div', { class: 'ecw-hist' }, h('label', {}, 'Dias de histórico a importar (0 = todo o histórico)'), f.histDays,
        h('div', { class: 'ecw-hint' }, 'O WhatsApp só envia o histórico no pareamento do número. Mídias viram um aviso (ex.: 📷 Imagem); as conversas importadas ficam resolvidas e mantêm a data original.'),
        importInfo(inst.lastImport)));
    function syncCw() { cwFields.style.display = f.cwOn.checked ? '' : 'none'; }
    f.cwOn.addEventListener('change', syncCw); syncCw();

    var msg = h('div'), testMsg = h('div');
    var save = h('button', { class: 'ecw-b p' }, b && b.enabled ? 'Salvar' : 'Conectar');
    var test = h('button', { class: 'ecw-b', type: 'button' }, 'Testar');
    test.addEventListener('click', function () {
      var url = f.fwUrl.value.trim();
      if (!url) { testMsg.replaceChildren(h('div', { class: 'ecw-msg err' }, 'Informe a URL do webhook.')); return; }
      test.disabled = true; testMsg.replaceChildren(h('div', { class: 'ecw-msg' }, 'Testando…'));
      call('POST', '/test-forward', { url: url, instance: inst.name }).then(function (r) {
        test.disabled = false;
        testMsg.replaceChildren(h('div', { class: 'ecw-msg ' + (r.ok ? 'ok' : 'err') },
          r.ok ? 'Webhook respondeu HTTP ' + r.status + ' em ' + r.ms + ' ms.' : (r.error ? 'Falhou: ' + r.error : 'Webhook respondeu HTTP ' + r.status + '. No n8n, o fluxo está ativo e é a URL de produção (/webhook/…, não /webhook-test/…)?')));
      }).catch(function (e) { test.disabled = false; testMsg.replaceChildren(h('div', { class: 'ecw-msg err' }, e.message)); });
    });
    save.addEventListener('click', function () {
      save.disabled = true; msg.replaceChildren(h('div', { class: 'ecw-msg' }, 'Salvando…'));
      call('POST', '/connect', {
        instance: inst.name, chatwootEnabled: f.cwOn.checked, accountId: f.account.value, chatwootToken: f.token.value, inboxName: f.inbox.value,
        options: { sign: f.sign.checked, reopen: f.reopen.checked, pending: f.pending.checked, ignoreGroups: f.ignoreGroups.checked, importHistory: f.importHistory.checked, historyDays: Number(f.histDays.value) },
        forwardUrl: f.fwUrl.value, forwardFormat: f.fwV2.checked ? 'evolution-v2' : 'raw', botName: f.bot.value,
      }).then(function () {
        msg.replaceChildren(h('div', { class: 'ecw-msg ok' }, 'Pronto! Configuração salva e webhook do evogo ajustado.'));
        loadState(true).then(mark); setTimeout(close, 1400);
      }).catch(function (e) { save.disabled = false; msg.replaceChildren(h('div', { class: 'ecw-msg err' }, e.message)); });
    });
    var actions = [h('button', { class: 'ecw-b', onclick: close }, 'Fechar')];
    if (b && b.enabled) {
      actions.push(h('button', { class: 'ecw-b', onclick: function () {
        if (!confirm('Desligar TODAS as integrações de "' + inst.name + '" (Chatwoot e webhook)? As conversas existentes são mantidas.')) return;
        call('POST', '/disconnect', { instance: inst.name }).then(function () { return loadState(true); }).then(function () { mark(); close(); })
          .catch(function (e) { msg.replaceChildren(h('div', { class: 'ecw-msg err' }, e.message)); });
      } }, 'Desconectar tudo'));
    }
    actions.push(save);
    var tags = [];
    if (b && b.chatwootEnabled) tags.push('Chatwoot · conta ' + b.accountId);
    if (b && b.forwardUrl) tags.push('Webhook ativo');
    box.replaceChildren(
      h('h2', {}, 'Integrações · ' + inst.name),
      h('p', { class: 'ecw-sub' }, (inst.number ? '+' + inst.number + ' · ' : '') + 'Escolha o que esta instância deve alimentar.'),
      tags.length ? h('span', { class: 'ecw-tag' }, tags.join(' · ')) : null,
      h('div', { class: 'ecw-sec' }, h('label', { class: 'ecw-chk ecw-sech' }, f.cwOn, 'Chatwoot'), cwFields),
      h('div', { class: 'ecw-sec' }, h('div', { class: 'ecw-sech' }, 'Automação (n8n ou outro webhook)'),
        h('label', {}, 'URL do webhook'), f.fwUrl,
        h('div', { class: 'ecw-hint' }, 'Cada mensagem recebida é copiada para esta URL, sem atrasar o Chatwoot. Deixe vazio para não encaminhar. No n8n use a URL de produção, com o fluxo ativo.'),
        h('label', { class: 'ecw-chk' }, f.fwV2, 'Converter para o formato da Evolution API v2 (recomendado para fluxos que já usavam a v2)'),
        h('label', {}, 'Nome que aparece no Chatwoot nas respostas da automação'), f.bot,
        h('div', { class: 'ecw-hint' }, 'As respostas enviadas pelo n8n aparecem no Chatwoot com este nome (um Agente Bot é criado na conta). Com "Assinar mensagens" ligado (seção Chatwoot), o WhatsApp também recebe *Nome:* antes do texto, como os agentes. Vale para o envio pelo endereço da ponte (/message/sendText).'),
        h('div', { class: 'ecw-act', style: 'margin-top:8px' }, test), testMsg),
      msg, h('div', { class: 'ecw-act' }, actions));
  }

  /* ---------- ícone na barra de cada cartão de instância ---------- */
  var ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20l1.2-4.6A8.4 8.4 0 1 1 21 11.5z"/></svg>';

  function cards() {
    // barra de ações do cartão: flex border-t com botões; o cartão é o ancestral .group
    return Array.prototype.slice.call(document.querySelectorAll('div.border-t.opacity-0')).filter(function (f) { return f.closest('.group') && f.querySelector('button'); });
  }
  function nameOf(footer) {
    var p = footer.closest('.group').querySelector('.flex-1.min-w-0 > p');
    return p ? p.textContent.trim() : '';
  }
  function mark() {
    var byName = {};
    ((cache.data && cache.data.instances) || []).forEach(function (i) { byName[i.name] = i; });
    document.querySelectorAll('[data-ecw]').forEach(function (b) {
      var i = byName[b.getAttribute('data-ecw')], on = !!(i && i.bridge && i.bridge.enabled && (i.bridge.chatwootEnabled || i.bridge.forwardUrl));
      b.classList.toggle('on', on);
      b.title = on ? 'Integrações ativas:' + (i.bridge.chatwootEnabled ? ' Chatwoot (conta ' + i.bridge.accountId + ')' : '') + (i.bridge.forwardUrl ? ' · Webhook n8n' : '') + ' — clique para editar' : 'Integrações: Chatwoot e webhook (n8n)';
    });
  }
  function enhance() {
    if (location.pathname.indexOf('/manager') !== 0 || !auth()) return;
    var added = false;
    cards().forEach(function (footer) {
      if (footer.querySelector('[data-ecw]')) return;
      var name = nameOf(footer); if (!name) return;
      var btns = Array.prototype.slice.call(footer.children).filter(function (c) { return c.tagName === 'BUTTON'; });
      var gear = btns.filter(function (x) { return /text-gray-500/.test(x.className); })[0] || btns[btns.length - 2] || btns[btns.length - 1];
      if (!gear) return;
      var b = gear.cloneNode(false);
      b.className = gear.className.replace(/\btext-gray-\d+\b|\bhover:text-gray-\d+\b|\bhover:bg-gray-\d+\/\d+\b/g, '') + ' ecw-ibtn';
      b.removeAttribute('disabled'); b.setAttribute('type', 'button'); b.setAttribute('data-ecw', name); b.title = 'Integrações: Chatwoot e webhook (n8n)';
      b.innerHTML = ICON;
      b.addEventListener('click', function (ev) { ev.stopPropagation(); openFor(name); });
      var sep = h('div', { class: 'w-px bg-sidebar-border' });
      footer.insertBefore(b, gear); footer.insertBefore(sep, gear);
      added = true;
    });
    if (added) loadState(false).then(mark).catch(function () {});
  }

  // atalho para a visão geral da ponte (abre em outra aba; a chave vai no fragmento da URL, que não é enviado ao servidor)
  function overviewLink() {
    var on = location.pathname.indexOf('/manager') === 0 && !!auth(), cur = document.getElementById('ecw-ponte');
    if (!on) { if (cur) cur.remove(); return; }
    if (cur) return;
    var a = h('a', { id: 'ecw-ponte', href: '#', title: 'Visão geral da ponte Evolution Go ⇄ Chatwoot', style: 'position:fixed;right:14px;bottom:14px;z-index:9999;background:#25d366;color:#fff;font:600 13px system-ui,sans-serif;padding:8px 14px;border-radius:99px;box-shadow:0 2px 10px rgba(0,0,0,.3);text-decoration:none' }, 'Ponte');
    a.addEventListener('click', function (ev) { ev.preventDefault(); window.open(API + '/overview#k=' + encodeURIComponent(auth() || ''), '_blank', 'noopener'); });
    document.body.appendChild(a);
  }
  var raf = 0;
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; enhance(); }); }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(function () { enhance(); overviewLink(); if (cache.data) mark(); }, 2000);
  enhance();

  window.__evogoChatwoot = { open: openFor };
})();
