document.addEventListener("DOMContentLoaded", async () => {

    const markAppChromeReady = () => {
        document.querySelector(".app-layout")?.classList.add("ready");
        document.querySelector(".icon-bar")?.classList.add("ready");
        document.querySelector(".sidebar")?.classList.add("ready");
        document.querySelector(".chat-container")?.classList.add("ready");
        document.querySelector(".top-left-anchor")?.classList.add("ready");
        document.getElementById("topbar-avatar")?.classList.add("ready");
    };

    // always show something immediately
    document.querySelector(".app-layout").style.display = "none";
    document.getElementById("auth-container").style.display = "flex";

    // never let loader lock page
    setTimeout(() => {
        document.getElementById("boot-loader")?.remove();
    }, 1500);

    try {
        const loggedIn = await checkAuth();
        const shouldAnimate = sessionStorage.getItem("play_intro") === "1";

        if (loggedIn && shouldAnimate) {
            sessionStorage.removeItem("play_intro");
            await playIntroAnimation();
            document.body.classList.add("app-ready");
            document.getElementById("page-transition")?.remove();
        } else if (loggedIn) {
            // instantly show app (no animation)
            document.body.classList.add("app-ready");
            document.getElementById("page-transition")?.remove();
            markAppChromeReady();
        }
    } catch(e) {
        console.error("App boot failed", e);
    }
    // Top new chat button: open draft chat (not sidebar item until first message)
   document.getElementById("new-chat-top")?.addEventListener("click", openDraftSession);
   window.addEventListener("resize", syncChatScrollbarEdgeOffset);
  syncChatScrollbarEdgeOffset();
  requestAnimationFrame(updateScrollButtonAnchor);
  if (sessionStorage.getItem("play_intro") !== "1") {
      document.body.classList.remove("preload");
  }

});
document.addEventListener("click", function(e){

    // handle images wrapped in link
    const link = e.target.closest(".ai-image-link");
    if(link){
        e.preventDefault();
        e.stopPropagation();

        const img = link.querySelector("img");
        const url = img ? img.getAttribute("src") : link.getAttribute("href");

        if(url){
            openFilePreviewFromUrl(url, "Image");
        }
        return;
    }

    // handle plain images rendered by marked.parse after refresh
    const img = e.target.closest(".ai img, img.ai-inline-image, img.chat-image");
    if(!img) return;

    e.preventDefault();
    e.stopPropagation();

    const url = img.getAttribute("src");

    if(url){
        openFilePreviewFromUrl(url, "Image");
    }

});
/* ================= GLOBALS ================= */
var userAtBottom = true;
var chatBox = document.getElementById("chat-box");
var scrollBtn = document.getElementById("scroll-bottom-btn");


var input = document.getElementById("user-input");
/* ChatGPT style input grow + internal scroll */
var sendBtn = document.querySelector(".send-btn");
var inputArea = document.querySelector(".input-area");
var newChatTopBtn = document.getElementById("new-chat-top");
var uploadBtn = document.getElementById("upload-btn");
var micBtn = document.getElementById("mic-btn");
var pendingFilesWrap = document.getElementById("pending-files");
var fileInput = document.getElementById("file-input");
var filePreviewModal = document.getElementById("file-preview-modal");
var filePreviewBody = document.getElementById("file-preview-body");
var filePreviewTitle = document.getElementById("file-preview-title");
var filePreviewClose = document.getElementById("file-preview-close");
var responseInFlight = false;
var activeResponseController = null;
input.addEventListener("input", () => {
    updateSendState();
    autoResizeInputBox();
});

input.addEventListener("paste", () => {
    // allow paste content to enter DOM first
    requestAnimationFrame(() => {
        autoResizeInputBox();
    });
});

// run once on load so initial height is correct
requestAnimationFrame(() => autoResizeInputBox());

setupInputAreaDnD();
renderPendingFiles();
updateSendState();
updateScrollButtonAnchor();
if(window.ResizeObserver && inputArea){
    const scrollAnchorObserver = new ResizeObserver(() => updateScrollButtonAnchor());
    scrollAnchorObserver.observe(inputArea);
}
input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

var sidebar = document.querySelector(".sidebar");
var logoToggle = document.querySelector(".top-left-anchor .app-logo");
var topLeftAnchor = document.querySelector(".top-left-anchor");
var sidebarToggleBtn = document.getElementById("sidebar-toggle");

// restore sidebar state after refresh
function setSidebarHidden(hidden){
    if(!sidebar) return;
    sidebar.classList.toggle("hide-sidebar", hidden);
    topLeftAnchor?.classList.toggle("sidebar-open", !hidden);
    sidebarToggleBtn?.removeAttribute("title");
    if(hidden){
        localStorage.setItem("sidebar_hidden","1");
    }else{
        localStorage.removeItem("sidebar_hidden");
    }
    requestAnimationFrame(refreshChatScrollbar);
    setTimeout(refreshChatScrollbar, 240);
}

setSidebarHidden(localStorage.getItem("sidebar_hidden") === "1");

bindHoverTip(newChatTopBtn, "New chat");
bindHoverTip(uploadBtn, "Upload docs or images");
bindHoverTip(micBtn, "Dictate");
bindHoverTip(logoToggle, "Qyvera AI", "bottom-controls");
bindHoverTip(sidebarToggleBtn);
bindHoverTip(sendBtn);

function toggleSidebar(e){
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if(!sidebar) return;
    setSidebarHidden(!sidebar.classList.contains("hide-sidebar"));
}

sidebarToggleBtn?.addEventListener("click", toggleSidebar);
logoToggle?.addEventListener("click", toggleSidebar);
window.addEventListener("load", () => {

    const logoutBtn = document.getElementById("logout-btn");
    if (!logoutBtn) return;

    // instant logout (no confirmation modal)
    logoutBtn.addEventListener("click", async () => {
        await fetch("/logout", { method: "POST" });
        localStorage.clear();
        showAuthScreen();
    });

});
window.addEventListener("load", ()=>{
    const modal = document.getElementById("clear-history-modal");
    const cancel = document.getElementById("cancel-clear-history");
    const confirmBtn = document.getElementById("confirm-clear-history");

    if(!modal) return;

    cancel?.addEventListener("click", () => {
        modal.classList.remove("show");
    });

    confirmBtn?.addEventListener("click", async ()=>{
        

        await fetch("/clear-history", { method:"POST" });

        sessions.length = 0;
        activeSession = null;
        for(const k in sessionMessages) delete sessionMessages[k];
        for(const k in sessionTitles) delete sessionTitles[k];
        for(const k in sessionLastActive) delete sessionLastActive[k];

        document.getElementById("chat-list").innerHTML = "";
        document.getElementById("chat-box").innerHTML = "";

        createSession();
        toggleEmptyState();
    });

    modal.addEventListener("click", e=>{
        if(e.target === modal) ;
    });
});
// AUTH TAB SWITCH
document.getElementById("loginTab")?.addEventListener("click", ()=>{
    document.getElementById("loginTab").classList.add("active");
    document.getElementById("registerTab").classList.remove("active");

    document.getElementById("auth-desc").innerText =
        "Continue with your Google account";

    document.getElementById("auth-btn-text").innerText =
        "Continue with Google";
});

document.getElementById("registerTab")?.addEventListener("click", ()=>{
    document.getElementById("registerTab").classList.add("active");
    document.getElementById("loginTab").classList.remove("active");

    document.getElementById("auth-desc").innerText =
        "Create your IntelliTalk account using Google";

    document.getElementById("auth-btn-text").innerText =
        "Sign up with Google";
});
async function playIntroAnimation(){

    const splash = document.getElementById("intro-splash");
    if(!splash) return;

    document.body.classList.add("intro-hide-sidebar");
    document.body.classList.add("intro-handoff");

    const introTag = splash.querySelector(".intro-tag");
    if(introTag && !introTag.dataset.split){
        const text = introTag.textContent || "";
        introTag.textContent = "";
        Array.from(text).forEach((ch, i) => {
            const span = document.createElement("span");
            span.className = "intro-tag-letter";
            span.style.setProperty("--i", i.toString());
            span.innerHTML = ch === " " ? "&nbsp;" : ch;
            introTag.appendChild(span);
        });
        introTag.dataset.split = "1";
    }

    // wait while intro logo/text + tagline animation fully completes and is visible
    await new Promise(r=>setTimeout(r,3800));

    // reveal app base state first (kept visually hidden by intro-handoff)
    document.querySelector(".app-layout")?.classList.add("ready");
    document.querySelector(".icon-bar")?.classList.add("ready");
    document.querySelector(".sidebar")?.classList.add("ready");
    document.querySelector(".chat-container")?.classList.add("ready");

    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));

    const introLogo = splash.querySelector(".intro-logo-wrap");
    const introLogoImg = splash.querySelector(".intro-logo-img");
    const introWordmark = splash.querySelector(".intro-wordmark");
    const targetLogo = document.querySelector(".empty-brand-logo");
    const targetText = document.querySelector(".empty-brand-text");

    if(introLogo && introLogoImg && introWordmark && targetLogo && targetText){
        const logoRect = introLogoImg.getBoundingClientRect();
        const textRect = introWordmark.getBoundingClientRect();
        const targetLogoRect = targetLogo.getBoundingClientRect();
        const targetTextRect = targetText.getBoundingClientRect();
        

        // Create a viewport overlay so logo/text can move to exact target rects.
        const handoffLayer = document.createElement("div");
        handoffLayer.style.position = "fixed";
        handoffLayer.style.inset = "0";
        handoffLayer.style.pointerEvents = "none";
        handoffLayer.style.zIndex = "10000";

        const logoClone = document.createElement("img");
        logoClone.src = "/static/qyvera-logo.svg";
        logoClone.alt = "Qyvera logo";
        logoClone.style.position = "fixed";
        logoClone.style.left = `${logoRect.left}px`;
        logoClone.style.top = `${logoRect.top}px`;
        logoClone.style.width = `${logoRect.width}px`;
        logoClone.style.height = `${logoRect.height}px`;
logoClone.style.transformOrigin = "center center";
        logoClone.style.transform = "translate(0, 0) scale(1, 1)";
        logoClone.style.willChange = "transform";

        const introWordmarkStyle = getComputedStyle(introWordmark);
        const textClone = document.createElement("div");
        textClone.textContent = introWordmark.getAttribute("aria-label") || "yvera AI";
        textClone.style.position = "fixed";
        textClone.style.left = `${textRect.left}px`;
        textClone.style.top = `${textRect.top}px`;
        textClone.style.margin = "0";
        textClone.style.color = introWordmarkStyle.color;
        textClone.style.fontSize = introWordmarkStyle.fontSize;
        textClone.style.fontWeight = introWordmarkStyle.fontWeight;
        textClone.style.fontFamily = introWordmarkStyle.fontFamily;
        textClone.style.letterSpacing = introWordmarkStyle.letterSpacing;
        textClone.style.lineHeight = introWordmarkStyle.lineHeight;
        textClone.style.whiteSpace = "nowrap";
textClone.style.transformOrigin = "center center";
        textClone.style.transform = "translate(0, 0) scale(1, 1)";
        textClone.style.willChange = "transform";

        handoffLayer.appendChild(logoClone);
        handoffLayer.appendChild(textClone);
        document.body.appendChild(handoffLayer);

        // Fade "Your AI workspace" letters while logo/text shift is happening.
        if(introTag){
            introTag.classList.add("dissolve-during-handoff");
        }

        // Hide original intro elements during handoff.
        introLogo.style.opacity = "0";
        introLogoImg.style.opacity = "0";
        introWordmark.style.opacity = "0";

const logoDx = targetLogoRect.left - logoRect.left;
const logoDy = 0;   // remove vertical movement

const textDx = targetTextRect.left - textRect.left;
const textDy = 0;   // remove vertical movement
       const logoScale = logoRect.width > 0 ? (targetLogoRect.width / logoRect.width) : 1;
const textScale = textRect.width > 0 ? (targetTextRect.width / textRect.width) : 1;
        await new Promise(r=>requestAnimationFrame(r));

const timing = "transform .45s cubic-bezier(.22,.61,.36,1), opacity .45s ease";
logoClone.style.opacity = "0";
textClone.style.opacity = "0";
        logoClone.style.transition = timing;
        textClone.style.transition = timing;
        logoClone.style.transform = `scale(${logoScale})`;
        textClone.style.transform = `scale(${textScale})`;

        await new Promise(r=>setTimeout(r,740));
        handoffLayer.remove();
    } else {
        splash.classList.add("hide");
        await new Promise(r=>setTimeout(r,950));
    }

    splash.remove();
    document.querySelector(".top-left-anchor")?.classList.add("ready");
    document.getElementById("topbar-avatar")?.classList.add("ready");
    document.body.classList.remove("intro-hide-sidebar");
    document.body.classList.remove("intro-handoff");
    document.body.classList.remove("preload");
    setSidebarHidden(true);
    syncChatScrollbarEdgeOffset();
}
/* ===== SETTINGS PANEL ===== */

const settingsBtn = document.getElementById("topbar-avatar");
const settingsPanel = document.getElementById("settings-panel");

settingsBtn?.addEventListener("click", (e)=>{
    e.stopPropagation();
    settingsPanel.classList.toggle("show");
});

document.addEventListener("click", e=>{
    if(!settingsPanel.contains(e.target))
        settingsPanel.classList.remove("show");
});

// move email and photo into panel
/* ===== CLEAR HISTORY POPOVER ===== */

const clearBtn = document.getElementById("clear-history");
const clearPopover = document.getElementById("clear-history-popover");
const cancelClear = document.getElementById("cancel-clear-history");
const confirmClear = document.getElementById("confirm-clear-history");

clearBtn?.addEventListener("click", (e)=>{
    e.stopPropagation();
    const hasAnyMessages = Object.values(sessionMessages).some(arr => arr && arr.length > 0);
    if(!hasAnyMessages){
        openEmptyHistoryNotice();
        return;
    }
    clearPopover.classList.toggle("show");
});

cancelClear?.addEventListener("click", ()=>{
    clearPopover.classList.remove("show");
});

document.addEventListener("click",(e)=>{
    if(!clearPopover) return;
    if(!clearPopover.contains(e.target) && e.target !== clearBtn){
        clearPopover.classList.remove("show");
    }
});

clearPopover?.addEventListener("click", e=> e.stopPropagation());

confirmClear?.addEventListener("click", async ()=>{
    clearPopover.classList.remove("show");

    await fetch("/clear-history",{method:"POST"});

    sessions.length = 0;
    activeSession = null;
    for(const k in sessionMessages) delete sessionMessages[k];
    for(const k in sessionTitles) delete sessionTitles[k];
    for(const k in sessionLastActive) delete sessionLastActive[k];

    document.getElementById("chat-list").innerHTML = "";
    document.getElementById("chat-box").innerHTML = "";

    createSession();
    toggleEmptyState();
});
// ===== MIC BUTTON (placeholder) =====
document.addEventListener("click", e=>{
    if(e.target.id === "mic-btn"){
        console.log("Mic pressed (voice feature later)");
    }
});
// ===== FILE UPLOAD (DIRECT PICKER, NO POPUP) =====
uploadBtn?.addEventListener("click", ()=>{
    fileInput?.click();
});

fileInput?.addEventListener("change", e=>{
    const files = e.target.files;
    if(!files || !files.length) return;
    addPendingFiles(files);
    e.target.value = "";
});

filePreviewClose?.addEventListener("click", closeFilePreviewModal);

filePreviewModal?.addEventListener("click", (e) => {
    if(e.target === filePreviewModal){
        closeFilePreviewModal();
    }
});

document.addEventListener("keydown", (e) => {
    if(e.key === "Escape" && filePreviewModal?.classList.contains("show")){
        closeFilePreviewModal();
    }
});

document.addEventListener("click", async (e) => {
    const aiImageLink = e.target.closest("a.ai-image-link");
    if(aiImageLink){
        e.preventDefault();
        const img = aiImageLink.querySelector("img");
        const name = img?.alt || "Image preview";
        await openFilePreviewFromUrl(aiImageLink.getAttribute("href"), name);
        return;
    }
    const fileLink = e.target.closest("a.msg-attachment");
    if(!fileLink) return;
    if(fileLink.classList.contains("download") || fileLink.hasAttribute("download")) return;
    e.preventDefault();
    await openFilePreviewFromUrl(fileLink.getAttribute("href"), fileLink.dataset.fileName || fileLink.textContent || "File");
});

// Store scroll position before refresh to restore later
window.addEventListener("beforeunload", saveChatScrollPosition);
