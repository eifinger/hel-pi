import { $, el, api, post, commandId } from './ui.js';
import { openTools } from './tools.js';
import { openConnections } from './connections.js';
import { memoryView, wikiFile } from './wiki.js';
import { openTasks } from './tasks.js';
import { openPosts } from './posts.js';
import { openModels } from './models.js';
import { openFiles } from './files.js';
import { openSideChats, chatActions } from './side-chats.js';

function note(id, text = "") {
  $(id).textContent = text;
  $(id).hidden = !text;
}

let ingress = false, authenticated = false, model = { connected: false };
let stream, reconnectTimer, generation = 0, observing = false;
let sideChat = null;
const chatPath = () => sideChat ? `side-chats/${encodeURIComponent(sideChat.id)}/chat` : 'chat';
const drafts = new Map();
let followOnReturn = true;
const narrow = matchMedia('(max-width: 700px)');
const nav = [...document.querySelectorAll('[data-view]')];
let collapsed = false;
try { collapsed = localStorage.getItem('hel-pi:sidebar') === 'collapsed'; } catch { /* optional preference */ }
function sidebar(drawer = false) {
  drawer = drawer && narrow.matches;
  const compact = collapsed && !narrow.matches;
  document.body.classList.toggle('collapsed', compact);
  document.body.classList.toggle('drawer', drawer);
  $('sidebar').inert = narrow.matches && !drawer;
  $('scrim').hidden = !drawer; $('main').inert = drawer;
  $('menu').inert = drawer;
  $('menu').setAttribute('aria-expanded', String(drawer));
  const label = narrow.matches ? 'Close navigation' : compact ? 'Expand sidebar' : 'Collapse sidebar';
  $('collapse').title = label; $('collapse').setAttribute('aria-label', label);
  $('collapse').setAttribute('aria-expanded', String(!compact));
  $('collapse').querySelector('span').textContent = label;
}
function closeDrawer() { sidebar(); $('menu').focus(); }
$('menu').onclick = () => { sidebar(true); nav.find(n => n.hasAttribute('aria-current'))?.focus(); };
$('scrim').onclick = closeDrawer;
$('collapse').onclick = () => {
  if (narrow.matches) return closeDrawer();
  collapsed = !collapsed; sidebar();
  try { localStorage.setItem('hel-pi:sidebar', collapsed ? 'collapsed' : 'expanded'); } catch { /* storage disabled */ }
};
narrow.addEventListener('change', () => sidebar());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('scrim').hidden) closeDrawer();
});
function stopObserving() {
  observing = false;
  generation++;
  clearTimeout(reconnectTimer);
  stream?.close(); stream = null;
}
function show(next) {
  const workspace = authenticated && next !== 'login' && next !== 'waiting';
  if (!workspace) stopObserving();
  const history = $('transcript');
  if (!$('chat').hidden) followOnReturn = history.scrollHeight - history.clientHeight - history.scrollTop < 70;
  for (const page of document.querySelectorAll('main > section')) page.hidden = next !== page.id;
  $('sidebar').hidden = $('menu').hidden = !workspace;
  document.body.classList.toggle('workspace', workspace);
  $('logout').hidden = ingress || !authenticated;
  for (const item of nav) {
    if (item.dataset.view === (next === 'account' ? 'connections' : next === 'chat' && sideChat ? 'side-chats' : next)) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  sidebar(); $('main').scrollTop = 0;
  if (next === 'chat' && followOnReturn) history.scrollTop = history.scrollHeight;
  document.title = `Hel-Pi · ${next === 'chat' && sideChat ? sideChat.title || 'Side chat' : nav.find(item => item.dataset.view === next)?.title || {account:'ChatGPT', login:'Sign in', waiting:'Opening'}[next]}`;
}
function navigate(view) {
  if (!authenticated) return;
  if (view === 'chat') model.connected ? openChat(null) : openAccount();
  if (view === 'side-chats') { show(view); openSideChats(chat => model.connected ? openChat(chat) : openAccount()); }
  if (view === 'memories') { show(view); memoryView(); }
  if (view === 'tasks') { show(view); openTasks(); }
  if (view === 'posts') { show(view); openPosts(); }
  if (view === 'artifacts' || view === 'skills') { show(view); openFiles(view); }
  if (view === 'models') { show(view); openModels(); }
  if (view === 'tools') { show(view); openTools(); }
  if (view === 'connections') {
    show(view);
    $('account-summary').textContent = model.connected ? `Connected${model.model ? ` · ${model.model}` : ''}` : 'Not connected';
    openConnections();
  }
  $('main').focus({ preventScroll: true });
}
for (const item of nav) item.onclick = () => navigate(item.dataset.view);
function unavailable(title, detail) {
  show("waiting");
  $("wait-title").textContent = title;
  $("wait-note").textContent = detail;
  $("retry").hidden = false;
}
async function boot() {
  show("waiting");
  $("retry").hidden = true;
  $("wait-title").textContent = "Opening Hel-Pi…";
  $("wait-note").textContent = "Checking your session.";
  try {
    const access = await api("access");
    ingress = access.ingress === true;
    $("route").textContent = ingress ? "Home Assistant" : "Direct access";
    authenticated = ingress ? access.authenticated : (await api("auth/session")).authenticated;
    if (!authenticated) {
      if (ingress) unavailable("Home Assistant session required", "Reopen Hel-Pi from Home Assistant after signing in.");
      else show("login");
      return;
    }
    model = await api("account");
    const wiki = new URL(location.href).searchParams.get('wiki');
    if (wikiFile(wiki)) { show('memories'); memoryView(true, wiki); return; }
    if (!model.connected) return openAccount();
    openChat();
  } catch (error) { unavailable("Could not open Hel-Pi", error.message); }
}
$("retry").onclick = boot;
$("login-form").onsubmit = async event => {
  event.preventDefault();
  if (ingress || $("sign-in").disabled) return;
  note("login-error"); $("sign-in").disabled = true;
  try {
    await post("auth/login", { key: $("key").value });
    $("key").value = "";
    await boot();
  } catch (error) { note("login-error", error.message); }
  finally { $("sign-in").disabled = false; }
};
$("logout").onclick = async () => {
  if (ingress || !authenticated) return;
  $("logout").disabled = true;
  try { await post("auth/logout", {}); location.reload(); }
  catch (error) { unavailable("Sign-out was not confirmed", error.message); }
  finally { $("logout").disabled = false; }
};

function clearSignIn() {
  $("sign-in-link").hidden = true; $("sign-in-link").removeAttribute("href");
  $("callback").value = ""; $("callback").disabled = true; $("finish").disabled = true;
}
function openAccount(reconnect = false) {
  if (!authenticated) return;
  show("account");
  $("account-title").textContent = reconnect || model.connected ? "Reconnect ChatGPT" : "Connect ChatGPT";
  $("account-note").textContent = reconnect ? "Sign in again to restore replies. Your conversation stays here."
    : model.connected ? `Connected${model.model ? ` · ${model.model}` : ""}. Sign in again to renew or change the connection.`
      : "Connect a ChatGPT account to start chatting with Hel-Pi.";
}
$("account-nav").onclick = () => openAccount();
$("back").onclick = () => navigate('connections');
$("start").onclick = async () => {
  if (!authenticated) return;
  // Reserve the tab during the user's gesture; keep a normal link if popups are blocked.
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  $("start").disabled = true; $("back").disabled = true; note("account-error"); clearSignIn();
  try {
    const { url } = await post("account", { action: "start" });
    const target = new URL(url);
    if (target.origin !== "https://auth.openai.com" || target.username || target.password) throw new Error("OpenAI sign-in could not be opened.");
    $("sign-in-link").href = target.href; $("sign-in-link").hidden = false;
    $("callback").disabled = false; $("finish").disabled = false;
    if (tab && !tab.closed) tab.location.replace(target.href);
    else note("account-error", "The new tab was blocked. Use the sign-in link above to continue.");
  } catch (error) { tab?.close(); note("account-error", error.message); }
  finally { $("start").disabled = false; $("back").disabled = false; }
};
$("callback-form").onsubmit = async event => {
  event.preventDefault();
  if (!authenticated || $("finish").disabled) return;
  note("account-error");
  const callback = $("callback").value.trim();
  let address;
  try { address = new URL(callback); } catch { /* Show the same guidance as for a partial URL. */ }
  if (!address || address.protocol !== "http:" || address.username || address.password || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) || !address.search) {
    return note("account-error", "Paste the full loopback redirect address, including everything after the question mark.");
  }
  $("start").disabled = true; $("finish").disabled = true; $("back").disabled = true;
  try {
    const result = await post("account", { action: "finish", callback });
    if (!result.connected) throw new Error("The connection was not confirmed. Start sign-in again.");
    model = result; freshConnection = true; clearSignIn(); chatNotice(""); stopObserving(); openChat();
  } catch (error) { note("account-error", error.message); $("finish").disabled = false; }
  finally { $("start").disabled = false; $("back").disabled = false; }
};

let messages = [], nextBefore, files = [], requestId, stopId, busy = false, live = false, sending = false, stopping = false;
let activity = "", retryDelay = 1000, shownFailedReceipt, freshConnection = false;
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const rows = new WeakMap();
function row(message) {
  if (rows.has(message)) return rows.get(message);
  const user = message.role === "user";
  const article = el("article", user ? "message user" : "message");
  const avatar = el("span", "avatar", user ? "Y" : "π"); avatar.ariaHidden = "true";
  const body = el("div"), byline = el("div", "byline");
  byline.append(el("strong", "", user ? "You" : "Hel-Pi"));
  if (Number.isFinite(message.createdAt)) byline.append(el("time", "", dateFormat.format(message.createdAt)));
  body.append(byline);
  if (message.content) {
    const paragraph = el("p", "body-text");
    let start = 0;
    if (!user) for (const match of message.content.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      let source = match[0].replace(/[.,;:!?\]]+$/, "");
      if (source.endsWith(")") && source.split(")").length > source.split("(").length) source = source.slice(0, -1);
      if (!URL.canParse(source)) continue;
      const url = new URL(source);
      if (url.username || url.password) continue;
      const link = el("a", "", source);
      link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
      paragraph.append(message.content.slice(start, match.index), link);
      start = match.index + source.length;
    }
    paragraph.append(message.content.slice(start)); body.append(paragraph);
  }
  if (message.attachments?.length) {
    const list = el("ul", "downloads");
    for (const file of message.attachments) {
      if (!file.id || file.id === "." || file.id === "..") continue;
      const name = file.name || file.id.split("/").pop() || "Attachment";
      const link = el("a", "", name); link.download = name;
      // Never follow a server-supplied absolute URL or trust a file name as a path.
      const sent = file.url?.startsWith('/api/sent-attachments/');
      const route = sent ? `sent-attachments/${encodeURIComponent(file.id)}?name=${encodeURIComponent(name)}` : `attachments/${encodeURIComponent(file.id)}?download=1`;
      link.href = `api/${route}`;
      link.title = `Download ${name}`;
      const item = el("li"); item.append(link); list.append(item);
      if (sent && file.mime?.startsWith('audio/')) {
        const audio = el('audio'); audio.controls = true; audio.preload = 'none'; audio.src = `api/${route}&play=1`; item.append(audio);
      }
    }
    body.append(list);
  }
  article.append(avatar, body); rows.set(message, article); return article;
}
function renderHistory(prepend = false) {
  const pane = $("transcript"), list = $("messages"), height = pane.scrollHeight, oldTop = pane.scrollTop;
  const pinned = height - pane.clientHeight - oldTop < 70;
  $("older-row").hidden = !nextBefore;
  $("empty").hidden = !!messages.length;
  // Keep unchanged rows mounted while streaming or prepending; never interpret widgets or markup.
  const wanted = new Set(messages.map(row));
  for (const child of Array.from(list.children)) if (!wanted.has(child)) child.remove();
  let at = list.firstElementChild;
  for (const node of wanted) {
    if (node === at) at = at.nextElementSibling;
    else list.insertBefore(node, at);
  }
  if (prepend) pane.scrollTop = oldTop + pane.scrollHeight - height;
  else if (pinned) pane.scrollTop = pane.scrollHeight;
}
function chatNotice(text, accountProblem = false) {
  $("error-detail").textContent = text;
  $("chat-error").hidden = !text;
  $("recover").hidden = !text || !accountProblem;
}
const credentialIssue = text => /expired|revoked|unauthori[sz]ed|invalid.grant|(?:refresh|access|invalid).token|oauth|authentication|credentials|sign.in again|connect.*ChatGPT|\b401\b/i.test(text);
function failure(error) {
  if (!ingress && error.status === 401) { location.reload(); return; }
  chatNotice(error.message, error.code === "model_unavailable" || credentialIssue(error.message));
}
$("recover").onclick = () => openAccount(true);
function controls() {
  $("send").hidden = busy; $("stop").hidden = !busy;
  $("send").disabled = !live || sending || stopping || (!$("draft").value.trim() && !files.length);
  $("stop").disabled = !live || stopping || sending;
  $("attach").disabled = sending || files.length >= 4; $("draft").readOnly = sending;
  $("logout").disabled = sending || stopping;
  $('chat-options').disabled = sending || stopping;
  for (const item of nav) if (['chat', 'side-chats'].includes(item.dataset.view)) item.disabled = sending || stopping;
  note("activity", stopping ? "Stopping reply…" : sending ? "Sending message…" : busy ? activity || "Thinking…" : "");
}
function connection(label) {
  live = label === "Live"; $("live").textContent = label; $("live").classList.toggle("online", live); controls();
}
function setActivity(value) {
  activity = value?.kind === "replying" ? "Writing a reply…" : value?.kind === "tool" ? `Using ${value.name}…` : "";
}
function receiptNotice(receipt) {
  // Snapshots replay the last receipt. Don't revive an old failure after reconnecting an account.
  if (receipt?.status !== "unanswered" || receipt.id === shownFailedReceipt) return;
  shownFailedReceipt = receipt.id;
  if (receipt.error === "aborted") { chatNotice("Reply stopped."); return; }
  const detail = receipt.error || "Hel-Pi could not finish this reply.";
  chatNotice(detail, credentialIssue(detail));
}
function snapshot(data) {
  const skipped = data.oversizedMemoryFiles || [];
  note('memory-warning', skipped.length ? `Ignored in this chat: ${skipped.join(' and ')}. Each file must be 64 KiB or less. Shorten the workspace ${skipped.length === 1 ? 'file' : 'files'} to include ${skipped.length === 1 ? 'it' : 'them'} again.` : '');
  const ids = new Set(data.messages.map(m => m.id));
  const first = data.messages.find(m => /^[1-9]\d*$/.test(m.id));
  const overlaps = first && messages.some(m => /^[1-9]\d*$/.test(m.id) && ids.has(m.id));
  const older = data.history && overlaps ? messages.filter(m => /^[1-9]\d*$/.test(m.id) && Number(m.id) < Number(first.id)) : [];
  messages = [...older, ...data.messages];
  if (!older.length) nextBefore = data.history?.nextBefore;
  busy = data.busy; setActivity(data.activity);
  if (!busy) stopId = undefined;
  if (freshConnection) {
    if (data.latest?.status === "unanswered") shownFailedReceipt = data.latest.id;
    freshConnection = false;
  }
  if (data.interruption) chatNotice(data.interruption, credentialIssue(data.interruption));
  receiptNotice(data.latest); renderHistory(); controls();
}
function streamEvent(event) {
  switch (event.type) {
    case "snapshot": snapshot(event.conversation); break;
    case "message": {
      const m = event.message, match = item => item.id === m.id || item.id === event.previousId;
      const index = messages.findIndex(match);
      messages = messages.filter(item => !match(item));
      if (m.content.trim() || m.attachments?.length) messages.splice(index < 0 ? messages.length : index, 0, m);
      renderHistory(); break;
    }
    case "activity": setActivity(event.activity); if (event.activity.kind !== "idle") busy = true; controls(); break;
    case "run-end": {
      for (const receipt of event.submissions) receiptNotice(receipt);
      const ids = event.submissions.filter(r => r.status === 'done' && r.requestId).map(r => r.requestId).slice(-50);
      if (sideChat && !sideChat.title && ids.length) post(`side-chats/${encodeURIComponent(sideChat.id)}/title/generate`, {requestIds:ids, onlyIfEmpty:true}).then(updateTitle).catch(() => { /* Manual title generation remains available. */ });
      break;
    }
    case "error": chatNotice(event.message, credentialIssue(event.message)); break;
    case "deleted": if (sideChat) removedChat(sideChat.id); else unavailable("Conversation was removed", "Reload to open the current conversation."); break;
  }
}
function updateTitle(chat) {
  if (chat.id !== sideChat?.id) return;
  sideChat = chat; $('chat-title').textContent = chat.title || 'Untitled side chat';
  if (!$('chat').hidden) document.title = `Hel-Pi · ${$('chat-title').textContent}`;
}
function changeChat(chat, keepDraft = true) {
  if (keepDraft && ($('draft').value || files.length)) drafts.set(sideChat?.id, {text:$('draft').value, files, requestId});
  else drafts.delete(sideChat?.id);
  stopObserving(); sideChat = chat;
  const draft = drafts.get(chat?.id); $('draft').value = draft?.text || ''; files = draft?.files || []; requestId = draft?.requestId;
  messages = []; nextBefore = stopId = shownFailedReceipt = undefined; busy = live = sending = stopping = false; activity = '';
  chatNotice(''); selectedFiles(); renderHistory(); followOnReturn = true;
}
function removedChat(id) {
  if (sideChat?.id !== id) return;
  $('chat-actions-dialog')?.close(); const showing = !$('chat').hidden;
  changeChat(null, false); if (showing || !$('side-chats').hidden) navigate('side-chats');
}
$('chat-options').onclick = () => {
  const chat = sideChat; chatActions({chat, path:chatPath(), row, busy, onTitle:updateTitle, onDelete:() => removedChat(chat.id)});
};
function openChat(chat = sideChat) {
  if (chat?.id !== sideChat?.id) changeChat(chat);
  sideChat = chat;
  $('chat-title').textContent = chat ? chat.title || 'Untitled side chat' : 'Conversation';
  $('chat-context').textContent = chat ? 'Workspace / Side chats' : 'Workspace / Chat';
  show("chat");
  if (!observing) { observing = true; retryDelay = 1000; observe(generation); }
}
async function observe(version) {
  connection(retryDelay > 1000 ? "Reconnecting…" : "Connecting…");
  function retry() {
    if (version !== generation) return;
    stream?.close(); stream = null; connection("Reconnecting…");
    reconnectTimer = setTimeout(() => observe(version), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }
  try {
    const data = await api(chatPath());
    if (version !== generation) return;
    snapshot(data);
    const source = new EventSource(`api/${chatPath()}/events`); stream = source;
    source.onmessage = message => {
      if (stream !== source) return;
      try { streamEvent(JSON.parse(message.data)); }
      catch { retry(); return; }
      if (stream === source && !live) { retryDelay = 1000; connection("Live"); }
    };
    source.onerror = () => { if (stream === source) retry(); };
  } catch (error) {
    if (version !== generation) return;
    if (!ingress && error.status === 401) { location.reload(); return; }
    if (sideChat && error.status === 404) { removedChat(sideChat.id); return; }
    if (error.code === "model_unavailable" || credentialIssue(error.message)) {
      stopObserving(); chatNotice(error.message, true);
      if (!$("chat").hidden) openAccount(true);
      return;
    }
    retry();
  }
}
$("older").onclick = async () => {
  const before = nextBefore, version = generation;
  $("older").disabled = true;
  try {
    const page = await api(`${chatPath()}/history?before=${encodeURIComponent(before)}`);
    if (version !== generation || nextBefore !== before) return;
    const ids = new Set(messages.map(m => m.id));
    messages = [...page.messages.filter(m => !ids.has(m.id)), ...messages]; nextBefore = page.nextBefore;
    renderHistory(true);
  } catch (error) { if (version === generation) failure(error); }
  finally { $("older").disabled = false; }
};

const fileTypes = {
  txt: "text/plain", log: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  yaml: "application/yaml", yml: "application/yaml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp",
};
$("picker").accept = Object.keys(fileTypes).map(ext => `.${ext}`).join(",");
$("attach").onclick = () => $("picker").click();
function selectedFiles() {
  const list = $("files"); list.replaceChildren(); list.hidden = !files.length;
  for (const item of files) {
    const li = el("li"), remove = el("button", "", "×");
    remove.type = "button"; remove.setAttribute("aria-label", `Remove ${item.file.name}`);
    remove.onclick = () => { if (!sending) { files = files.filter(f => f !== item); requestId = undefined; selectedFiles(); } };
    li.append(el("span", "", item.file.name), remove); list.append(li);
  }
  controls();
}
$("picker").onchange = () => {
  const picked = [...$("picker").files]; $("picker").value = "";
  if (!picked.length) return;
  chatNotice("");
  if (files.length + picked.length > 4) return chatNotice("Choose no more than four files per message.");
  const additions = [];
  for (const file of picked) {
    const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (!Object.hasOwn(fileTypes, ext)) return chatNotice(`Unsupported file: ${file.name}. Choose ${Object.keys(fileTypes).join(", ")}.`);
    if (!file.size || file.size > 8 * 1024 * 1024) return chatNotice(`${file.name} must be nonempty and no larger than 8 MiB.`);
    additions.push({ file, mime: fileTypes[ext] });
  }
  files.push(...additions); requestId = undefined; selectedFiles();
};
$("draft").oninput = () => { requestId = undefined; controls(); };
$("draft").onkeydown = event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) {
    event.preventDefault(); if (!$("send").disabled && !busy) $("composer").requestSubmit();
  }
};
$("composer").onsubmit = async event => {
  event.preventDefault();
  if ($("send").disabled || busy) return;
  const version = generation, route = chatPath();
  sending = true; chatNotice(""); controls();
  try {
    // Keep successful uploads and the idempotency key on uncertain transport failures.
    requestId ??= commandId();
    for (const item of files) {
      if (!item.id) item.id = (await api(`attachments?name=${encodeURIComponent(item.file.name)}`, {
        method: "POST", body: item.file, headers: { "Content-Type": item.mime },
      })).id;
    }
    if (version !== generation) return;
    const result = await post(route, { requestId, message: $("draft").value.trim(), attachmentIds: files.map(f => f.id) });
    if (version !== generation) return;
    receiptNotice(result.submission);
    $("draft").value = ""; requestId = undefined; files = []; selectedFiles();
    $("transcript").scrollTop = $("transcript").scrollHeight;
  } catch (error) { if (version === generation) failure(error); }
  finally { if (version === generation) { sending = false; controls(); } }
};
$("stop").onclick = async () => {
  if (stopping || !busy) return;
  const version = generation;
  stopping = true; controls();
  try { stopId ??= commandId(); await post(`${chatPath()}/stop`, { requestId: stopId }); if (version === generation) stopId = undefined; }
  catch (error) { if (version === generation) failure(error); }
  finally { if (version === generation) { stopping = false; controls(); } }
};

boot();
