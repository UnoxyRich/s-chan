(() => {
  // src/compress-image.ts
  var MAX_INPUT_BYTES = 20 * 1024 * 1024;
  var MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
  var MAX_EDGE = 2048;
  var MAX_PIXELS = 2e7;
  var QUALITIES = [0.82, 0.66, 0.5, 0.34, 0.2];
  var OUTPUT_TYPES = /* @__PURE__ */ new Set(["image/webp", "image/png", "image/jpeg"]);
  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("Your browser could not create a supported image format.");
    const type = dataUrl.slice(5, comma).split(";")[0];
    if (!OUTPUT_TYPES.has(type)) throw new Error("Your browser could not create a supported image format.");
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type });
  }
  async function encodeCanvasImage(canvas, quality) {
    let blob = null;
    if (typeof canvas.toBlob === "function") {
      blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    }
    if (!blob) blob = dataUrlToBlob(canvas.toDataURL("image/webp", quality));
    if (!OUTPUT_TYPES.has(blob.type)) throw new Error("Your browser could not create a supported image format.");
    return blob;
  }
  async function decodeImage(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file);
        return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } catch (e) {
      }
    }
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("This image could not be opened."));
        image.src = objectUrl;
      });
      return {
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(objectUrl)
      };
    } catch (e) {
      URL.revokeObjectURL(objectUrl);
      throw new Error("This image format is not supported by your browser, or the file is damaged.");
    }
  }
  async function compressImage(file) {
    if (file.size > MAX_INPUT_BYTES) {
      throw new Error("Choose an image under 20 MB. It will be compressed to 2 MB before upload.");
    }
    let decoded;
    try {
      decoded = await decodeImage(file);
    } catch (e) {
      throw new Error("This image format is not supported by your browser, or the file is damaged.");
    }
    try {
      if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_PIXELS) {
        throw new Error("This image is too large to process safely. Try a smaller image.");
      }
      const initialScale = Math.min(1, MAX_EDGE / decoded.width, MAX_EDGE / decoded.height);
      let width = Math.max(1, Math.round(decoded.width * initialScale));
      let height = Math.max(1, Math.round(decoded.height * initialScale));
      const canvas = document.createElement("canvas");
      for (let scaleStep = 0; scaleStep < 18; scaleStep += 1) {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error("Your browser could not prepare this image.");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(decoded.image, 0, 0, width, height);
        for (const quality of QUALITIES) {
          const output = await encodeCanvasImage(canvas, quality);
          if (output.size <= MAX_OUTPUT_BYTES) {
            const extension = output.type === "image/jpeg" ? "jpg" : output.type === "image/png" ? "png" : "webp";
            return new File([output], "s-chan-image.".concat(extension), { type: output.type, lastModified: Date.now() });
          }
          if (output.type === "image/png") break;
        }
        if (width <= 160 && height <= 160) break;
        width = Math.max(1, Math.round(width * 0.82));
        height = Math.max(1, Math.round(height * 0.82));
      }
      throw new Error("This image could not be compressed below 2 MB.");
    } finally {
      decoded.close();
    }
  }

  // src/app.js
  var $ = (selector) => document.querySelector(selector);
  var postForm = $("#post-form");
  var postText = $("#post-text");
  var postImage = $("#post-image");
  var fileName = $("#file-name");
  var imageStatus = $("#image-status");
  var formMessage = $("#form-message");
  var duplicateWarning = $("#duplicate-warning");
  var duplicateCopy = $("#duplicate-copy");
  var duplicateLink = $("#duplicate-link");
  var postAnyway = $("#post-anyway");
  var editPost = $("#edit-post");
  var boardView = $("#board-view");
  var threadView = $("#thread-view");
  var threadList = $("#thread-list");
  var threadPosts = $("#thread-posts");
  var pagination = $("#pagination");
  var pendingDuplicateConfirmation = false;
  var selectedImage = null;
  var compressedImage = null;
  var imageCompression = Promise.resolve(null);
  function showMessage(message = "", isError = false) {
    formMessage.textContent = message;
    formMessage.hidden = !message;
    formMessage.classList.toggle("error", isError);
  }
  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "just now";
    return new Intl.DateTimeFormat(void 0, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  }
  function makeQuoteText(element, text) {
    const parts = text.split(/(>>\d+)/g);
    for (const part of parts) {
      const match = part.match(/^>>(\d+)$/);
      if (!match) {
        element.append(document.createTextNode(part));
        continue;
      }
      const link = document.createElement("a");
      link.className = "quote-link";
      link.href = "/general/?post=".concat(match[1]);
      link.textContent = part;
      element.append(link);
    }
  }
  function imageElement(url, alt, className) {
    if (!url) return null;
    const image = document.createElement("img");
    image.className = className;
    image.src = url;
    image.alt = alt;
    image.loading = "lazy";
    return image;
  }
  function makeThreadCard(thread) {
    const article = document.createElement("article");
    article.className = "thread-card";
    const content = document.createElement("div");
    content.className = "thread-content";
    const meta = document.createElement("div");
    meta.className = "thread-meta";
    const number = document.createElement("a");
    number.className = "thread-number";
    number.href = "/general/?thread=".concat(encodeURIComponent(thread.threadId));
    number.textContent = "No. ".concat(thread.threadNo);
    const author = document.createElement("span");
    author.textContent = "Anonymous";
    const time = document.createElement("time");
    time.dateTime = thread.createdAt;
    time.textContent = formatTime(thread.createdAt);
    meta.append(number, author, time);
    const body = document.createElement("p");
    body.className = "thread-body";
    makeQuoteText(body, thread.body || (thread.imageUrl ? "[Image]" : ""));
    const bottom = document.createElement("div");
    bottom.className = "thread-bottom";
    const replies = document.createElement("span");
    replies.className = "reply-count";
    replies.textContent = "".concat(thread.replyCount, " ").concat(thread.replyCount === 1 ? "reply" : "replies");
    const reply = document.createElement("a");
    reply.className = "reply-link";
    reply.href = "/general/?thread=".concat(encodeURIComponent(thread.threadId), "#post-form-section");
    reply.textContent = "View Thread";
    bottom.append(replies, reply);
    content.append(meta, body, bottom);
    const image = imageElement(thread.imageUrl, "Image attached to post ".concat(thread.postNo), "thread-thumb");
    if (image) article.append(image);
    article.append(content);
    return article;
  }
  function makePost(post) {
    const article = document.createElement("article");
    article.className = "post-card".concat(post.isOp ? " op" : "");
    article.id = "p".concat(post.postNo);
    const main = document.createElement("div");
    main.className = "post-main";
    const meta = document.createElement("div");
    meta.className = "post-meta";
    const number = document.createElement("a");
    number.className = "thread-number";
    number.href = "#p".concat(post.postNo);
    number.textContent = "No. ".concat(post.postNo);
    const author = document.createElement("span");
    author.textContent = "Anonymous";
    const time = document.createElement("time");
    time.dateTime = post.createdAt;
    time.textContent = formatTime(post.createdAt);
    meta.append(number, author, time);
    if (post.isOp) {
      const label = document.createElement("span");
      label.className = "post-label";
      label.textContent = "OP";
      meta.append(label);
    }
    if (post.sage) {
      const sage = document.createElement("span");
      sage.className = "sage-badge";
      sage.textContent = "SAGE";
      meta.append(sage);
    }
    const body = document.createElement("p");
    body.className = "post-body";
    makeQuoteText(body, post.body || (post.imageUrl ? "[Image]" : ""));
    main.append(meta, body);
    const image = imageElement(post.imageUrl, "Image attached to post ".concat(post.postNo), "post-image");
    if (image) main.append(image);
    article.append(main);
    return article;
  }
  function renderPagination(page, totalPages) {
    pagination.replaceChildren();
    if (totalPages <= 1) return;
    const first = Math.max(1, page - 2);
    const last = Math.min(totalPages, first + 4);
    for (let current = first; current <= last; current += 1) {
      const button = document.createElement("button");
      button.className = "page-button";
      button.type = "button";
      button.textContent = String(current);
      if (current === page) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => loadBoard(current));
      pagination.append(button);
    }
  }
  async function loadBoard(page = 1) {
    const response = await fetch("/api/threads?page=".concat(page), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Could not load threads. Refresh to try again.");
    const data = await response.json();
    $("#thread-total").textContent = String(data.totalThreads);
    threadList.replaceChildren(...data.threads.map(makeThreadCard));
    $("#empty-state").hidden = data.threads.length > 0;
    renderPagination(data.page, data.totalPages);
    history.replaceState({}, "", data.page > 1 ? "/general/?page=".concat(data.page) : "/general/");
  }
  async function loadThread(threadId) {
    const response = await fetch("/api/threads/".concat(encodeURIComponent(threadId)), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(response.status === 404 ? "That thread has expired." : "Could not load this thread.");
    const data = await response.json();
    boardView.hidden = true;
    threadView.hidden = false;
    $("#thread-view-title").textContent = "No. ".concat(data.thread.threadNo);
    $("#thread-count").textContent = "".concat(data.posts.length - 1, " / ").concat(data.replyLimit, " replies");
    threadPosts.replaceChildren(...data.posts.map(makePost));
    $("#compose-title").textContent = "Reply to No. ".concat(data.thread.threadNo);
    $("#submit-label").textContent = "Post reply";
    $("#sage-wrap").hidden = false;
    history.replaceState({}, "", "/general/?thread=".concat(encodeURIComponent(threadId)));
    if (location.hash) requestAnimationFrame(() => {
      var _a;
      return (_a = document.getElementById(decodeURIComponent(location.hash.slice(1)))) == null ? void 0 : _a.scrollIntoView();
    });
  }
  async function followQuote(postNo) {
    var _a;
    try {
      const response = await fetch("/api/posts/".concat(postNo));
      if (!response.ok) throw new Error("That post is no longer available.");
      const data = await response.json();
      await loadThread(data.threadId);
      history.replaceState({}, "", "/general/?thread=".concat(encodeURIComponent(data.threadId), "#p").concat(postNo));
      (_a = document.getElementById("p".concat(postNo))) == null ? void 0 : _a.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      showMessage(error.message, true);
    }
  }
  document.addEventListener("click", (event) => {
    const link = event.target.closest(".quote-link");
    if (!link) return;
    event.preventDefault();
    const postNo = link.textContent.slice(2);
    followQuote(postNo);
  });
  postImage.addEventListener("change", () => {
    var _a;
    const file = ((_a = postImage.files) == null ? void 0 : _a[0]) || null;
    selectedImage = file;
    compressedImage = null;
    imageStatus.textContent = "";
    if (!file) {
      fileName.textContent = "Images \xB7 metadata removed \xB7 2 MB max";
      imageCompression = Promise.resolve(null);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      postImage.value = "";
      selectedImage = null;
      fileName.textContent = "Images \xB7 metadata removed \xB7 2 MB max";
      showMessage("Choose an image under 20 MB. It will be compressed to 2 MB before upload.", true);
      return;
    }
    showMessage("");
    fileName.textContent = "".concat(file.name, " \xB7 ").concat((file.size / 1024 / 1024).toFixed(2), " MB source");
    imageStatus.textContent = "Preparing image\u2026";
    const currentFile = file;
    imageCompression = Promise.resolve().then(() => compressImage(currentFile)).then((compressed) => {
      if (selectedImage !== currentFile) return null;
      compressedImage = compressed;
      imageStatus.textContent = "Ready \xB7 metadata removed";
      fileName.textContent = "".concat(currentFile.name, " \xB7 ").concat((currentFile.size / 1024 / 1024).toFixed(2), " \u2192 ").concat((compressed.size / 1024 / 1024).toFixed(2), " MB");
      return compressed;
    }).catch((error) => {
      if (selectedImage === currentFile) {
        imageStatus.textContent = "";
        showMessage(error.message || "This image format could not be converted.", true);
      }
      return null;
    });
  });
  postText.addEventListener("input", () => {
    $("#char-count").textContent = "".concat(Array.from(postText.value).length.toLocaleString(), " / 2,000");
  });
  function clearWarning() {
    duplicateWarning.hidden = true;
    pendingDuplicateConfirmation = false;
  }
  editPost.addEventListener("click", () => {
    clearWarning();
    postText.focus();
    postText.select();
  });
  postAnyway.addEventListener("click", async () => {
    pendingDuplicateConfirmation = true;
    await submitPost(true);
  });
  async function submitPost(confirmSimilar = false) {
    var _a;
    showMessage("");
    if (!confirmSimilar) clearWarning();
    const button = postForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      if (selectedImage && !compressedImage) await imageCompression;
      if (selectedImage && !compressedImage) throw new Error("The image could not be prepared. Choose it again and retry.");
      const form = new FormData(postForm);
      if (selectedImage && compressedImage) form.set("image", compressedImage);
      if ($("#sage").checked) form.set("sage", "true");
      else form.delete("sage");
      if (confirmSimilar || pendingDuplicateConfirmation) form.set("confirmSimilar", "true");
      const params = new URLSearchParams(location.search);
      const threadId = params.get("thread");
      const endpoint = threadId ? "/api/threads/".concat(encodeURIComponent(threadId), "/replies") : "/api/threads";
      const response = await fetch(endpoint, { method: "POST", body: form });
      const data = await response.json();
      if (response.status === 409 && data.code === "duplicate_warning") {
        pendingDuplicateConfirmation = false;
        duplicateCopy.textContent = "Your text is ".concat(data.match.similarity, "% similar to post No. ").concat(data.match.postNo, ". You can edit it or choose to post it anyway.");
        duplicateLink.href = "/general/?thread=".concat(encodeURIComponent(data.match.threadId), "#p").concat(data.match.postNo);
        duplicateLink.onclick = (event) => {
          event.preventDefault();
          loadThread(data.match.threadId).then(() => {
            var _a2;
            history.replaceState({}, "", "/general/?thread=".concat(encodeURIComponent(data.match.threadId), "#p").concat(data.match.postNo));
            (_a2 = document.getElementById("p".concat(data.match.postNo))) == null ? void 0 : _a2.scrollIntoView({ behavior: "smooth", block: "center" });
          });
        };
        duplicateWarning.hidden = false;
        return;
      }
      if (!response.ok) throw new Error(data.error || "The post could not be saved.");
      clearWarning();
      postForm.reset();
      selectedImage = null;
      compressedImage = null;
      imageCompression = Promise.resolve(null);
      fileName.textContent = "Images \xB7 metadata removed \xB7 2 MB max";
      imageStatus.textContent = "";
      $("#char-count").textContent = "0 / 2,000";
      showMessage("Posted.");
      const destination = "/general/?thread=".concat(encodeURIComponent(data.post.threadId), "#p").concat(data.post.postNo);
      if (threadId) {
        await loadThread(threadId);
        history.replaceState({}, "", destination);
        (_a = document.getElementById("p".concat(data.post.postNo))) == null ? void 0 : _a.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        await loadThread(data.post.threadId);
        history.replaceState({}, "", destination);
      }
    } catch (error) {
      showMessage(error.message || "The post could not be saved.", true);
    } finally {
      button.disabled = false;
    }
  }
  postForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitPost(false);
  });
  $("#refresh-board").addEventListener("click", () => loadBoard().catch((error) => showMessage(error.message, true)));
  async function start() {
    var _a;
    try {
      const params = new URLSearchParams(location.search);
      if (params.has("post")) {
        const response = await fetch("/api/posts/".concat(encodeURIComponent(params.get("post"))));
        if (response.ok) {
          const post = await response.json();
          await loadThread(post.threadId);
          history.replaceState({}, "", "/general/?thread=".concat(encodeURIComponent(post.threadId), "#p").concat(post.postNo));
          (_a = document.getElementById("p".concat(post.postNo))) == null ? void 0 : _a.scrollIntoView();
          return;
        }
      }
      if (params.has("thread")) {
        await loadThread(params.get("thread"));
        return;
      }
      const page = Number.parseInt(params.get("page") || "1", 10);
      await loadBoard(Number.isFinite(page) ? page : 1);
    } catch (error) {
      showMessage(error.message || "Could not load the board.", true);
    }
  }
  start();
})();
