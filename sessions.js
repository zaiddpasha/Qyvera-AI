/* ================= SESSION STATE ================= */
var sessions = []; 
var activeSession = null;
var sessionMessages = {};
var sessionTitles = {};
var sessionLastActive = {}; // sessionId -> timestamp
function saveToStorage() {

    
        localStorage.setItem("sessionLastActive", JSON.stringify(sessionLastActive));
    

         localStorage.setItem("sessions", JSON.stringify(sessions));
         localStorage.setItem("activeSession", activeSession);
         localStorage.setItem("sessionMessages", JSON.stringify(sessionMessages));
         localStorage.setItem("sessionTitles", JSON.stringify(sessionTitles));
         localStorage.setItem("sessionLastActive", JSON.stringify(sessionLastActive));
}
/* ================= ENTER KEY ================= */
function createSessionListItem(id) {
    const li = document.createElement("li");
    li.dataset.id = id;

    // ✅ Click anywhere on row switches session
    li.onclick = () => switchSession(id);

    const titleSpan = document.createElement("span");
    titleSpan.className = "chat-title";
    titleSpan.innerText = sessionTitles[id] || "New Chat";

    const delBtn = document.createElement("button");
    delBtn.className = "chat-menu-btn";
    delBtn.innerHTML = "<span></span><span></span><span></span>";
    delBtn.onclick = (e) => {
        e.stopPropagation();
        toggleChatMenu(li, id);
    };

    li.appendChild(titleSpan);
    li.appendChild(delBtn);

    return li;
}
/* ================= SESSION UI ================= */
function createSession() {
    const id = "chat-" + Date.now();

    sessions.push(id);
    sessionMessages[id] = [];
    sessionTitles[id] = "New Chat";

    const li = createSessionListItem(id);
    document.getElementById("chat-list").prepend(li);

    setActiveSession(id);
    // new chat → no messages → never show scroll button
const scrollBtn = document.getElementById("scroll-bottom-btn");
if(scrollBtn) scrollBtn.classList.remove("show");
    clearPendingFiles();
    input.focus();
}

// Open a fresh empty draft chat without adding a sidebar item.
// It gets added to sidebar only when first message is sent.
function openDraftSession() {
    const id = "chat-" + Date.now();
    activeSession = id;
    sessionMessages[id] = [];
    sessionTitles[id] = "New Chat";
    localStorage.setItem("activeSession", id);
    highlightActiveSession(""); // no sidebar chat should be selected
    renderSession();
    toggleEmptyState();
    const scrollBtn = document.getElementById("scroll-bottom-btn");
    if (scrollBtn) scrollBtn.classList.remove("show");
    clearPendingFiles();
    input?.focus();
}
function navigateToSession(id) {
    if (!id || !sessions.includes(id)) return;

    activeSession = id;
    localStorage.setItem("activeSession", id);

    highlightActiveSession(id);
    renderSession();
    toggleEmptyState();
    clearPendingFiles();
}

function switchSession(id) {
    navigateToSession(id);
}

function highlightActiveSession(id) {
    document.querySelectorAll("#chat-list li").forEach(li => {
        li.classList.toggle("active", li.dataset.id === id);
    });
}
function setActiveSession(id) {
    if (!id || !sessions.includes(id)) {
        console.error("Invalid session:", id);
        return;
    }

    activeSession = id;
    localStorage.setItem("activeSession", id);
    // 🔥 Move active session to top (ChatGPT behavior)
    highlightActiveSession(id);
    renderSession();
    toggleEmptyState();
}
// ===== Preserve scroll position across refresh =====
var restoringChatScroll = false;
function saveChatScrollPosition(){
    if(restoringChatScroll) return;
    saveChatScrollPositionValue();
}

function restoreChatScrollPosition(){
    const chatBox = document.getElementById("chat-box");
    const scrollBtn = document.getElementById("scroll-bottom-btn");
    stabilizeChatScrollRestore(chatBox, {
        onComplete: () => {
            userAtBottom = isChatScrolledNearBottom(chatBox);
            if(scrollBtn){
                scrollBtn.classList.toggle("show", !userAtBottom);
            }
        }
    });
}

function markSessionAsMessaged(id) {
    sessionLastActive[id] = Date.now();
    sessions = sessions.filter(s => s !== id);
    sessions.unshift(id);

    const chatList = document.getElementById("chat-list");
    chatList.innerHTML = "";

    sessions.forEach(sid => {
        chatList.appendChild(createSessionListItem(sid));
    });

    highlightActiveSession(id);
    saveToStorage();
}
/* ================= SEND MESSAGE ================= */
function saveMessage(sender, text, attachments = null) {
    if (!sessionMessages[activeSession]) {
        sessionMessages[activeSession] = [];
    }
    const payload = { sender, text };
    if(attachments && attachments.length){
        payload.attachments = attachments;
    }
    sessionMessages[activeSession].push(payload);
    saveToStorage();
}

/* ================= CLEAR ALL HISTORY ================= */
async function clearAllHistory(){
    // do not show confirmation if there is no real chat history
    const hasAnyMessages = Object.values(sessionMessages).some(arr => arr && arr.length > 0);
    if(!hasAnyMessages){
        openEmptyHistoryNotice();
        return;
    }
    return;

    // tell server to delete everything
    await fetch("/clear-history", { method:"POST" });

    // wipe browser memory
    sessions.length = 0;
    activeSession = null;

    for(const k in sessionMessages) delete sessionMessages[k];
    for(const k in sessionTitles) delete sessionTitles[k];
    for(const k in sessionLastActive) delete sessionLastActive[k];

    // wipe UI
    document.getElementById("chat-list").innerHTML = "";
    document.getElementById("chat-box").innerHTML = "";

    // create fresh empty session
    createSession();
    toggleEmptyState();
}
function deleteSession(id) {
    const index = sessions.indexOf(id);
    if (index === -1) return;

    // Remove data
    delete sessionMessages[id];
    delete sessionTitles[id];
    sessions.splice(index, 1);

    // Remove DOM
    const li = document.querySelector(`#chat-list li[data-id="${id}"]`);
    if (li) li.remove();
    // close any open chat menu popups after deletion
    document.querySelectorAll('.chat-menu-pop').forEach(p => p.remove());

    // Always move to a fresh empty draft chat after deleting any chat.
    // This draft is not added to sidebar until first message is sent.
    openDraftSession();
    saveToStorage();

fetch("/delete-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: id })
});
}
function toggleChatMenu(li, id){
    const closeMenu = (pop) => {
        if(!pop) return;
        pop.classList.remove("show");
        setTimeout(()=>pop.remove(), 190);
    };

    const existingSame = document.querySelector(`.chat-menu-pop[data-chat-id="${id}"]`);
    if(existingSame){
        closeMenu(existingSame);
        return;
    }

    document.querySelectorAll(".chat-menu-pop").forEach(p=>closeMenu(p));

    const pop = document.createElement("div");
    pop.className = "chat-menu-pop";
    pop.dataset.chatId = id;

    const share = document.createElement("div");
    share.className = "chat-menu-item";
    share.innerText = "Share";

    const del = document.createElement("div");
    del.className = "chat-menu-item danger";
    del.innerText = "Delete";
    del.onclick = ()=> deleteSession(id);

    pop.appendChild(share);
    pop.appendChild(del);

    document.body.appendChild(pop);
    requestAnimationFrame(()=> pop.classList.add("show"));

    const rect = li.getBoundingClientRect();
    const sidebarRect = document.querySelector(".sidebar")?.getBoundingClientRect();
    const popWidth = pop.getBoundingClientRect().width;

    // Place below selected chat row.
    pop.style.top = (rect.bottom + 8) + "px";

    // Place popup centered on sidebar right border line.
    if (sidebarRect) {
        pop.style.left = (sidebarRect.right - popWidth / 2) + "px";
    } else {
        pop.style.left = rect.left + "px";
    }

    setTimeout(()=>{
        document.addEventListener("click", function handler(e){
            if(!pop.contains(e.target)){
                closeMenu(pop);
                document.removeEventListener("click", handler);
            }
        });
    },0);
}
function showDeleteConfirm(li, id) {
    // Remove existing popovers
    document.querySelectorAll(".confirm-popover").forEach(p => p.remove());

    const pop = document.createElement("div");
    pop.className = "confirm-popover";

    const cancel = document.createElement("button");
    cancel.className = "cancel";
    cancel.innerText = "Cancel";

    const confirm = document.createElement("button");
    confirm.className = "confirm";
    confirm.innerText = "Delete";

    cancel.onclick = () => pop.remove();
    confirm.onclick = () => deleteSession(id);

    pop.appendChild(cancel);
    pop.appendChild(confirm);

    li.style.position = "relative";
    li.appendChild(pop);

    // Click outside to close
    setTimeout(() => {
        document.addEventListener("click", function handler(e) {
            if (!li.contains(e.target)) {
                pop.remove();
                document.removeEventListener("click", handler);
            }
        });
    }, 0);
}
/* ================= LOGOUT ================= */
