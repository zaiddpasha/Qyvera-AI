function syncChatScrollbarEdgeOffset(){
    const chatContainerEl = document.querySelector(".chat-container");
    if(!chatContainerEl) return;
    const rightGap = Math.max(0, Math.round(window.innerWidth - chatContainerEl.getBoundingClientRect().right));
    document.documentElement.style.setProperty("--chat-scroll-edge-offset", `${rightGap}px`);
    updateScrollButtonAnchor();
}

function updateScrollButtonAnchor(){
    const chatContainerEl = document.querySelector(".chat-container");
    const inputAreaEl = document.querySelector(".input-area");
    const scrollBtnEl = document.getElementById("scroll-bottom-btn");
    if(!chatContainerEl || !inputAreaEl || !scrollBtnEl) return;

    const containerRect = chatContainerEl.getBoundingClientRect();
    const inputRect = inputAreaEl.getBoundingClientRect();
    const gap = 12;
    const dynamicBottom = Math.max(12, Math.round(containerRect.bottom - inputRect.top + gap));
    scrollBtnEl.style.setProperty("--scroll-btn-bottom", `${dynamicBottom}px`);
}

function refreshChatScrollbar(){
    const chatBoxEl = document.getElementById("chat-box");
    if(!chatBoxEl) return;
    // Force a clean scrollbar reflow so it remains visible after sidebar toggles.
    chatBoxEl.style.overflowY = "hidden";
    requestAnimationFrame(() => {
        chatBoxEl.style.overflowY = "scroll";
        syncChatScrollbarEdgeOffset();
    });
}

function autoResizeInputBox(){

    if(!input) return;

    const MAX_HEIGHT = 180;
    const MIN_HEIGHT = 44; // keep input visible like ChatGPT

    // reset height first so scrollHeight reflects full content
    input.style.height = "0px";

    const contentHeight = input.scrollHeight;

    const newHeight = Math.max(MIN_HEIGHT, Math.min(contentHeight, MAX_HEIGHT));

    input.style.height = newHeight + "px";

    if(input.scrollHeight > MAX_HEIGHT){
        input.style.overflowY = "auto";
    }else{
        input.style.overflowY = "hidden";
    }

    updateScrollButtonAnchor?.();
}
let hoverTipEl = null;
function ensureHoverTip(){
    if(hoverTipEl) return hoverTipEl;
    hoverTipEl = document.createElement("div");
    hoverTipEl.className = "hover-tip";
    document.body.appendChild(hoverTipEl);
    return hoverTipEl;
}

function getHoverText(el){
    if(!el) return "";
    if(el === sidebarToggleBtn){
        return sidebar?.classList.contains("hide-sidebar") ? "Expand sidebar" : "Close sidebar";
    }
    if(el === sendBtn){
        if(responseInFlight) return "Stop generating";
        return (input?.value.trim().length || pendingFiles.length) ? "" : "Message is empty";
    }
    return el.dataset.hoverHint || "";
}

function showHoverTip(e){
    const text = getHoverText(e.currentTarget);
    if(!text){
        hideHoverTip();
        return;
    }
    const tip = ensureHoverTip();
    tip.textContent = text;
    tip.classList.add("show");
    const rect = e.currentTarget.getBoundingClientRect();
    const tipWidth = tip.offsetWidth || 120;
    const tipHeight = tip.offsetHeight || 28;
    const margin = 8;
    const bottomGap = 3;
    const placement = e.currentTarget.dataset.hoverPlacement || "auto";
    let left;
    let top;

    if(placement === "right"){
        left = rect.right + margin;
        top = rect.top + (rect.height / 2) - (tipHeight / 2);
    }else if(placement === "bottom"){
        left = rect.left + (rect.width / 2) - (tipWidth / 2);
        top = rect.bottom + bottomGap;
    }else if(placement === "bottom-tight"){
        left = rect.left + (rect.width / 2) - (tipWidth / 2);
        const visualHeight = Math.min(rect.height, 26);
        top = rect.top + visualHeight + 2;
    }else if(placement === "bottom-controls"){
        left = rect.left + (rect.width / 2) - (tipWidth / 2);
        const refRect = sidebarToggleBtn?.getBoundingClientRect() || rect;
        top = refRect.bottom + 3;
    }else{
        left = rect.left + (rect.width / 2) - (tipWidth / 2);
        top = rect.top - tipHeight - margin;
        if(top < 8){
            top = rect.bottom + margin;
        }
    }

    left = Math.max(8, Math.min(left, window.innerWidth - tipWidth - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - tipHeight - 8));

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
}

function hideHoverTip(){
    if(!hoverTipEl) return;
    hoverTipEl.classList.remove("show");
}

function bindHoverTip(el, text, placement){
    if(!el) return;
    if(text) el.dataset.hoverHint = text;
    if(placement) el.dataset.hoverPlacement = placement;
    el.removeAttribute("title");
    el.addEventListener("mouseenter", showHoverTip);
    el.addEventListener("mouseleave", hideHoverTip);
    el.addEventListener("mousedown", hideHoverTip);
    el.addEventListener("click", hideHoverTip);
    el.addEventListener("blur", hideHoverTip);
}

function updateSendState(){
    if(!sendBtn || !input || !inputArea) return;
    if(responseInFlight){
        sendBtn.classList.add("is-stop");
        sendBtn.classList.remove("active");
        inputArea.classList.remove("input-empty");
        sendBtn.removeAttribute("title");
        return;
    }
    const hasText = input.value.trim().length > 0;
    const hasFiles = pendingFiles.length > 0;

    if(hasText || hasFiles){
        sendBtn.classList.add("active");
        inputArea.classList.remove("input-empty");
        sendBtn.removeAttribute("title");
    }else{
        sendBtn.classList.remove("active");
        inputArea.classList.add("input-empty");
        sendBtn.removeAttribute("title");
    }
}

/* ================= RENDER SESSION ================= */
function renderSession() {
    const chatBox = document.getElementById("chat-box");
    if(!chatBox) return;
    chatBox.innerHTML = "";

    if (!sessionMessages[activeSession]) return;

    sessionMessages[activeSession].forEach(msg => {
        // render without animation or scrolling during history load
        renderMessage(msg.sender, msg.text, false, msg.attachments || null);
    });
    applyPremiumLinkStyles(chatBox);
    restoreChatScrollPosition();
}

/* ================= TYPING INDICATOR ================= */
function showTypingIndicator() {
    const chatBox = document.getElementById("chat-box");
    removeTypingIndicator();

    const row = document.createElement("div");
    row.className = "msg-row ai-row";

    const div = document.createElement("div");
    div.className = "ai";
    div.id = "typing-indicator";
    div.innerHTML = "<span class='dot'></span><span class='dot'></span><span class='dot'></span>";

    row.appendChild(div);
    chatBox.appendChild(row);
    smartScroll();
}

function removeTypingIndicator() {
    // DO NOT remove element — only clear dots so message replaces in same position
    const indicator = document.getElementById("typing-indicator");
    return indicator;
}
/* ================= RENDER MESSAGE ================= */
function renderMessage(sender, text, animate = true, attachments = null) {
    const chatBox = document.getElementById("chat-box");
    if(sender === "user" && attachments && attachments.length){
        renderAttachmentsAboveUserBubble(chatBox, attachments);
    }
    const onlyUserAttachments = sender === "user" && (!text || !text.trim()) && attachments && attachments.length;
    if(onlyUserAttachments){
        smartScroll();
        return;
    }
    const row = document.createElement("div");
    row.className = "msg-row " + sender + "-row";

    const msgDiv = document.createElement("div");
    msgDiv.className = sender;

    row.appendChild(msgDiv);
    chatBox.appendChild(row);
    // smartScroll(); // <-- REMOVE this line to prevent repeated scrolls during 

    // ✅ Always remove typing indicator when AI responds

    const originalText = text;

    // Remove markdown bold (**text**) before animation
    text = text.replace(/\*\*(.*?)\*\*/g, "$1");
    // Remove markdown headings (### Heading)
    text = text.replace(/^###\s*/gm, "");
    // Match final formatter behavior during live typing as well.
    text = text.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, "");
    text = text.replace(/^\s*[-*]\s+/gm, "• ");

    // Split text into TEXT and CODE blocks
    const parts = text.split(/```([\s\S]*?)```/g);

    if (sender !== "ai" || !animate) {
        if(sender === "ai"){
            msgDiv.innerHTML = renderStreamFormattedHTML(originalText);
        }else{

    msgDiv.dataset.fullText = text;

    // Force copy to always return the full original text (ignores Show more / Show less UI)
    msgDiv.addEventListener("copy", function(e){
        const full = msgDiv.dataset.fullText;
        if(!full) return;

        e.preventDefault();
        if(e.clipboardData){
            e.clipboardData.setData("text/plain", full);
        }
    });

    const LIMIT = 280;

    if(sender === "user" && text.length > LIMIT){

        const shortText = text.slice(0, LIMIT) + "...";

        msgDiv.textContent = shortText;
        msgDiv.dataset.collapsedText = shortText;

        const toggle = document.createElement("span");
        toggle.className = "user-toggle";
        toggle.textContent = "Show more";

        let expanded = false;

        toggle.addEventListener("click", (e)=>{
            e.stopPropagation();

            expanded = !expanded;

            if(expanded){
                msgDiv.textContent = msgDiv.dataset.fullText;
                toggle.textContent = "Show less";
            }else{
                msgDiv.textContent = msgDiv.dataset.collapsedText;
                toggle.textContent = "Show more";
            }

            msgDiv.appendChild(toggle);
        });

        msgDiv.appendChild(toggle);

    }else{
        msgDiv.textContent = text;
    }

   }

        enhanceCodeBlocks(msgDiv);
        applyPremiumLinkStyles(msgDiv);
        enforceHeadingOnlyBold(msgDiv);

        if(sender !== "user"){
            appendAttachmentsToBubble(msgDiv, attachments);
        }

        // Constrain all normal AI images (exclude full attachment images)
        msgDiv.querySelectorAll("img:not(.attachment-image-full)").forEach(img => {
            img.style.maxWidth = "220px";
            img.style.maxHeight = "220px";
            img.style.width = "auto";
            img.style.height = "auto";
            img.style.objectFit = "contain";
        });

        addCopyButton(msgDiv);
        return;
    }

    let partIndex = 0;
    let charIndex = 0;

    function type() {
        if (stopTyping) {
            removeStopButton();
            return;
        }

        if (partIndex >= parts.length) {
            removeStopButton();
            return;
        }

        const part = parts[partIndex];

        // 🧱 CODE BLOCK (odd index)
        if (partIndex % 2 === 1) {
            msgDiv.innerHTML += createCodeBlock(part);
            enhanceCodeBlocks(msgDiv);
            applyPremiumLinkStyles(msgDiv);
            enforceHeadingOnlyBold(msgDiv);
            partIndex++;
            setTimeout(type, 40);
            return;
        }

        // ✍️ TEXT BLOCK (even index)
        if (charIndex < part.length) {
            msgDiv.innerHTML += escapeHTML(part.charAt(charIndex));
            charIndex++;
            smartScroll(); 
            setTimeout(type, 18);
        } else {
            charIndex = 0;
            partIndex++;
            setTimeout(type, 40);
        }
    }

    type();
}



function enhanceCodeBlocks(root){
    if(!root) return;
    const blocks = root.querySelectorAll(".code-block");
    blocks.forEach((block) => {
        updateCodeLineNumbers(block);
        applyHighlightToCodeBlock(block);
    });
}

function applyPremiumLinkStyles(msgDiv){
    if(!msgDiv) return;
    const links = msgDiv.querySelectorAll('a:not(.msg-attachment)');
    links.forEach(link => {
        // JS should only apply classes. All visual styling must be in CSS.
        link.classList.add("ai-inline-link");
    });
}

function addCopyButton(bubble){
    if(!bubble || !bubble.parentNode) return;
    // For user messages we anchor the actions to the message row so it can sit
    // just below the bubble without affecting bubble size.
    const isUser = bubble.classList.contains("user");
    const row = bubble.parentNode;   // message row wrapper
    // always append actions to the row (sibling) rather than inside bubble
    const parent = row;
    const ownerId = bubble.dataset.copyOwnerId || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    bubble.dataset.copyOwnerId = ownerId;

    const old = (isUser ? row : parent)
        .querySelector(`.msg-actions[data-owner-id="${ownerId}"]`);
    if(old) old.remove();

    const bar = document.createElement("div");
    bar.className = "msg-actions";
    bar.dataset.ownerId = ownerId;
    // if the bubble contains attachments (typically tool responses), mark it
    if(!isUser && bubble.querySelector(".msg-attachments")){
        bar.classList.add("has-attachments");
    }

    const copy = document.createElement("div");
    copy.className = "msg-btn";
    copy.innerText = "⧉";

    copy.onclick = ()=>{
        let text = "";
        if(isUser && bubble.dataset.fullText){
            text = bubble.dataset.fullText;
        }else{
            // clone bubble so we can remove buttons before copying
            const clone = bubble.cloneNode(true);

            // remove action buttons (copy icons, etc)
            clone.querySelectorAll('.msg-actions, .copy-btn').forEach(el=>el.remove());

            text = clone.innerText.trim();
        }
        navigator.clipboard.writeText(text);

        copy.innerText = "✓";
        setTimeout(()=>copy.innerText="⧉",1200);
    };

    bar.appendChild(copy);
    // Attach actions inside the bubble so it can be positioned bottom-right
    if(isUser){
        if(bubble){
            bar.classList.add("msg-actions-user");
            bubble.appendChild(bar);
        }
     }else{
    // Keep AI copy actions in normal flow directly under the AI message.
    bar.classList.add("msg-actions-outside");
    bar.classList.add("msg-actions-ai");
    if(bubble.parentNode){
        bubble.insertAdjacentElement("afterend", bar);
    }
}
}

function copyCode(btn) {
    const codeEl = btn.closest(".code-block")?.querySelector("code");
    if(!codeEl) return;
    const text = codeEl.innerText;

    navigator.clipboard.writeText(text).then(() => {
        btn.innerText = "Copied ✓";
        setTimeout(() => btn.innerText = "Copy", 1500);
    });
}
function toggleEmptyState() {
    const empty = document.getElementById("empty-state");
    if (!empty || !activeSession) return;

    const hasMessages = (sessionMessages[activeSession]?.length || 0) > 0;
    const container = document.querySelector(".chat-container");

if(!hasMessages){
    container?.classList.add("center-input");
}else{
    container?.classList.remove("center-input");
}

    empty.style.display = hasMessages ? "none" : "flex";

    // ⭐ hide scroll button if chat empty
    const scrollBtn = document.getElementById("scroll-bottom-btn");
    if (scrollBtn) {
        scrollBtn.classList.toggle("show", hasMessages && !userAtBottom);
    }
    updateScrollButtonAnchor();
}
/* ===== PREMIUM CLEAR HISTORY MODAL ===== */

/* ===== EMPTY HISTORY NOTICE (SMALL POPUP) ===== */
function openEmptyHistoryNotice(){
    let notice = document.getElementById("empty-history-notice");
    if(!notice){
        notice = document.createElement("div");
        notice.id = "empty-history-notice";
        notice.innerText = "No conversations yet";
        document.body.appendChild(notice);
    }

    notice.classList.add("show");
    setTimeout(()=>notice.classList.remove("show"),1800);
}
