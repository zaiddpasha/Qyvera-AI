function setSendStopState(isStop){
    responseInFlight = !!isStop;
    if(!sendBtn) return;
    sendBtn.classList.toggle("is-stop", responseInFlight);
    updateSendState();
}

function stopCurrentResponse(){
    stopTyping = true;
    if(activeResponseController){
        try { activeResponseController.abort(); } catch {}
        activeResponseController = null;
    }
    const indicator = document.getElementById("typing-indicator");
    if(indicator && indicator.querySelector(".dot")){
        indicator.remove();
    }
    setSendStopState(false);
    hideHoverTip();
}

let stopTyping = false;

async function sendMessage() {
    if(responseInFlight){
        stopCurrentResponse();
        return;
    }
    const msg = input.value.trim();
   const hasFiles = pendingFiles.length > 0;
   if (!msg && !hasFiles) return;

    const filesToSend = [...pendingFiles];
    const sentAttachments = filesToSend.map(file => ({
        name: file.name,
        url: URL.createObjectURL(file),
        mime: file.type || guessMimeFromName(file.name)
    }));
    const userVisibleMsg = msg;

    saveMessage("user", userVisibleMsg, sentAttachments);
    markSessionAsMessaged(activeSession);
    // 🔥 Move session to top ONLY when user actually sends a message
   sessions = sessions.filter(s => s !== activeSession);
   sessions.unshift(activeSession);

   // rebuild sidebar order
   const chatList = document.getElementById("chat-list");
   chatList.innerHTML = "";
    sessions.forEach(id => {
    chatList.appendChild(createSessionListItem(id));
    });

   highlightActiveSession(activeSession);
   saveToStorage();
    // 🔹 Auto-generate chat title from first message
     if (sessionMessages[activeSession].length === 1) {
    sessionTitles[activeSession] = buildChatTitleFromText(msg);

    // Update sidebar label
    const li = document.querySelector(
        `#chat-list li[data-id="${activeSession}"]`
    );
    if (li) li.querySelector("span").innerText = sessionTitles[activeSession];
    saveToStorage();
  }
    renderMessage("user", userVisibleMsg, true, sentAttachments);
    document.querySelector(".chat-container")?.classList.remove("center-input");
    smartScroll(true);
    toggleEmptyState();
    input.value = "";
    clearPendingFiles();
    updateSendState();

   showTypingIndicator();
   await new Promise(r => setTimeout(r, 300));   // <-- ADD THIS

  let res;
  setSendStopState(true);
  try {
    activeResponseController = new AbortController();
    if (hasFiles) {
        const formData = new FormData();
        formData.append("message", msg);
        formData.append("conversation_id", activeSession);
        filesToSend.forEach(file => formData.append("files", file));
        res = await fetch("/chat", {
            method: "POST",
            body: formData,
            signal: activeResponseController.signal
        });
    } else {
        res = await fetch("/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: msg,
                conversation_id: activeSession
            }),
            signal: activeResponseController.signal
        });
    }

    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if(contentType.includes("application/json")){
        const data = await res.json();
        removeTypingIndicator();
        const aiBubble = await streamAIResponse(data.reply || "");
        if(!stopTyping && data.download_url && aiBubble){
            attachDownloadLinkToAIBubble(aiBubble, data.download_url);
        }
    } else {
        await streamAIResponseFromServer(res);
    }
    toggleEmptyState();
  } catch (err) {
    if(err?.name !== "AbortError"){
        console.error(err);
        removeTypingIndicator();
    }
  } finally {
    activeResponseController = null;
    stopTyping = false;
    setSendStopState(false);
  }
}

function smartScroll(force=false){
    if(userAtBottom || force){
        requestAnimationFrame(()=>{
            chatBox.scrollTop = chatBox.scrollHeight;
        });
    }
}
/* ================= STORE MESSAGE ================= */
async function streamAIResponse(text){
    text = normalizeTypingText(text);


    const chatBox = document.getElementById("chat-box");
    let msgDiv = removeTypingIndicator();

    if(!msgDiv){
        const row = document.createElement("div");
        row.className = "msg-row ai-row";

        msgDiv = document.createElement("div");
        msgDiv.className = "ai";

        row.appendChild(msgDiv);
        chatBox.appendChild(row);
    }

    const renderer = createIncrementalStreamRenderer(msgDiv);
    const parts = text.match(/\S+\s*|\s+/g) || [];
    let i = 0;

    while(i < parts.length){
        if(stopTyping) break;
        const part = parts[i];
        renderer.process(part,false);
        i++;

        const trimmed = part.trim();
        const speed =
            /[.!?]$/.test(trimmed) ? 80 :
            /[,;:]$/.test(trimmed) ? 52 :
            /\n/.test(part) ? 34 :
            22;

        await new Promise(r=>setTimeout(r,speed));
    }

    renderer.process("",true);
    renderer.finish();
    const finalText = sanitizeStructuredAnswer(text);
    if(shouldRenderMarkdownTable(finalText) && containsMarkdownTable(finalText)){
        renderFinalComparisonMessage(msgDiv, finalText);
    } else if(needsRichFinalRender(finalText)){
        msgDiv.innerHTML = renderStreamFormattedHTML(finalText);
        enhanceCodeBlocks(msgDiv);
        applyPremiumLinkStyles(msgDiv);
        enforceHeadingOnlyBold(msgDiv);
    }

    // Constrain all normal AI images (exclude full attachment images)
    msgDiv.querySelectorAll("img:not(.attachment-image-full)").forEach(img => {
        img.style.maxWidth = "220px";
        img.style.maxHeight = "220px";
        img.style.width = "auto";
        img.style.height = "auto";
        img.style.objectFit = "contain";
    });

    msgDiv.removeAttribute("id");

    if(stopTyping && !msgDiv.textContent.trim()){
        msgDiv.remove();
        return null;
    }

    addCopyButton(msgDiv);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            addCopyButton(msgDiv);
        });
    });

    // Save the original AI markdown so summaries, references, links and tables
    // remain intact when the session reloads.
    if(finalText && finalText.trim()){
        saveMessage("ai", finalText);
    }

    return msgDiv;
}
function updateCodeLineNumbers(codeBlock){
    if(!codeBlock) return;

    const code = codeBlock.querySelector("code");
    const gutter = codeBlock.querySelector(".code-line-numbers");

    if(!code || !gutter) return;

    // Read raw code exactly as rendered
    let text = code.textContent || "";

    // Normalize line endings
    text = text.replace(/\r/g, "");

    // Count lines safely
    const lines = text.split("\n");
    const lineCount = Math.max(1, lines.length);

    const nums = [];
    for(let i = 1; i <= lineCount; i++){
        nums.push(String(i));
    }

    gutter.textContent = nums.join("\n");

    // Immediate height sync (no queued stale timers).
    // This avoids old async updates clipping the last line numbers.
    gutter.style.height = "auto";
    gutter.style.height = code.scrollHeight + "px";
}

function applyHighlightToCodeBlock(codeBlock){
    if(!codeBlock) return;
    const code = codeBlock.querySelector("code");
    if(!code) return;
    if(!(window.hljs && typeof window.hljs.highlight === "function")) return;
    
    // Skip highlighting if code block is still streaming
    if(codeBlock.dataset.isStreaming === "true") return;
    
    try{
        const source = code.textContent || "";
        if(!source.trim()){
            updateCodeLineNumbers(codeBlock);
            return;
        }
        const langClass = Array.from(code.classList).find(c => c.startsWith("language-"));
        const lang = langClass ? langClass.replace("language-", "") : "";
        let highlighted;
        if(lang && typeof window.hljs.getLanguage === "function" && window.hljs.getLanguage(lang)){
            highlighted = window.hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
        } else if(typeof window.hljs.highlightAuto === "function"){
            highlighted = window.hljs.highlightAuto(source).value;
        } else {
            highlighted = source;
        }
        code.innerHTML = highlighted;
        code.classList.add("hljs");
        updateCodeLineNumbers(codeBlock);
    } catch {}
}

function scheduleCodeHighlight(codeBlock, immediate = false){
    if(!codeBlock) return;
    const key = "__hlTimer";
    if(codeBlock[key]){
        clearTimeout(codeBlock[key]);
        codeBlock[key] = null;
    }
    if(immediate){
        applyHighlightToCodeBlock(codeBlock);
        return;
    }
    codeBlock[key] = setTimeout(() => {
        codeBlock[key] = null;
        applyHighlightToCodeBlock(codeBlock);
    }, 800);
}

function setCodeBlockLanguage(codeBlock, langToken){
    if(!codeBlock) return;
    const token = normalizeCodeLangToken(langToken);
    const code = codeBlock.querySelector("code");
    const label = codeBlock.querySelector(".code-lang");
    if(label) label.textContent = toCodeLangLabel(token);
    if(code){
        code.className = "";
        if(token){
            code.classList.add(`language-${token}`);
        }
    }
}

function createCodeBlock(code, lang = ""){
    const token = normalizeCodeLangToken(lang);
    const langLabel = toCodeLangLabel(token);
    const languageClass = token ? ` class="language-${token}"` : "";
    const normalizedCode = String(code || "").replace(/<br\s*\/?>/gi, "\n");
    return `
    <div class="code-block">
        <div class="code-head">
            <div class="code-dots"><span></span><span></span><span></span></div>
            <div class="code-lang">${langLabel}</div>
            <button class="copy-btn" onclick="copyCode(this)">Copy</button>
        </div>
        <pre><span class="code-line-numbers"></span><code${languageClass}>${normalizedCode
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
        }</code></pre>
    </div>`;
}
function scrubMarkdownArtifactsInNode(root){
    if(!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node = walker.nextNode();
    while(node){
        textNodes.push(node);
        node = walker.nextNode();
    }
    textNodes.forEach((textNode) => {
        const parentEl = textNode.parentElement;
        if(parentEl && parentEl.closest("pre, code, .code-block")) return;
        const cleaned = stripStreamingArtifacts(textNode.nodeValue || "");
        if(cleaned !== textNode.nodeValue){
            textNode.nodeValue = cleaned;
        }
    });
}


function createStreamCodeBlock(code, lang = ""){
    const token = normalizeCodeLangToken(lang);
    const langLabel = toCodeLangLabel(token);
    const languageClass = token ? ` class="language-${token}"` : "";
    const trimmedCode = String(code || "").replace(/<br\s*\/?>/gi, "\n").trimStart();
    return `<div class="code-block"><div class="code-head"><div class="code-dots"><span></span><span></span><span></span></div><div class="code-lang">${langLabel}</div><button class="copy-btn" onclick="copyCode(this)">Copy</button></div><pre><span class="code-line-numbers"></span><code${languageClass}>${trimmedCode.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre></div>`;
}

function renderStreamFormattedHTML(raw){
    const text = sanitizeStructuredAnswer(String(raw || "").replace(/<br\s*\/?>/gi, "\n"));
    const hasStructuredMarkdown =
        containsMarkdownTable(text) ||
        /!\[[^\]]*\]\([^)]+\)/.test(text) ||
        /\[[^\]]+\]\([^)]+\)/.test(text) ||
        /(^|\n)\s*(?:[-*]\s+|\d+\.\s+)/.test(text) ||
        /(^|\n)#{1,6}\s+/.test(text) ||
        /(^|\n)[^\n|]+\n={3,}\s*(\n|$)/.test(text) ||
        /(^|\n)\s*(-{3,}|\*{3,}|_{3,})\s*(\n|$)/.test(text);
    if(
        typeof marked !== "undefined" &&
        !text.includes("```") &&
        (
            (shouldRenderMarkdownTable(text) && containsMarkdownTable(text)) ||
            hasStructuredMarkdown
        )
    ){
        const markdownSource = containsMarkdownTable(text)
            ? normalizeMarkdownTableIndentation(text)
            : text;
        return marked.parse(markdownSource, {
            gfm: true,
            breaks: false
        });
    }
    let idx = 0;
    let html = "";
    const allowTables = shouldRenderMarkdownTable(text);
    const findTableBounds = (source, start) => {
        const after = source.slice(start);
        const lines = after.split("\n");
        const splitCells = (line) =>
            String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim()).filter(Boolean);
        const isRow = (line) => splitCells(line).length >= 2;
        const isSeparator = (line) => {
            const cells = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
            return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
        };

        let offset = 0;
        for(let i = 0; i < lines.length - 1; i++){
            const current = lines[i];
            const next = lines[i + 1];
            if(!current.trim()){
                offset += current.length + 1;
                continue;
            }
            if(!isRow(current) || !isSeparator(next)){
                offset += current.length + 1;
                continue;
            }

            let endOffset = offset + current.length + 1 + next.length;
            let block = `${current}\n${next}`;
            for(let j = i + 2; j < lines.length; j++){
                const candidate = lines[j];
                if(!candidate.trim()) break;
                if(!isRow(candidate)) break;
                block += `\n${candidate}`;
                endOffset += 1 + candidate.length;
            }

            return {
                start: start + offset,
                end: start + endOffset,
                text: block
            };
        }

        return null;
    };

    while(idx < text.length){
        const open = text.indexOf("```", idx);
        const table = allowTables ? findTableBounds(text, idx) : null;
        const nextBoundary = [
            open === -1 ? text.length : open,
            table ? table.start : text.length
        ].sort((a, b) => a - b)[0];

        if(nextBoundary > idx){
            html += renderRichText(normalizeTextBlock(text.slice(idx, nextBoundary)));
            idx = nextBoundary;
            continue;
        }

        if(table && table.start === idx){
            html += buildMarkdownTableHTML(table.text, true) || renderRichText(table.text);
            idx = table.end;
            continue;
        }

        if(open === -1){
            html += renderRichText(normalizeTextBlock(text.slice(idx)));
            break;
        }

        let codeStart = open + 3;
        let langToken = "";
        if(text[codeStart] === "\n"){
            codeStart += 1;
        } else {
            const nl = text.indexOf("\n", codeStart);
            if(nl !== -1){
                const maybeLang = text.slice(codeStart, nl).trim();
                if(/^[A-Za-z0-9_+.-]{1,24}$/.test(maybeLang)){
                    langToken = maybeLang;
                    codeStart = nl + 1;
                }
            }
        }

        const close = text.indexOf("```", codeStart);
        if(close === -1){
            html += createStreamCodeBlock(text.slice(codeStart), langToken);
            idx = text.length;
        } else {
            html += createStreamCodeBlock(text.slice(codeStart, close), langToken);
            idx = close + 3;
        }
    }

    return html;
}

function splitMarkdownTableSections(text){
    const normalized = normalizeMarkdownTableIndentation(String(text || "").replace(/\r/g, ""));
    const lines = normalized.split("\n");

    const splitCells = (line) =>
        String(line || "")
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map(cell => cell.trim())
            .filter(Boolean);

    const isRow = (line) => splitCells(line).length >= 2;
    const isSeparator = (line) => {
        const cells = String(line || "")
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map(cell => cell.trim());
        return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
    };

    let tableStart = -1;
    for(let i = 0; i < lines.length - 1; i++){
        if(isRow(lines[i]) && isSeparator(lines[i + 1])){
            tableStart = i;
            break;
        }
    }

    if(tableStart === -1){
        return {
            introText: normalized,
            tableText: "",
            tailText: ""
        };
    }

    let tableEnd = Math.min(lines.length, tableStart + 2);
    while(tableEnd < lines.length){
        const current = lines[tableEnd];
        if(!current.trim()){
            break;
        }
        if(!isRow(current)){
            break;
        }
        tableEnd += 1;
    }

    return {
        introText: lines.slice(0, tableStart).join("\n").trim(),
        tableText: lines.slice(tableStart, tableEnd).join("\n").trim(),
        tailText: lines.slice(tableEnd).join("\n").trim()
    };
}

function renderFinalComparisonMessage(msgDiv, rawText){
    const parsed = splitMarkdownTableSections(rawText);
    msgDiv.innerHTML = "";

    if(parsed.introText){
        const intro = document.createElement("div");
        intro.innerHTML = renderStreamFormattedHTML(parsed.introText);
        msgDiv.appendChild(intro);
    }

    if(parsed.tableText){
        const tableWrap = document.createElement("div");
        tableWrap.innerHTML =
            buildMarkdownTableHTML(parsed.tableText, true) ||
            renderStreamFormattedHTML(parsed.tableText);
        msgDiv.appendChild(tableWrap);
    }

    if(parsed.tailText){
        const tail = document.createElement("div");
        tail.innerHTML = renderStreamFormattedHTML(parsed.tailText);
        msgDiv.appendChild(tail);
    }

    enhanceCodeBlocks(msgDiv);
    applyPremiumLinkStyles(msgDiv);
    enforceHeadingOnlyBold(msgDiv);
}

function parseInlineStreamSegments(text){
    const cleaned = sanitizeStructuredAnswer(String(text || ""))
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*\*/g, "")
        .replace(/^#{3,}\s*/gm, "")
        .replace(/^\s*[-*]\s+/gm, "• ");

    const segments = [];
    const pushText = (value) => {
        if(!value) return;
        const last = segments[segments.length - 1];
        if(last && last.type === "text"){
            last.text += value;
        } else {
            segments.push({ type: "text", text: value });
        }
    };

    let i = 0;
    while(i < cleaned.length){
        const mdMatch = cleaned.slice(i).match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/);
        if(mdMatch){
            segments.push({
                type: "link",
                text: mdMatch[1],
                href: mdMatch[2]
            });
            i += mdMatch[0].length;
            continue;
        }

        const bareMatch = cleaned.slice(i).match(/^(https?:\/\/[^\s<]+|\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)/);
        if(bareMatch){
            const href = bareMatch[1];
            segments.push({
                type: "link",
                text: href,
                href
            });
            i += href.length;
            continue;
        }

        pushText(cleaned[i]);
        i += 1;
    }

    return segments;
}

function syncInlineStreamSegments(container, segments){
    const existing = Array.from(container.childNodes);

    const ensureNode = (segment, index) => {
        const current = existing[index];

        if(segment.type === "text"){
            if(current && current.nodeType === Node.TEXT_NODE){
                if(current.nodeValue !== segment.text){
                    current.nodeValue = segment.text;
                }
                return current;
            }
            const node = document.createTextNode(segment.text);
            if(current){
                container.replaceChild(node, current);
            } else {
                container.appendChild(node);
            }
            return node;
        }

        if(
            current &&
            current.nodeType === Node.ELEMENT_NODE &&
            current.dataset.streamKind === "link"
        ){
            if(current.getAttribute("href") !== segment.href){
                current.setAttribute("href", segment.href);
            }
            if(current.textContent !== segment.text){
                current.textContent = segment.text;
            }
            return current;
        }

        const link = document.createElement("a");
        link.className = "ai-inline-link";
        link.dataset.streamKind = "link";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.href = segment.href;
        link.textContent = segment.text;

        if(current){
            container.replaceChild(link, current);
        } else {
            container.appendChild(link);
        }
        return link;
    };

    segments.forEach((segment, index) => {
        ensureNode(segment, index);
    });

    while(container.childNodes.length > segments.length){
        container.removeChild(container.lastChild);
    }
}

function createPlainTextStreamRenderer(msgDiv){
    msgDiv.style.display = "block";
    msgDiv.classList.add("ai-streaming");
    msgDiv.innerHTML = "";

    const live = document.createElement("div");
    live.className = "ai-stream-live";
    msgDiv.appendChild(live);

    let sourceBuffer = "";
    let visibleBuffer = "";
    let streamDone = false;
    let frameId = 0;
    let timerId = 0;

    const takeNextSlice = () => {
        const remaining = sourceBuffer.slice(visibleBuffer.length);
        if(!remaining) return "";
        if(/^\s+/.test(remaining)){
            const spaces = remaining.match(/^\s+/);
            return spaces ? spaces[0] : "";
        }
        const wholeToken = remaining.match(/^\S+\s*/);
        if(wholeToken && wholeToken[0].length <= 18){
            return wholeToken[0];
        }
        return remaining.slice(0, 8);
    };

    const renderVisibleBuffer = () => {
        frameId = 0;
        syncInlineStreamSegments(live, parseInlineStreamSegments(visibleBuffer));
        smartScroll(true);
    };

    const schedulePaint = () => {
        if(frameId) return;
        frameId = requestAnimationFrame(renderVisibleBuffer);
    };

    const tick = () => {
        timerId = 0;
        if(stopTyping) return;

        const slice = takeNextSlice();
        if(slice){
            visibleBuffer += slice;
            schedulePaint();
        }

        if(visibleBuffer.length < sourceBuffer.length){
            timerId = window.setTimeout(tick, 26);
            return;
        }

        if(!streamDone){
            timerId = window.setTimeout(tick, 26);
        }
    };

    const ensureTicker = () => {
        if(timerId) return;
        timerId = window.setTimeout(tick, 0);
    };

    const process = (chunk, flush = false) => {
        if(chunk){
            sourceBuffer += chunk;
            ensureTicker();
        }
        if(!flush) return;

        streamDone = true;
        visibleBuffer = sourceBuffer;
        if(timerId){
            clearTimeout(timerId);
            timerId = 0;
        }
        if(frameId){
            cancelAnimationFrame(frameId);
            frameId = 0;
        }
        renderVisibleBuffer();
    };

    const finish = () => {
        msgDiv.classList.remove("ai-streaming");
    };

    return { process, finish };
}

function createComparisonStreamRenderer(msgDiv){
    msgDiv.style.display = "block";
    msgDiv.classList.add("ai-streaming");
    msgDiv.innerHTML = "";

    const intro = document.createElement("div");
    const tableWrap = document.createElement("div");
    const tail = document.createElement("div");

    let sourceBuffer = "";
    let visibleBuffer = "";
    let streamDone = false;
    let frameId = 0;
    let timerId = 0;
    let lastIntroHTML = "";
    let lastTableHTML = "";
    let lastTailHTML = "";

    const syncSection = (node, html, previousHTML) => {
        const normalized = String(html || "").trim();
        if(!normalized){
            if(node.parentNode === msgDiv){
                msgDiv.removeChild(node);
            }
            return "";
        }

        if(node.parentNode !== msgDiv){
            msgDiv.appendChild(node);
        }

        if(previousHTML !== normalized){
            node.innerHTML = normalized;
        }
        return normalized;
    };

    const takeNextSlice = () => {
        const remaining = sourceBuffer.slice(visibleBuffer.length);
        if(!remaining) return "";
        if(/^\s+/.test(remaining)){
            const spaces = remaining.match(/^\s+/);
            return spaces ? spaces[0] : "";
        }
        const wholeToken = remaining.match(/^\S+\s*/);
        if(wholeToken && wholeToken[0].length <= 18){
            return wholeToken[0];
        }
        return remaining.slice(0, 8);
    };

    const renderVisibleBuffer = () => {
        frameId = 0;
        const parsed = splitMarkdownTableSections(visibleBuffer);
        const introHTML = parsed.introText
            ? renderStreamFormattedHTML(parsed.introText)
            : "";
        const tableHTML = parsed.tableText
            ? (buildMarkdownTableHTML(parsed.tableText, true) || "")
            : "";
        const tailHTML = parsed.tailText
            ? renderStreamFormattedHTML(parsed.tailText)
            : "";

        lastIntroHTML = syncSection(intro, introHTML, lastIntroHTML);
        lastTableHTML = syncSection(tableWrap, tableHTML, lastTableHTML);
        lastTailHTML = syncSection(tail, tailHTML, lastTailHTML);

        const desiredOrder = [intro, tableWrap, tail].filter(node => node.parentNode === msgDiv);
        desiredOrder.forEach((node, index) => {
            if(msgDiv.children[index] !== node){
                msgDiv.insertBefore(node, msgDiv.children[index] || null);
            }
        });

        enhanceCodeBlocks(msgDiv);
        applyPremiumLinkStyles(msgDiv);
        enforceHeadingOnlyBold(msgDiv);

        smartScroll(true);
    };

    const schedulePaint = () => {
        if(frameId) return;
        frameId = requestAnimationFrame(renderVisibleBuffer);
    };

    const tick = () => {
        timerId = 0;
        if(stopTyping) return;

        const slice = takeNextSlice();
        if(slice){
            visibleBuffer += slice;
            schedulePaint();
        }

        if(visibleBuffer.length < sourceBuffer.length){
            timerId = window.setTimeout(tick, 26);
            return;
        }

        if(!streamDone){
            timerId = window.setTimeout(tick, 26);
        }
    };

    const ensureTicker = () => {
        if(timerId) return;
        timerId = window.setTimeout(tick, 0);
    };

    const process = (chunk, flush = false) => {
        if(chunk){
            sourceBuffer += chunk;
            ensureTicker();
        }
        if(!flush) return;

        streamDone = true;
        visibleBuffer = sourceBuffer;
        if(timerId){
            clearTimeout(timerId);
            timerId = 0;
        }
        if(frameId){
            cancelAnimationFrame(frameId);
            frameId = 0;
        }
        renderVisibleBuffer();
    };

    const finish = () => {
        msgDiv.classList.remove("ai-streaming");
    };

    return { process, finish };
}

function createIncrementalStreamRenderer(msgDiv){
    if(shouldRenderMarkdownTable("")){
        return createComparisonStreamRenderer(msgDiv);
    }
    return createPlainTextStreamRenderer(msgDiv);
}

async function streamAIResponseFromServer(res){
    const chatBox = document.getElementById("chat-box");
    let msgDiv = removeTypingIndicator();
    if(!msgDiv){
        const row = document.createElement("div");
        row.className = "msg-row ai-row";

        msgDiv = document.createElement("div");
        msgDiv.className = "ai";

        row.appendChild(msgDiv);
        chatBox.appendChild(row);
    }

    let fullText = "";
    const reader = res.body?.getReader();
    const decoder = new TextDecoder("utf-8");

    if(!reader){
        const fallback = await res.text();
        fullText = fallback || "";
        if(shouldRenderMarkdownTable(fullText) && containsMarkdownTable(fullText)){
            renderFinalComparisonMessage(msgDiv, fullText);
        } else {
            msgDiv.innerHTML = renderStreamFormattedHTML(fullText);
            enhanceCodeBlocks(msgDiv);
            applyPremiumLinkStyles(msgDiv);
            enforceHeadingOnlyBold(msgDiv);
        }
        msgDiv.querySelectorAll("img").forEach(img=>{
         img.style.maxWidth="220px";
         img.style.maxHeight="220px";
          img.style.objectFit="contain";
        });
        if(fullText.trim()){
            addCopyButton(msgDiv);
            saveMessage("ai", fullText);
            return msgDiv;
        }
        msgDiv.remove();
        return null;
    }

    const live = createIncrementalStreamRenderer(msgDiv);

    try{
        while(true){
            if(stopTyping){
                try { await reader.cancel(); } catch {}
                break;
            }
            const { value, done } = await reader.read();
            if(done) break;
            const chunk = decoder.decode(value, { stream: true });
            if(!chunk) continue;
            fullText += chunk;
            live.process(chunk, false);
        }
        const tail = decoder.decode();
        if(tail){
            fullText += tail;
            live.process(tail, false);
        }
        live.process("", true);
        live.finish();
    } catch (err){
        if(err?.name !== "AbortError"){
            console.error(err);
        }
    }

    msgDiv.removeAttribute("id");
    if(!fullText.trim()){
        msgDiv.remove();
        return null;
    }

    const finalText = sanitizeStructuredAnswer(fullText);
    if(shouldRenderMarkdownTable(finalText) && containsMarkdownTable(finalText)){
        renderFinalComparisonMessage(msgDiv, finalText);
    } else if(needsRichFinalRender(finalText)){
        msgDiv.innerHTML = renderStreamFormattedHTML(finalText);
        enhanceCodeBlocks(msgDiv);
        applyPremiumLinkStyles(msgDiv);
        enforceHeadingOnlyBold(msgDiv);
    }

    msgDiv.querySelectorAll("img:not(.attachment-image-full)").forEach(img => {
        img.style.maxWidth = "220px";
        img.style.maxHeight = "220px";
        img.style.width = "auto";
        img.style.height = "auto";
        img.style.objectFit = "contain";
    });

    addCopyButton(msgDiv);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            addCopyButton(msgDiv);
        });
    });
    saveMessage("ai", finalText);
    return msgDiv;
}

function removeStopButton(){
    setSendStopState(false);
}
