var pendingFiles = [];
var activePreviewBlobUrl = null;
var activePreviewImageZoom = 1;
var activePreviewIsImage = false;

function isImageAttachment(fileName = "", mime = "", kind = "file"){
    if(kind === "download" || kind === "view") return false;
    const ext = (String(fileName).split(".").pop() || "").toLowerCase();
    const imageExt = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
    return String(mime || "").startsWith("image/") || imageExt.has(ext);
}

function attachDownloadLinkToAIBubble(msgDiv, downloadUrl){
    if(!msgDiv || !downloadUrl) return;
    const mergeActions = [
        {
            name: "View File",
            url: downloadUrl,
            kind: "view"
        },
        {
            name: "Download File",
            url: downloadUrl,
            kind: "download"
        }
    ];
    appendAttachmentsToBubble(msgDiv, mergeActions);

    // Mark the copy button as having attachments for tighter spacing
    const copyBtn = msgDiv.parentNode.querySelector('.msg-actions-outside');
    if(copyBtn){
        copyBtn.classList.add("has-attachments");
    }

    const current = sessionMessages[activeSession];
    if(Array.isArray(current) && current.length){
        const last = current[current.length - 1];
        if(last && last.sender === "ai"){
            if(!Array.isArray(last.attachments)) last.attachments = [];
            mergeActions.forEach((action) => {
                const exists = last.attachments.some(a => a.url === action.url && a.kind === action.kind);
                if(!exists) last.attachments.push(action);
            });
            saveToStorage();
        }
    }
    smartScroll(true);
}

function getAttachmentVisualMeta(fileName = "", kind = "file"){
    if(kind === "download"){
        return { icon: "⬇", label: "DOWNLOAD" };
    }
    if(kind === "view"){
        return { icon: "👁", label: "PREVIEW" };
    }

    const ext = (String(fileName).split(".").pop() || "").toLowerCase();
    if(ext === "pdf") return { icon: "📄", label: "PDF" };
    if(ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") return { icon: "🖼", label: ext.toUpperCase() };
    if(ext === "doc" || ext === "docx") return { icon: "📝", label: ext.toUpperCase() };
    if(ext === "txt") return { icon: "📃", label: "TXT" };
    return { icon: "📎", label: ext ? ext.toUpperCase() : "FILE" };
}

function buildAttachmentCard(linkEl, file){
    const kind = file?.kind || "file";
    const fileName = file?.name || "Attachment";
    const fileMime = file?.mime || file?.type || "";
    const imageLike = isImageAttachment(fileName, fileMime, kind);
    const meta = getAttachmentVisualMeta(file?.name || "", kind);

    linkEl.textContent = "";

    if(imageLike && file?.url){
        const img = document.createElement("img");
        img.className = "attachment-image-full";
        img.src = file.url;
        img.alt = "image";
        img.loading = "lazy";
        img.style.maxWidth = "220px";
        img.style.maxHeight = "220px";
        img.style.width = "auto";
        img.style.height = "auto";
        img.style.objectFit = "contain";
        img.style.display = "block";
        img.style.borderRadius = "8px";

        // remove card look
        linkEl.className = "attachment-image-free";
        linkEl.style.display = "inline-block";
        linkEl.style.background = "transparent";
        linkEl.style.padding = "0";
        linkEl.style.border = "none";

        linkEl.appendChild(img);

        // Open image in internal preview modal (ChatGPT-style) instead of new tab
        linkEl.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openFilePreviewFromUrl(file.url, file.name || "Image");
        });

        // Prevent browser default navigation
        linkEl.removeAttribute("target");
        linkEl.removeAttribute("rel");
        makeAttachmentDraggable(linkEl, file);
        return;
    }

    const icon = document.createElement("span");
    icon.className = "attachment-card-icon";
    icon.textContent = meta.icon;

    const metaWrap = document.createElement("span");
    metaWrap.className = "attachment-card-meta";

    const name = document.createElement("span");
    name.className = "attachment-card-name";
    name.textContent = file?.name || "Attachment";

    const type = document.createElement("span");
    type.className = "attachment-card-type";
    type.textContent = meta.label;

    metaWrap.appendChild(name);
    metaWrap.appendChild(type);
    linkEl.appendChild(icon);
    linkEl.appendChild(metaWrap);
}

function makeAttachmentDraggable(linkEl, file){
    if(!linkEl) return;
    linkEl.setAttribute("draggable", "true");
    linkEl.addEventListener("dragstart", (e) => {
        const url = linkEl.getAttribute("href") || file?.url || "";
        const name = file?.name || linkEl.dataset.fileName || "file";
        if(!url) return;
        e.dataTransfer?.setData("application/x-qyvera-file-url", url);
        e.dataTransfer?.setData("application/x-qyvera-file-name", name);
        e.dataTransfer?.setData("text/uri-list", url);
    });
}

function getFileNameFromUrl(url){
    try{
        const pathname = new URL(url, window.location.origin).pathname || "";
        const base = pathname.split("/").pop() || "";
        if(base.includes(".")) return decodeURIComponent(base);
    } catch {}
    return "";
}

async function fileFromDroppedUrl(url, preferredName = ""){
    if(!url) return null;
    let absoluteUrl = url;
    try{
        absoluteUrl = new URL(url, window.location.origin).toString();
    } catch {
        return null;
    }
    try{
        const res = await fetch(absoluteUrl, { method: "GET", credentials: "same-origin" });
        if(!res.ok) return null;
        const blob = await res.blob();
        const fileName = preferredName || getFileNameFromUrl(absoluteUrl) || "dropped-file";
        const fileType = blob.type || guessMimeFromName(fileName);
        return new File([blob], fileName, { type: fileType });
    } catch {
        return null;
    }
}

function appendAttachmentsToBubble(msgDiv, attachments){
    if(!msgDiv || !attachments || !attachments.length) return;
    let wrap = msgDiv.querySelector(".msg-attachments");
    if(!wrap){
        wrap = document.createElement("div");
        wrap.className = "msg-attachments";
        wrap.style.display = "grid";
        wrap.style.gridTemplateColumns = "repeat(2, max-content)";
        wrap.style.gap = "8px";
        wrap.style.alignItems = "start";
        msgDiv.appendChild(wrap);
    }

    attachments.forEach((file) => {
        if(!file || !file.name) return;
        const exists = Array.from(wrap.querySelectorAll("a.msg-attachment"))
            .some(a => a.dataset.fileName === file.name && a.getAttribute("href") === (file.url || "#"));
        if(exists) return;
        const link = document.createElement("a");
        link.className = `msg-attachment attachment-card${file.kind === "download" ? " download" : ""}`;
        link.href = file.url || "#";
        if(file.kind === "download"){
            link.setAttribute("download", file.name || "merged.pdf");
            link.target = "_self";
            link.rel = "";
        } else {
            link.target = "_blank";
            link.rel = "noopener noreferrer";
        }
        if(file.kind === "view"){
            link.dataset.action = "view-merged-pdf";
        }
        link.dataset.fileName = file.name;
        if(file.mime || file.type){
            link.dataset.fileMime = file.mime || file.type;
        }
        buildAttachmentCard(link, file);
        makeAttachmentDraggable(link, file);
        wrap.appendChild(link);
    });
}

function closeFilePreviewModal(){
    if(!filePreviewModal || !filePreviewBody) return;
    filePreviewModal.classList.remove("show");
    filePreviewModal.setAttribute("aria-hidden", "true");
    filePreviewBody.innerHTML = "";
    filePreviewModal.classList.remove("image-viewer-mode");
    document.body.classList.remove("preview-open");
    activePreviewIsImage = false;
    activePreviewImageZoom = 1;
    if(activePreviewBlobUrl){
        URL.revokeObjectURL(activePreviewBlobUrl);
        activePreviewBlobUrl = null;
    }
}

function openFilePreviewFromBlob(blob, fileName = "File"){
    if(!filePreviewModal || !filePreviewBody || !filePreviewTitle || !blob) return;

    if(activePreviewBlobUrl){
        URL.revokeObjectURL(activePreviewBlobUrl);
        activePreviewBlobUrl = null;
    }

    const mime = blob.type || guessMimeFromName(fileName);
    const blobUrl = URL.createObjectURL(blob);
    activePreviewBlobUrl = blobUrl;
    filePreviewTitle.textContent = fileName || "File preview";
    filePreviewBody.innerHTML = "";
    activePreviewIsImage = false;
    activePreviewImageZoom = 1;

    if(mime.startsWith("image/")){
        const img = document.createElement("img");
        img.className = "file-preview-image";
        img.src = blobUrl;
        img.alt = fileName || "Preview image";
        // Add styles so the image scales to fill the modal window like ChatGPT
        img.style.maxWidth = "95vw";
        img.style.maxHeight = "90vh";
        img.style.width = "auto";
        img.style.height = "auto";
        img.style.objectFit = "contain";
        img.style.display = "block";
        img.style.margin = "auto";
        img.style.transformOrigin = "center center";
        img.addEventListener("click", () => {
            activePreviewImageZoom = activePreviewImageZoom > 1 ? 1 : 1.8;
            img.style.transform = `scale(${activePreviewImageZoom})`;
        });
        img.addEventListener("wheel", (e) => {
            e.preventDefault();
            const dir = e.deltaY > 0 ? -0.12 : 0.12;
            activePreviewImageZoom = Math.max(1, Math.min(3, activePreviewImageZoom + dir));
            img.style.transform = `scale(${activePreviewImageZoom})`;
        }, { passive: false });
        filePreviewBody.appendChild(img);
        activePreviewIsImage = true;
        filePreviewModal.classList.add("image-viewer-mode");
    } else if(mime === "application/pdf"){
        const wrapper = document.createElement("div");

        wrapper.style.display = "flex";
        wrapper.style.justifyContent = "center";
        wrapper.style.alignItems = "center";
        wrapper.style.width = "100%";
        wrapper.style.height = "100%";

        const frame = document.createElement("iframe");
        frame.className = "file-preview-frame";

        frame.style.width = "100%";
        frame.style.maxWidth = "1000px";
        frame.style.height = "90vh";
        frame.style.display = "block";
        frame.style.margin = "0 auto";
        frame.style.border = "none";
        frame.style.borderRadius = "8px";

        frame.src = blobUrl;
        frame.setAttribute("title", fileName || "PDF preview");

        wrapper.appendChild(frame);
        filePreviewBody.appendChild(wrapper);

        filePreviewModal.classList.remove("image-viewer-mode");
    } else {
        const frame = document.createElement("iframe");
        frame.className = "file-preview-frame";
        // Add styles so the iframe fills the modal window
        frame.style.width = "95vw";
        frame.style.height = "90vh";
        frame.style.border = "none";
        frame.src = blobUrl;
        frame.setAttribute("title", fileName || "File preview");
        filePreviewBody.appendChild(frame);
        filePreviewModal.classList.remove("image-viewer-mode");
    }

    // Ensure preview content always starts from the top so the toolbar is visible
    filePreviewBody.style.display = "flex";
    filePreviewBody.style.alignItems = "flex-start";   // prevents top from being cut
    filePreviewBody.style.justifyContent = "center";
    filePreviewBody.style.overflow = "auto";
    filePreviewBody.style.paddingTop = "20px";
    filePreviewBody.scrollTop = 0;
    filePreviewModal.classList.add("show");
    filePreviewModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("preview-open");
}

async function openFilePreviewFromUrl(url, fileName = "File"){
    if(!url) return;
    try{
        const res = await fetch(url, { method: "GET", credentials: "same-origin" });
        if(!res.ok) throw new Error("Failed to fetch file");
        const blob = await res.blob();
        openFilePreviewFromBlob(blob, fileName);
    } catch (err){
        console.error(err);
    }
}

function renderAttachmentsAboveUserBubble(chatBoxEl, attachments){
    if(!chatBoxEl || !attachments || !attachments.length) return;
    const wrap = document.createElement("div");
    wrap.className = "msg-attachments msg-attachments-user-above";
    wrap.style.display = "grid";
    wrap.style.gridTemplateColumns = "repeat(2, max-content)";
    wrap.style.gap = "8px";
    wrap.style.alignItems = "start";

    attachments.forEach((file) => {
        if(!file || !file.name) return;
        const link = document.createElement("a");
        link.className = "msg-attachment attachment-card";
        link.href = file.url || "#";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.dataset.fileName = file.name;
        if(file.mime || file.type){
            link.dataset.fileMime = file.mime || file.type;
        }
        buildAttachmentCard(link, file);
        makeAttachmentDraggable(link, file);
        wrap.appendChild(link);
    });

    chatBoxEl.appendChild(wrap);
}

function renderPendingFiles(){
    if(!pendingFilesWrap){
        updateScrollButtonAnchor();
        return;
    }
    pendingFilesWrap.innerHTML = "";
    if(!pendingFiles.length){
        pendingFilesWrap.classList.remove("show");
        updateScrollButtonAnchor();
        return;
    }
    pendingFilesWrap.classList.add("show");

    pendingFiles.forEach((file, index) => {
        const visual = getAttachmentVisualMeta(file.name, "file");
        const chip = document.createElement("div");
        chip.className = "file-chip";
        // ChatGPT-style colored chip for different file types
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if(ext === "pdf"){
            chip.style.background = "rgba(255, 149, 0, 0.22)";   // orange PDF color
            chip.style.border = "2px solid rgba(255, 149, 0, 0.75)";
        }
        else if(ext === "doc" || ext === "docx"){
            chip.style.background = "rgba(0, 122, 255, 0.22)";   // strong blue
            chip.style.border = "2px solid rgba(0, 122, 255, 0.75)";
        }
        else if(ext === "txt"){
            chip.style.background = "rgba(120, 120, 120, 0.22)";
            chip.style.border = "2px solid rgba(120, 120, 120, 0.65)";
        }
        // make chip size tightly wrap content so it doesn't create large empty spacing
        chip.style.display = "inline-flex";
        chip.style.alignItems = "center";
        chip.style.gap = "6px";
        chip.style.width = "fit-content";
        chip.style.paddingRight = "24px"; // small room for the X button only
        chip.style.maxWidth = "220px";
        chip.tabIndex = 0;
        chip.setAttribute("role", "button");
        chip.setAttribute("aria-label", `Open ${file.name}`);

        const meta = document.createElement("span");
        meta.className = "file-chip-meta";

        const name = document.createElement("span");
        name.className = "file-chip-name";
        name.textContent = file.name;

        const type = document.createElement("span");
        type.className = "file-chip-type";
        type.textContent = visual.label;

        const imageLike = isImageAttachment(file.name, file.type, "file");

        if(imageLike){
            // Remove chip/bubble styling for images
            chip.style.background = "transparent";
            chip.style.border = "none";
            chip.style.padding = "0";
            chip.style.maxWidth = "none";

            const preview = document.createElement("img");
            preview.className = "input-image-preview";
            preview.src = URL.createObjectURL(file);
            preview.alt = "image";
            preview.loading = "lazy";

            // Slightly larger image preview for input box
            preview.style.height = "96px";
            preview.style.width = "auto";
            preview.style.objectFit = "cover";
            preview.style.borderRadius = "10px";
            preview.style.display = "block";
            preview.style.maxWidth = "140px";

            chip.appendChild(preview);
        }else{
            const icon = document.createElement("span");
            icon.className = "file-chip-icon";
            icon.textContent = visual.icon;

            const meta = document.createElement("span");
            meta.className = "file-chip-meta";

            const name = document.createElement("span");
            name.className = "file-chip-name";
            name.textContent = file.name;

            const type = document.createElement("span");
            type.className = "file-chip-type";
            type.textContent = visual.label;

            meta.appendChild(name);
            meta.appendChild(type);

            chip.appendChild(icon);
            chip.appendChild(meta);
        }

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "file-chip-remove";
        removeBtn.textContent = "✕";
        removeBtn.onclick = () => {
            pendingFiles.splice(index, 1);
            renderPendingFiles();
            updateSendState();
        };
        removeBtn.addEventListener("mousedown", e => e.stopPropagation());
        removeBtn.addEventListener("click", e => e.stopPropagation());

        const openPreview = () => {
            openFilePreviewFromBlob(file, file.name);
        };
        chip.addEventListener("click", openPreview);
        chip.addEventListener("keydown", (e) => {
            if(e.key === "Enter" || e.key === " "){
                e.preventDefault();
                openPreview();
            }
        });

        // Style remove button to float over the image/file
        chip.style.position = "relative";
        removeBtn.style.position = "absolute";
        removeBtn.style.top = "4px";
        removeBtn.style.right = "4px";
        removeBtn.style.background = "rgba(0,0,0,0.75)";
        removeBtn.style.color = "white";
        removeBtn.style.borderRadius = "50%";
        removeBtn.style.width = "22px";
        removeBtn.style.height = "22px";
        removeBtn.style.fontSize = "13px";
        removeBtn.style.display = "flex";
        removeBtn.style.alignItems = "center";
        removeBtn.style.justifyContent = "center";
        removeBtn.style.zIndex = "10";
        removeBtn.style.cursor = "pointer";
        removeBtn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
        removeBtn.style.lineHeight = "1";

        // meta.appendChild(name);
        // meta.appendChild(type);
        // chip.appendChild(meta);
        chip.appendChild(removeBtn);
        pendingFilesWrap.appendChild(chip);
    });
    updateScrollButtonAnchor();
}

function addPendingFiles(fileList){
    const next = Array.from(fileList || [])
        .filter(isSupportedFile);
    if(!next.length) return;

    const existing = new Set(pendingFiles.map(fileIdentity));
    next.forEach(file => {
        const id = fileIdentity(file);
        if(existing.has(id)) return;
        pendingFiles.push(file);
        existing.add(id);
    });

    renderPendingFiles();
    updateSendState();
}

function clearPendingFiles(){
    pendingFiles = [];
    if(fileInput) fileInput.value = "";
    renderPendingFiles();
    updateSendState();
}

function setupInputAreaDnD(){
    if(!inputArea) return;

    const stop = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };

    ["dragenter", "dragover"].forEach(evt => {
        inputArea.addEventListener(evt, (e) => {
            stop(e);
            inputArea.classList.add("drag-over");
        });
    });

    ["dragleave", "dragend", "drop"].forEach(evt => {
        inputArea.addEventListener(evt, (e) => {
            stop(e);
            if(evt !== "drop"){
                inputArea.classList.remove("drag-over");
            }
        });
    });

    inputArea.addEventListener("drop", async (e) => {
        inputArea.classList.remove("drag-over");
        const files = e.dataTransfer?.files;
        if(files?.length){
            addPendingFiles(files);
            return;
        }

        const droppedUrls = [];
        const customUrl = e.dataTransfer?.getData("application/x-qyvera-file-url");
        const customName = e.dataTransfer?.getData("application/x-qyvera-file-name");
        if(customUrl){
            droppedUrls.push({ url: customUrl, name: customName || "" });
        } else {
            const uriListRaw = e.dataTransfer?.getData("text/uri-list") || "";
            uriListRaw
                .split(/\r?\n/)
                .map(s => s.trim())
                .filter(s => s && !s.startsWith("#"))
                .forEach(url => droppedUrls.push({ url, name: "" }));
            const textUrl = (e.dataTransfer?.getData("text/plain") || "").trim();
            if(textUrl && /^https?:\/\//i.test(textUrl)){
                droppedUrls.push({ url: textUrl, name: "" });
            }
        }

        if(droppedUrls.length){
            const builtFiles = await Promise.all(
                droppedUrls.map(item => fileFromDroppedUrl(item.url, item.name))
            );
            const validFiles = builtFiles.filter(Boolean);
            if(validFiles.length){
                addPendingFiles(validFiles);
            }
        }
    });
}
