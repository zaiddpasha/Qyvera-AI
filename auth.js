var SERVER_MODE = false;

async function checkAuth() {
    let authPassed = false;
    try {
        const res = await fetch("/auth-check", { credentials: "include" });

        if (res.status !== 200) {
            showAuthScreen();
            return false;
        }

        const data = await res.json();
        authPassed = true;
        // only play intro animation after real login
        const isFreshLogin = data.fresh_login === true;
        if (isFreshLogin) {
            sessionStorage.setItem("play_intro", "1");
            // Prevent any sidebar flash before intro starts and keep it closed after intro.
            document.body.classList.add("intro-hide-sidebar");
            setSidebarHidden(true);
        } else {
            document.body.classList.remove("intro-hide-sidebar");
        }

        document.getElementById("auth-container").style.display = "none";
        document.querySelector(".app-layout").style.display = "flex";
        // attach scroll intelligence AFTER app loads
        const chatBox = document.getElementById("chat-box");
        const scrollBtn = document.getElementById("scroll-bottom-btn");

        if (chatBox) { 
             chatBox.addEventListener("scroll", () => {
                userAtBottom = isChatScrolledNearBottom(chatBox);
              // Save scroll position continuously so refresh restores exact location
                saveChatScrollPosition();

                if(scrollBtn){
                   scrollBtn.classList.toggle("show", !userAtBottom);
                 }
            });
        }

       if (scrollBtn) {
         scrollBtn.onclick = () => {
            chatBox.scrollTo({
            top: chatBox.scrollHeight,
            behavior: "smooth"
           });
          };
       }

        // force browser layout recalculation so left icon bar does not collapse
        document.querySelector(".app-layout").offsetHeight;

        SERVER_MODE = true;

        // 🔥 CLEAR OLD LOCAL DATA FIRST (IMPORTANT)
        sessions = [];
        activeSession = null;
        for (const k in sessionMessages) delete sessionMessages[k];
        for (const k in sessionTitles) delete sessionTitles[k];

        // 🔥 THEN LOAD SERVER HISTORY
        window.__freshLogin = data.fresh_login === true;
        await loadHistoryFromServer();
        syncChatScrollbarEdgeOffset();
        toggleEmptyState();
        setUserProfile(data.email, data.picture || data.photo || null);

        // do NOT auto play intro on refresh
        if (sessionStorage.getItem("play_intro") !== "1") {
            document.getElementById("intro-splash")?.remove();
        }

        return true;

    } catch (err) {
        console.error("checkAuth failed", err);
        if(!authPassed){
            showAuthScreen();
            return false;
        }
        document.getElementById("auth-container").style.display = "none";
        document.querySelector(".app-layout").style.display = "flex";
        return true;

    } finally {
        // 🔥 CRITICAL FIX — loader always removed
        document.getElementById("boot-loader")?.remove();
    }
}
function showAuthScreen() {
    document.querySelector(".app-layout").style.display = "none";
    document.getElementById("auth-container").style.display = "flex";

    logoutBtn = document.getElementById("logout-btn");
if (logoutBtn) logoutBtn.style.display = "none";
}

function loginWithGoogle() {
    window.location.href = "/login/google";
}
var logoutBtn = null;
async function loadHistoryFromServer() {

    const res = await fetch("/history", { credentials: "include" });
    if (res.status !== 200) return;

    const data = await res.json();
    if (!data.chats) return;

    // restore last active timestamps for same-browser continuity,
    // but prefer server-provided conversation order on login.
    const savedLast = JSON.parse(localStorage.getItem("sessionLastActive") || "{}");
    Object.assign(sessionLastActive, savedLast);
    const serverOrder = Array.isArray(data.order) ? data.order : [];

    sessions = [];
    activeSession = null;

    for (const convId in data.chats) {

        sessions.push(convId);
        sessionMessages[convId] = [];

        let firstUserMessage = null;

        data.chats[convId].forEach((entry) => {
            let role;
            let content;
            let attachments = [];

            if (Array.isArray(entry)) {
                role = entry[0];
                content = entry[1];
            } else {
                role = entry.role;
                content = entry.content;
                attachments = normalizeMergeAttachments(Array.isArray(entry.attachments) ? entry.attachments : []);
            }

            if (role === "assistant") role = "ai";

            const msgPayload = {
                sender: role,
                text: content || ""
            };
            if (attachments.length) {
                msgPayload.attachments = attachments;
            }
            sessionMessages[convId].push(msgPayload);

            // capture first user message → used as title
            if (!firstUserMessage && role === "user") {
                if (content) {
                    firstUserMessage = content;
                }
            }
        });

        // generate title from first message (same logic as sendMessage)
        if (firstUserMessage) {
            sessionTitles[convId] = buildChatTitleFromText(firstUserMessage);
        } else {
            sessionTitles[convId] = "New Chat";
        }
    }

    // Prefer server order based on latest message activity.
    // Fall back to local timestamps only for sessions missing from server order.
    if (serverOrder.length) {
        const orderIndex = new Map(serverOrder.map((id, index) => [id, index]));
        sessions.sort((a, b) => {
            const aIndex = orderIndex.has(a) ? orderIndex.get(a) : Number.MAX_SAFE_INTEGER;
            const bIndex = orderIndex.has(b) ? orderIndex.get(b) : Number.MAX_SAFE_INTEGER;
            if (aIndex !== bIndex) return aIndex - bIndex;
            return (sessionLastActive[b] || 0) - (sessionLastActive[a] || 0);
        });
    } else {
        sessions.sort((a,b)=> (sessionLastActive[b]||0)-(sessionLastActive[a]||0));
    }

    // rebuild sidebar
    const chatList = document.getElementById("chat-list");
    chatList.innerHTML = "";
    sessions.forEach(id => chatList.appendChild(createSessionListItem(id)));

    // On refresh: restore the same active chat session
    const saved = localStorage.getItem("activeSession");
    if (!window.__freshLogin && saved && sessions.includes(saved)) {
        setActiveSession(saved);
    } else {
        // Fresh login behavior: open a new empty draft chat.
        // Keep history in sidebar, but don't add draft there until first message.
        openDraftSession();
    }

    toggleEmptyState();
}
function setUserProfile(email, photo){
    const panel = document.getElementById("settings-email");
    if(!panel) return;

    panel.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "10px";

    const img = document.createElement("img");
    img.style.width = "28px";
    img.style.height = "28px";
    img.style.borderRadius = "50%";
    img.style.objectFit = "cover";
    img.style.border = "1px solid rgba(255,255,255,0.15)";

        // use real google photo directly
    if(photo){
        img.src = photo;
    }

    // fallback if blocked
    img.onerror = ()=>{
        img.src = "https://ui-avatars.com/api/?background=1f233b&color=e6e9ff&name=" + encodeURIComponent(email || "U");
    };

    // ⭐⭐⭐ VERY IMPORTANT — sync top navbar avatar ⭐⭐⭐
    const topAvatar = document.getElementById("topbar-avatar");
    if(topAvatar){
        topAvatar.src = img.src;
    }
    const text = document.createElement("div");
    text.style.fontSize = "13px";
    text.style.color = "#cfd5ff";
    text.style.wordBreak = "break-all";
    text.innerText = email || "User";

    wrapper.appendChild(img);
    wrapper.appendChild(text);
    panel.appendChild(wrapper);
}
