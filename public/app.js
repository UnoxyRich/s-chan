const $ = (selector) => document.querySelector(selector);
const postForm = $('#post-form');
const postText = $('#post-text');
const postImage = $('#post-image');
const fileName = $('#file-name');
const imageStatus = $('#image-status');
const formMessage = $('#form-message');
const duplicateWarning = $('#duplicate-warning');
const duplicateCopy = $('#duplicate-copy');
const duplicateLink = $('#duplicate-link');
const postAnyway = $('#post-anyway');
const editPost = $('#edit-post');
const boardView = $('#board-view');
const threadView = $('#thread-view');
const threadList = $('#thread-list');
const threadPosts = $('#thread-posts');
const pagination = $('#pagination');
const pageSize = 15;
let pendingDuplicateConfirmation = false;
let selectedImage = null;
let compressedImage = null;
let imageCompression = Promise.resolve(null);

function showMessage(message = '', isError = false) {
  formMessage.textContent = message;
  formMessage.hidden = !message;
  formMessage.classList.toggle('error', isError);
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'just now';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function makeQuoteText(element, text) {
  const parts = text.split(/(>>\d+)/g);
  for (const part of parts) {
    const match = part.match(/^>>(\d+)$/);
    if (!match) {
      element.append(document.createTextNode(part));
      continue;
    }
    const link = document.createElement('a');
    link.className = 'quote-link';
    link.href = `/general/?post=${match[1]}`;
    link.textContent = part;
    element.append(link);
  }
}

function imageElement(url, alt, className) {
  if (!url) return null;
  const image = document.createElement('img');
  image.className = className;
  image.src = url;
  image.alt = alt;
  image.loading = 'lazy';
  return image;
}

function makeThreadCard(thread) {
  const article = document.createElement('article');
  article.className = 'thread-card';
  const content = document.createElement('div');
  content.className = 'thread-content';
  const meta = document.createElement('div');
  meta.className = 'thread-meta';
  const number = document.createElement('a');
  number.className = 'thread-number';
  number.href = `/general/?thread=${encodeURIComponent(thread.threadId)}`;
  number.textContent = `No. ${thread.threadNo}`;
  const author = document.createElement('span');
  author.textContent = 'Anonymous';
  const time = document.createElement('time');
  time.dateTime = thread.createdAt;
  time.textContent = formatTime(thread.createdAt);
  meta.append(number, author, time);
  const body = document.createElement('p');
  body.className = 'thread-body';
  makeQuoteText(body, thread.body || (thread.imageUrl ? '[Image]' : ''));
  const bottom = document.createElement('div');
  bottom.className = 'thread-bottom';
  const replies = document.createElement('span');
  replies.className = 'reply-count';
  replies.textContent = `${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}`;
  const reply = document.createElement('a');
  reply.className = 'reply-link';
  reply.href = `/general/?thread=${encodeURIComponent(thread.threadId)}#post-form-section`;
  reply.textContent = 'View Thread';
  bottom.append(replies, reply);
  content.append(meta, body, bottom);
  const image = imageElement(thread.imageUrl, `Image attached to post ${thread.postNo}`, 'thread-thumb');
  if (image) article.append(image);
  article.append(content);
  return article;
}

function makePost(post) {
  const article = document.createElement('article');
  article.className = `post-card${post.isOp ? ' op' : ''}`;
  article.id = `p${post.postNo}`;
  const main = document.createElement('div');
  main.className = 'post-main';
  const meta = document.createElement('div');
  meta.className = 'post-meta';
  const number = document.createElement('a');
  number.className = 'thread-number';
  number.href = `#p${post.postNo}`;
  number.textContent = `No. ${post.postNo}`;
  const author = document.createElement('span');
  author.textContent = 'Anonymous';
  const time = document.createElement('time');
  time.dateTime = post.createdAt;
  time.textContent = formatTime(post.createdAt);
  meta.append(number, author, time);
  if (post.isOp) {
    const label = document.createElement('span');
    label.className = 'post-label';
    label.textContent = 'OP';
    meta.append(label);
  }
  if (post.sage) {
    const sage = document.createElement('span');
    sage.className = 'sage-badge';
    sage.textContent = 'SAGE';
    meta.append(sage);
  }
  const body = document.createElement('p');
  body.className = 'post-body';
  makeQuoteText(body, post.body || (post.imageUrl ? '[Image]' : ''));
  main.append(meta, body);
  const image = imageElement(post.imageUrl, `Image attached to post ${post.postNo}`, 'post-image');
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
    const button = document.createElement('button');
    button.className = 'page-button';
    button.type = 'button';
    button.textContent = String(current);
    if (current === page) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => loadBoard(current));
    pagination.append(button);
  }
}

async function loadBoard(page = 1) {
  const response = await fetch(`/api/threads?page=${page}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Could not load threads. Refresh to try again.');
  const data = await response.json();
  $('#thread-total').textContent = String(data.totalThreads);
  threadList.replaceChildren(...data.threads.map(makeThreadCard));
  $('#empty-state').hidden = data.threads.length > 0;
  renderPagination(data.page, data.totalPages);
  history.replaceState({}, '', data.page > 1 ? `/general/?page=${data.page}` : '/general/');
}

async function loadThread(threadId) {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 404 ? 'That thread has expired.' : 'Could not load this thread.');
  const data = await response.json();
  boardView.hidden = true;
  threadView.hidden = false;
  $('#thread-view-title').textContent = `No. ${data.thread.threadNo}`;
  $('#thread-count').textContent = `${data.posts.length - 1} / ${data.replyLimit} replies`;
  threadPosts.replaceChildren(...data.posts.map(makePost));
  $('#compose-title').textContent = `Reply to No. ${data.thread.threadNo}`;
  $('#submit-label').textContent = 'Post reply';
  $('#sage-wrap').hidden = false;
  history.replaceState({}, '', `/general/?thread=${encodeURIComponent(threadId)}`);
  if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView());
}

async function followQuote(postNo) {
  try {
    const response = await fetch(`/api/posts/${postNo}`);
    if (!response.ok) throw new Error('That post is no longer available.');
    const data = await response.json();
    await loadThread(data.threadId);
    history.replaceState({}, '', `/general/?thread=${encodeURIComponent(data.threadId)}#p${postNo}`);
    document.getElementById(`p${postNo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    showMessage(error.message, true);
  }
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('.quote-link');
  if (!link) return;
  event.preventDefault();
  const postNo = link.textContent.slice(2);
  followQuote(postNo);
});

postImage.addEventListener('change', () => {
  const file = postImage.files?.[0] || null;
  selectedImage = file;
  compressedImage = null;
  imageStatus.textContent = '';
  if (!file) {
    fileName.textContent = 'Images · metadata removed · 2 MB max';
    imageCompression = Promise.resolve(null);
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    postImage.value = '';
    selectedImage = null;
    fileName.textContent = 'Images · metadata removed · 2 MB max';
    showMessage('Choose an image under 20 MB. It will be compressed to 2 MB before upload.', true);
    return;
  }
  showMessage('');
  fileName.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB source`;
  imageStatus.textContent = 'Preparing image…';
  const currentFile = file;
  imageCompression = import('/bundle/compress-image.js')
    .then((module) => module.compressImage(currentFile))
    .then((compressed) => {
      if (selectedImage !== currentFile) return null;
      compressedImage = compressed;
      imageStatus.textContent = 'Ready · metadata removed';
      fileName.textContent = `${currentFile.name} · ${(currentFile.size / 1024 / 1024).toFixed(2)} → ${(compressed.size / 1024 / 1024).toFixed(2)} MB`;
      return compressed;
    })
    .catch((error) => {
      if (selectedImage === currentFile) {
        imageStatus.textContent = '';
        showMessage(error.message || 'This image format could not be converted.', true);
      }
      return null;
    });
});

postText.addEventListener('input', () => {
  $('#char-count').textContent = `${Array.from(postText.value).length.toLocaleString()} / 2,000`;
});

function clearWarning() {
  duplicateWarning.hidden = true;
  pendingDuplicateConfirmation = false;
}

editPost.addEventListener('click', () => {
  clearWarning();
  postText.focus();
  postText.select();
});

postAnyway.addEventListener('click', async () => {
  pendingDuplicateConfirmation = true;
  await submitPost(true);
});

async function submitPost(confirmSimilar = false) {
  showMessage('');
  if (!confirmSimilar) clearWarning();
  const button = postForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    if (selectedImage && !compressedImage) await imageCompression;
    if (selectedImage && !compressedImage) throw new Error('The image could not be prepared. Choose it again and retry.');
    const form = new FormData(postForm);
    if (selectedImage && compressedImage) form.set('image', compressedImage, 's-chan-image.webp');
    if ($('#sage').checked) form.set('sage', 'true');
    else form.delete('sage');
    if (confirmSimilar || pendingDuplicateConfirmation) form.set('confirmSimilar', 'true');
    const params = new URLSearchParams(location.search);
    const threadId = params.get('thread');
    const endpoint = threadId ? `/api/threads/${encodeURIComponent(threadId)}/replies` : '/api/threads';
    const response = await fetch(endpoint, { method: 'POST', body: form });
    const data = await response.json();
    if (response.status === 409 && data.code === 'duplicate_warning') {
      pendingDuplicateConfirmation = false;
      duplicateCopy.textContent = `Your text is ${data.match.similarity}% similar to post No. ${data.match.postNo}. You can edit it or choose to post it anyway.`;
      duplicateLink.href = `/general/?thread=${encodeURIComponent(data.match.threadId)}#p${data.match.postNo}`;
      duplicateLink.onclick = (event) => {
        event.preventDefault();
        loadThread(data.match.threadId).then(() => {
          history.replaceState({}, '', `/general/?thread=${encodeURIComponent(data.match.threadId)}#p${data.match.postNo}`);
          document.getElementById(`p${data.match.postNo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      };
      duplicateWarning.hidden = false;
      return;
    }
    if (!response.ok) throw new Error(data.error || 'The post could not be saved.');
    clearWarning();
    postForm.reset();
    selectedImage = null;
    compressedImage = null;
    imageCompression = Promise.resolve(null);
    fileName.textContent = 'Images · metadata removed · 2 MB max';
    imageStatus.textContent = '';
    $('#char-count').textContent = '0 / 2,000';
    showMessage('Posted.');
    const destination = `/general/?thread=${encodeURIComponent(data.post.threadId)}#p${data.post.postNo}`;
    if (threadId) {
      await loadThread(threadId);
      history.replaceState({}, '', destination);
      document.getElementById(`p${data.post.postNo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      await loadThread(data.post.threadId);
      history.replaceState({}, '', destination);
    }
  } catch (error) {
    showMessage(error.message || 'The post could not be saved.', true);
  } finally {
    button.disabled = false;
  }
}

postForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitPost(false);
});

$('#refresh-board').addEventListener('click', () => loadBoard().catch((error) => showMessage(error.message, true)));

async function start() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.has('post')) {
      const response = await fetch(`/api/posts/${encodeURIComponent(params.get('post'))}`);
      if (response.ok) {
        const post = await response.json();
        await loadThread(post.threadId);
        history.replaceState({}, '', `/general/?thread=${encodeURIComponent(post.threadId)}#p${post.postNo}`);
        document.getElementById(`p${post.postNo}`)?.scrollIntoView();
        return;
      }
    }
    if (params.has('thread')) {
      await loadThread(params.get('thread'));
      return;
    }
    const page = Number.parseInt(params.get('page') || '1', 10);
    await loadBoard(Number.isFinite(page) ? page : 1);
  } catch (error) {
    showMessage(error.message || 'Could not load the board.', true);
  }
}

start();
