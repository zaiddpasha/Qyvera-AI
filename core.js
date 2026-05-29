const ALLOWED_FILE_TYPES = new Set([
    "application/pdf",
    "image/png",
    "image/jpg",
    "image/jpeg",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain"
]);
const ALLOWED_FILE_EXT = new Set(["pdf", "png", "jpg", "jpeg", "doc", "docx", "txt"]);
const MAX_CHAT_TITLE_LEN = 46;
const CHAT_SCROLL_STORAGE_KEY = "chat_scroll_top";
const CHAT_SCROLL_BOTTOM_SENTINEL = "BOTTOM";
const CHAT_SCROLL_BOTTOM_THRESHOLD = 80;

function getChatScrollBox(){
    return document.getElementById("chat-box");
}

function getChatScrollDistanceFromBottom(chatBoxEl = getChatScrollBox()){
    if(!chatBoxEl) return null;
    return chatBoxEl.scrollHeight - chatBoxEl.scrollTop - chatBoxEl.clientHeight;
}

function isChatScrolledNearBottom(chatBoxEl = getChatScrollBox(), threshold = CHAT_SCROLL_BOTTOM_THRESHOLD){
    const distanceFromBottom = getChatScrollDistanceFromBottom(chatBoxEl);
    if(distanceFromBottom === null) return true;
    return distanceFromBottom < threshold;
}

function readSavedChatScrollPosition(){
    try{
        return sessionStorage.getItem(CHAT_SCROLL_STORAGE_KEY);
    } catch {
        return null;
    }
}

function writeSavedChatScrollPosition(value){
    try{
        sessionStorage.setItem(CHAT_SCROLL_STORAGE_KEY, value);
    } catch {}
}

function computeChatScrollSnapshot(chatBoxEl = getChatScrollBox()){
    if(!chatBoxEl) return null;
    return isChatScrolledNearBottom(chatBoxEl)
        ? CHAT_SCROLL_BOTTOM_SENTINEL
        : String(chatBoxEl.scrollTop);
}

function saveChatScrollPositionValue(chatBoxEl = getChatScrollBox()){
    const snapshot = computeChatScrollSnapshot(chatBoxEl);
    if(snapshot === null) return null;
    writeSavedChatScrollPosition(snapshot);
    return snapshot;
}

function applySavedChatScrollPosition(chatBoxEl = getChatScrollBox(), saved = readSavedChatScrollPosition()){
    if(!chatBoxEl) return false;
    if(saved === CHAT_SCROLL_BOTTOM_SENTINEL || saved === null){
        chatBoxEl.scrollTop = chatBoxEl.scrollHeight;
        return true;
    }
    const pos = parseInt(saved, 10);
    chatBoxEl.scrollTop = Number.isNaN(pos) ? chatBoxEl.scrollHeight : pos;
    return true;
}

function containsMarkdownTable(text){
    const lines = normalizeMarkdownTableIndentation(text).split("\n");
    const isRow = (line) => {
        const trimmed = String(line || "").trim();
        if(!trimmed.includes("|")) return false;
        const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim()).filter(Boolean);
        return cells.length >= 2;
    };
    const isSeparator = (line) => {
        const trimmed = String(line || "").trim();
        if(!trimmed.includes("|")) return false;
        const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
        if(cells.length < 2) return false;
        return cells.every(cell => /^:?-{3,}:?$/.test(cell));
    };

    for(let i = 0; i < lines.length - 1; i++){
        if(isRow(lines[i]) && isSeparator(lines[i + 1])){
            return true;
        }
    }
    return false;
}

function shouldRenderMarkdownTable(text){
    const hasComparisonPrompt = (() => {
        try{
            const store = globalThis.sessionMessages;
            const sessionId = globalThis.activeSession;
            const messages = store && sessionId ? store[sessionId] : null;
            const lastUserText = Array.isArray(messages)
                ? [...messages].reverse().find(msg => msg && msg.sender === "user" && msg.text)?.text || ""
                : "";
            return /\b(compare|comparison|difference|different|differentiate|diff|vs|versus|between)\b/i.test(String(lastUserText || ""));
        } catch {
            return false;
        }
    })();

    if(!text){
        return hasComparisonPrompt;
    }

    return containsMarkdownTable(text);
}

function normalizeMarkdownTableIndentation(text){
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const out = [];

    const splitTableCells = (line) =>
        String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());

    const joinTableCells = (cells) => `| ${cells.join(" | ")} |`;
    const isSeparatorLikeTableLine = (line) => {
        const trimmed = String(line || "").trim();
        if(!trimmed.includes("|")) return false;
        return /^[\s|:\-]+$/.test(trimmed);
    };
    const buildSeparatorLine = (count) => joinTableCells(Array.from({ length: count }, () => "---"));

    const normalizeTableLine = (line) => {
        let trimmed = line.trim();
        if(!trimmed) return "";
        if(!trimmed.includes("|")) return trimmed;
        if(!trimmed.startsWith("|")) trimmed = `| ${trimmed}`;
        if(!trimmed.endsWith("|")) trimmed = `${trimmed} |`;
        return trimmed.replace(/\s*\|\s*/g, " | ").replace(/^\|\s*/, "| ").replace(/\s*\|$/, " |");
    };

    for(let i = 0; i < lines.length; i++){
        const current = lines[i];
        const next = lines[i + 1];
        const currentTrimmed = current.trim();
        const nextTrimmed = String(next || "").trim();
        const headerCellsForStart = splitTableCells(currentTrimmed).filter(Boolean);
        const startsTable =
            headerCellsForStart.length >= 2 &&
            currentTrimmed.includes("|") &&
            isSeparatorLikeTableLine(nextTrimmed);

        if(!startsTable){
            out.push(current);
            continue;
        }

        let headerLine = normalizeTableLine(current);
        const headerCells = splitTableCells(headerLine);
        if(headerCells.length >= 2 && !headerCells[0]){
            headerCells[0] = "Feature";
            headerLine = joinTableCells(headerCells);
        }

        out.push(headerLine);
        out.push(buildSeparatorLine(headerCells.length));
        i += 1;

        while(i + 1 < lines.length && isSeparatorLikeTableLine(lines[i + 1].trim())){
            i += 1;
        }

        while(i + 1 < lines.length){
            const candidate = lines[i + 1].trim();
            if(!candidate){
                i += 1;
                continue;
            }
            if(!candidate.includes("|")) break;
            out.push(normalizeTableLine(lines[i + 1]));
            i += 1;
        }
    }

    return out.join("\n");
}

function buildMarkdownTableHTML(tableText, includePartialLastLine = true){
    const normalized = normalizeMarkdownTableIndentation(tableText);
    let lines = normalized.split("\n").filter((line, index, all) => {
        if(index === all.length - 1 && !includePartialLastLine && !normalized.endsWith("\n") && !line.trim()){
            return false;
        }
        return true;
    });

    if(!includePartialLastLine && !normalized.endsWith("\n") && lines.length){
        lines = lines.slice(0, -1);
    }

    lines = lines.filter(line => line.trim());
    if(lines.length < 2) return "";

    const splitCells = (line) =>
        String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());

    const headerCells = splitCells(lines[0]);
    if(headerCells.length < 2) return "";

    let html = "<table><thead><tr>";
    headerCells.forEach(cell => {
        html += `<th>${renderRichText(normalizeTextBlock(cell)).replace(/<br\s*\/?>/gi, " ")}</th>`;
    });
    html += "</tr></thead><tbody>";

    for(let i = 2; i < lines.length; i++){
        const rowCells = splitCells(lines[i]);
        if(rowCells.length < 2) continue;
        html += "<tr>";
        rowCells.forEach(cell => {
            html += `<td>${renderRichText(normalizeTextBlock(cell)).replace(/<br\s*\/?>/gi, " ")}</td>`;
        });
        html += "</tr>";
    }

    html += "</tbody></table>";
    return html;
}

function stabilizeChatScrollRestore(chatBoxEl = getChatScrollBox(), options = {}){
    if(!chatBoxEl) return;

    const saved = options.saved ?? readSavedChatScrollPosition();
    const frames = options.frames ?? 32;
    const prevBehavior = chatBoxEl.style.scrollBehavior;
    const prevOpacity = chatBoxEl.style.opacity;
    const prevPointerEvents = chatBoxEl.style.pointerEvents;

    restoringChatScroll = true;
    chatBoxEl.style.scrollBehavior = "auto";
    chatBoxEl.style.opacity = "0";
    chatBoxEl.style.pointerEvents = "none";

    const apply = () => applySavedChatScrollPosition(chatBoxEl, saved);

    let frameCount = 0;
    const tick = () => {
        apply();
        frameCount++;
        if(frameCount < frames){
            requestAnimationFrame(tick);
            return;
        }
        setTimeout(apply, 50);
        setTimeout(apply, 150);
        setTimeout(apply, 300);
        setTimeout(apply, 600);
        setTimeout(() => {
            chatBoxEl.style.scrollBehavior = prevBehavior || "";
            chatBoxEl.style.opacity = prevOpacity || "1";
            chatBoxEl.style.pointerEvents = prevPointerEvents || "";
            restoringChatScroll = false;
            options.onComplete?.();
        }, 650);
    };

    requestAnimationFrame(tick);
}
function buildChatTitleFromText(rawText){
    let text = String(rawText || "");
    // Strip any legacy attachment suffix that may exist in stored text.
    text = text.replace(/\bAttachments?:[\s\S]*$/i, " ");
    // Remove inline file names/extensions from title source.
    text = text.replace(/\b[^\s]+\.(pdf|png|jpe?g|gif|webp|docx?|xlsx?|pptx?|txt)\b/ig, " ");
    text = text.replace(/\s+/g, " ").trim();

    if(!text) return "New Chat";

    // ChatGPT-like short clean title.
    if(text.length > MAX_CHAT_TITLE_LEN){
        return text.slice(0, MAX_CHAT_TITLE_LEN).trimEnd() + "....";
    }
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function guessMimeFromName(fileName){
    const name = String(fileName || "").toLowerCase();
    if(name.endsWith(".pdf")) return "application/pdf";
    if(name.endsWith(".png")) return "image/png";
    if(name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
    if(name.endsWith(".doc")) return "application/msword";
    if(name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if(name.endsWith(".txt")) return "text/plain";
    return "application/octet-stream";
}

function normalizeMergeAttachments(attachments){
    if(!Array.isArray(attachments) || !attachments.length) return attachments || [];
    const out = [];
    attachments.forEach((item) => {
        if(!item) return;
        const name = String(item.name || "");
        const kind = String(item.kind || "");
        const isToolDownload = kind === "download" || /download (merged pdf|file)/i.test(name);
        if(isToolDownload && item.url){
            const hasView = out.some(a => a.kind === "view" && a.url === item.url);
            if(!hasView){
                out.push({
                    name: "View File",
                    url: item.url,
                    kind: "view"
                });
            }
            const hasDownload = out.some(a => a.kind === "download" && a.url === item.url);
            if(!hasDownload){
                out.push({
                    name: "Download File",
                    url: item.url,
                    kind: "download"
                });
            }
        } else {
            out.push(item);
        }
    });
    return out;
}

function fileIdentity(file){
    return `${file.name}|${file.size}|${file.lastModified}`;
}

function isSupportedFile(file){
    if(!file) return false;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    return ALLOWED_FILE_TYPES.has(file.type) || ALLOWED_FILE_EXT.has(ext);
}

function escapeHTML(char) {
    if (char === "\n") return "<br>";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return char;
}

function normalizeCodeLangToken(lang){
    return String(lang || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9#+.-]/g, "");
}

function toCodeLangLabel(lang){
    const token = normalizeCodeLangToken(lang);
    if(!token) return "CODE";
    const map = {
        js: "JavaScript",
        javascript: "JavaScript",
        ts: "TypeScript",
        typescript: "TypeScript",
        py: "Python",
        python: "Python",
        c: "C",
        cpp: "C++",
        "c++": "C++",
        cs: "C#",
        "c#": "C#",
        html: "HTML",
        css: "CSS",
        json: "JSON",
        bash: "Bash",
        sh: "Shell",
        shell: "Shell",
        java: "Java",
        go: "Go",
        rust: "Rust",
        php: "PHP",
        ruby: "Ruby",
        sql: "SQL",
        swift: "Swift",
        kotlin: "Kotlin"
    };
    return map[token] || token.toUpperCase();
}


function formatFinalHTML(text) {
    return renderStreamFormattedHTML(text);
}

function enforceHeadingOnlyBold(root){
    if(!root) return;
    root.querySelectorAll("strong, b").forEach((node) => {
        if(node.closest("h1, h2, h3, h4, h5, h6, th")) return;
        const parent = node.parentNode;
        if(!parent) return;
        while(node.firstChild){
            parent.insertBefore(node.firstChild, node);
        }
        parent.removeChild(node);
    });
}

function sanitizeStructuredAnswer(text){
    return String(text || "")
        .replace(/\r/g, "")
        .replace(/^\s*(\d+)\.\s*[-:]\s*$/gm, "")
        .replace(/(^|\n)(\d+)\.\.(?=\s*\S)/g, "$1$2. ")
        .replace(/(^|\n)\s*(\d+)\.\s*-\s*(?=\n\s*\2\.\s+)/g, "$1")
        .replace(/(^|\n)\s*(\d+)\.\s*(?=\n\s*\2\.\s+)/g, "$1")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function escapeStreamText(text){
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
}

function renderRichText(text){
    const escaped = String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Markdown image: ![alt](url) - supports absolute and relative URLs.
    let html = escaped.replace(
        /!\[([^\]]*)\]\s*\(\s*<?((?:https?:\/\/|\/)[^\s)>]+)>?\s*\)/g,
        (_, alt, url) => {
            const safeAlt = String(alt || "Image").replace(/"/g, "&quot;");
            const safeUrl = String(url || "").replace(/"/g, "&quot;");
            return `<span class="ai-image-item"><a class="ai-image-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer"><img class="ai-inline-image chat-image" src="${safeUrl}" alt="${safeAlt}" loading="lazy"></a></span>`;
        }
    );

    // Markdown link: [text](url) - supports absolute and relative URLs.
    html = html.replace(
        /\[([^\]]+)\]\s*\(\s*<?((?:https?:\/\/|\/)[^\s)>]+)>?\s*\)/g,
        (_, label, url) => {
            const safeLabel = String(label || url);
            const safeUrl = String(url || "").replace(/"/g, "&quot;");
            return `<a class="ai-inline-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
        }
    );

    // Bare URLs to clickable links (skip inside existing href/src attributes).
    html = html.replace(
        /(^|[\s>])(https?:\/\/[^\s<]+)/g,
        (m, prefix, url) => {
            if(/(href|src)=["']?$/.test(prefix)) return m;
            const safeUrl = String(url || "").replace(/"/g, "&quot;");
            return `${prefix}<a class="ai-inline-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${url}</a>`;
        }
    );

    return html.replace(/\n/g, "<br>");
}

function needsRichFinalRender(text){
    const normalized = sanitizeStructuredAnswer(String(text || "").replace(/<br\s*\/?>/gi, "\n"));
    if(!normalized) return false;
    return (
        normalized.includes("```") ||
        containsMarkdownTable(normalized) ||
        /!\[[^\]]*\]\([^)]+\)/.test(normalized) ||
        /\[[^\]]+\]\([^)]+\)/.test(normalized) ||
        /(^|\n)\s*(?:[-*]\s+|\d+\.\s+)/.test(normalized) ||
        /(^|\n)#{1,6}\s+/.test(normalized) ||
        /(^|\n)[^\n|]+\n={3,}\s*(\n|$)/.test(normalized) ||
        /(^|\n)\s*(-{3,}|\*{3,}|_{3,})\s*(\n|$)/.test(normalized)
    );
}

function normalizeTextBlock(text){
    return sanitizeStructuredAnswer(text)
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*\*/g, "")
        .replace(/^#{3,}\s*/gm, "")
        .replace(/(^|\n)\s*[-*]\s+/g, "$1• ");
}

function normalizeTypingText(text){
    return sanitizeStructuredAnswer(text)
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*\*/g, "")
        .replace(/^###\s*/gm, "")
        .replace(/(^|\n)\s*[-*]\s+/g, "$1• ");
}

function stripStreamingArtifacts(text){
    return sanitizeStructuredAnswer(text)
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*\*/g, "")
        .replace(/^#{3,}\s*/gm, "")
        .replace(/(^|\n)\s*[-*]\s+/g, "$1• ");
}

function sanitizeStreamingNormalText(text){
    return sanitizeStructuredAnswer(text)
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*\*/g, "")
        .replace(/^#{3,}\s*/gm, "")
        .replace(/^\s*[-*]\s+/gm, "• ");
}
