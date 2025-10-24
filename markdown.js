const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const MarkdownIt = require('markdown-it');
const markdownItKatex = require('markdown-it-katex');

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true
});

md.use(markdownItKatex, {
  throwOnError: false,
  output: 'html'
});

md.core.ruler.after('inline', 'file-card', state => {
  const isValidFileCode = value => /^[A-Za-z0-9]{4,64}$/.test(value || '');
  const isValidHttpUrl = value => /^https?:\/\//i.test(value || '');

  const createCardToken = (payload, kind) => {
    const token = new state.Token('html_inline', '', 0);
    token.content = renderFileCardHTML(payload, kind);
    return token;
  };

  state.tokens.forEach(blockToken => {
    if (blockToken.type !== 'inline' || !blockToken.children) return;

    const children = blockToken.children;
    for (let i = 0; i < children.length; i += 1) {
      const token = children[i];

      if (token.type === 'link_open') {
        const textToken = children[i + 1];
        const closeToken = children[i + 2];
        if (
          textToken &&
          textToken.type === 'text' &&
          textToken.content.trim().toLowerCase() === 'file' &&
          closeToken &&
          closeToken.type === 'link_close'
        ) {
          const href = (token.attrGet('href') || '').trim();
          if (!href) continue;

          if (isValidFileCode(href)) {
            const cardToken = createCardToken(href.toUpperCase(), 'code');
            children.splice(i, 3, cardToken);
            i -= 1;
          } else if (isValidHttpUrl(href)) {
            const cardToken = createCardToken(href, 'url');
            children.splice(i, 3, cardToken);
            i -= 1;
          }
        }
      } else if (token.type === 'image') {
        const alt = (token.content || '').trim().toLowerCase();
        const src = (token.attrGet('src') || '').trim();
        if (alt !== 'file' || !src) continue;

        if (isValidFileCode(src)) {
          const cardToken = createCardToken(src.toUpperCase(), 'code');
          children.splice(i, 1, cardToken);
          i -= 1;
        } else if (isValidHttpUrl(src)) {
          const cardToken = createCardToken(src, 'url');
          children.splice(i, 1, cardToken);
          i -= 1;
        }
      }
    }
  });
});

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (
    data.attrName === 'style' &&
    typeof node.closest === 'function' &&
    node.closest('.katex')
  ) {
    data.keepAttr = true;
  }
});

const purifyConfig = {
  ALLOW_DATA_ATTR: true,
  ALLOW_DATA_URLS: true,
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|ftp|mailto|tel|data:image\/(?:gif|png|apng|webp|jpe?g);base64,))/i,
  ADD_ATTR: [
    'aria-hidden',
    'focusable',
    'tabindex',
    'encoding',
    'data-user-id',
    'data-file-code',
    'data-file-state',
    'data-file-url'
  ],
  ALLOWED_ATTR: [
    'class',
    'id',
    'style',
    'href',
    'title',
    'rel',
    'target',
    'aria-hidden',
    'tabindex',
    'encoding',
    'data-user-id',
    'data-file-code',
    'data-file-state',
    'data-file-url',
    'src',
    'alt',
    'srcset',
    'sizes',
    'loading',
    'decoding',
    'referrerpolicy',
    'type',
    'disabled'
  ]
};

function renderMarkdown(source, mentionMap) {
  const text = typeof source === 'string' ? source : '';
  const rendered = md.render(text);
  const sanitized = DOMPurify.sanitize(rendered, purifyConfig).trim();

  if (!sanitized) {
    return sanitized;
  }

  const dom = new JSDOM(`<body>${sanitized}</body>`);
  const { document, NodeFilter } = dom.window;

  document.querySelectorAll('img').forEach(img => {
    if (!img.hasAttribute('loading')) {
      img.setAttribute('loading', 'lazy');
    }
    if (!img.hasAttribute('decoding')) {
      img.setAttribute('decoding', 'async');
    }
    if (!img.hasAttribute('referrerpolicy')) {
      img.setAttribute('referrerpolicy', 'no-referrer');
    }

    const altRaw = (img.getAttribute('alt') || '').trim();
    const altNormalized = altRaw.replace(/^:|:$/g, '').toLowerCase();
    if (
      altNormalized &&
      (altNormalized === 'emoji' ||
        (altRaw.startsWith(':') && altRaw.endsWith(':')))
    ) {
      img.classList.add('emoji-inline');
      img.setAttribute('role', 'img');
      img.setAttribute('aria-label', altNormalized);
      img.setAttribute('alt', '');
    }
  });

  transformFileTokens(document);

  if (!mentionMap || mentionMap.size === 0) {
    return document.body.innerHTML.trim();
  }

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT
  );
  const mentionRegex = /@([^\s@]+)(?=\s|$)/g;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const textContent = node.textContent;
    let lastIndex = 0;
    const fragments = [];
    let match;

    while ((match = mentionRegex.exec(textContent)) !== null) {
      const label = match[1];
      const userId = mentionMap.get(label);
      if (!userId) continue;

      if (match.index > lastIndex) {
        fragments.push(
          document.createTextNode(textContent.slice(lastIndex, match.index))
        );
      }

      const span = document.createElement('span');
      span.className = 'mention';
      span.dataset.userId = String(userId);
      span.textContent = `@${label}`;
      fragments.push(span);

      lastIndex = match.index + match[0].length;
    }

    if (fragments.length) {
      if (lastIndex < textContent.length) {
        fragments.push(
          document.createTextNode(textContent.slice(lastIndex))
        );
      }
      const parent = node.parentNode;
      fragments.forEach(fragment => parent.insertBefore(fragment, node));
      parent.removeChild(node);
    }
  }

  return document.body.innerHTML.trim();
}

function transformFileTokens(document) {
  if (!document || !document.body) return;

  const anchors = Array.from(document.querySelectorAll('a'));
  anchors.forEach(anchor => {
    const label = (anchor.textContent || '').trim().toLowerCase();
    const href = (anchor.getAttribute('href') || '').trim();
    if (label !== 'file') return;
    if (!href) return;

    if (/^[A-Za-z0-9]{4,64}$/.test(href)) {
      const card = createFileCard(document, href.toUpperCase(), 'code');
      anchor.replaceWith(card);
    } else if (/^https?:\/\//i.test(href)) {
      const card = createFileCard(document, href, 'url');
      anchor.replaceWith(card);
    }
  });

  const images = Array.from(document.querySelectorAll('img'));
  images.forEach(img => {
    const alt = (img.getAttribute('alt') || '').trim().toLowerCase();
    const src = (img.getAttribute('src') || '').trim();
    if (alt !== 'file') return;
    if (!src) return;

    if (/^[A-Za-z0-9]{4,64}$/.test(src)) {
      const card = createFileCard(document, src.toUpperCase(), 'code');
      img.replaceWith(card);
    } else if (/^https?:\/\//i.test(src)) {
      const card = createFileCard(document, src, 'url');
      img.replaceWith(card);
    }
  });
}

function renderFileCardHTML(value, kind) {
  const isUrl = kind === 'url';
  const props = isUrl
    ? `data-file-url="${value}"`
    : `data-file-code="${value}"`;
  const label = isUrl ? '外部链接' : `文件编码 ${value}`;
  const info = isUrl
    ? '这是一个外部直链资源，可直接下载。'
    : '正在加载文件信息…';

  return [
    `<div class="file-card" ${props} data-file-state="idle">`,
    '  <div class="file-card-preview" aria-hidden="true">FILE</div>',
    '  <div class="file-card-meta">',
    `    <div class="file-card-name">${label}</div>`,
    `    <div class="file-card-info">${info}</div>`,
    '  </div>',
    '  <div class="file-card-actions">',
    '    <button type="button" class="file-card-download">下载</button>',
    '  </div>',
    '</div>'
  ].join('');
}

function createFileCard(document, value, kind) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderFileCardHTML(value, kind);
  return wrapper.firstChild;
}

module.exports = {
  renderMarkdown
};
