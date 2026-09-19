/* Markdown lexer: marked 15.0.12 (MIT, bundled offline). Only known tokens become DOM.
 * Raw HTML remains literal text; images never auto-load; no model HTML is inserted. */
(() => {
  'use strict';
  const decoder = document.createElement('textarea');
  function decode(text) {
    return String(text ?? '').replace(/&(?:#[0-9]{1,8}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, entity => {
      // Input here is exactly one entity without < or >, never arbitrary HTML.
      decoder.innerHTML = entity;
      return decoder.value;
    });
  }
  function safeLink(value) {
    try {
      const text = decode(value);
      if (!/^https?:\/\//i.test(text) || /[\u0000-\u0020\u007f\\]/.test(text)) return null;
      const url = new URL(text);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }
  function node(tag, text) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function renderTokens(tokens, depth = 0) {
    if (depth > 48) throw new Error('Markdown nesting limit');
    const fragment = document.createDocumentFragment();
    for (const token of tokens || []) {
      let el;
      const children = () => renderTokens(token.tokens, depth + 1);
      switch (token.type) {
        case 'space': continue;
        case 'paragraph': el = node('p'); el.append(children()); break;
        case 'heading': el = node(`h${Math.min(6, Math.max(1, token.depth))}`); el.append(children()); break;
        case 'strong': case 'em': case 'del': el = node(token.type); el.append(children()); break;
        case 'blockquote': el = node('blockquote'); el.append(children()); break;
        case 'br': el = node('br'); break;
        case 'hr': el = node('hr'); break;
        case 'code': {
          el = node('pre'); el.tabIndex = 0;
          el.append(node('code', token.text));
          if (token.lang) el.setAttribute('aria-label', '代码：' + token.lang.slice(0, 80));
          break;
        }
        case 'codespan': el = node('code', token.text); break;
        case 'link': {
          const href = safeLink(token.href);
          el = node(href ? 'a' : 'span'); el.append(children());
          if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; el.referrerPolicy = 'no-referrer'; }
          if (token.title) el.title = decode(token.title);
          break;
        }
        case 'image': {
          // Avoid loading remote tracking images or leaking a local page visit.
          el = node('span', `[图片：${decode(token.text) || '未命名'}]`);
          el.className = 'md-image-placeholder';
          break;
        }
        case 'list': {
          el = node(token.ordered ? 'ol' : 'ul');
          if (token.ordered && Number.isSafeInteger(token.start)) el.start = token.start;
          for (const item of token.items) {
            const li = node('li');
            if (item.task) {
              const check = node('input'); check.type = 'checkbox'; check.disabled = true; check.checked = !!item.checked;
              check.setAttribute('aria-label', item.checked ? '已勾选（仅展示）' : '未勾选（仅展示）');
              li.append(check); li.className = 'md-task';
            }
            li.append(renderTokens(item.tokens, depth + 1)); el.append(li);
          }
          break;
        }
        case 'table': {
          el = node('div'); el.className = 'md-table-wrap'; el.tabIndex = 0;
          const table = node('table'), head = node('thead'), body = node('tbody');
          const row = (cells, tag) => {
            const tr = node('tr');
            for (const cell of cells) {
              const td = node(tag); td.append(renderTokens(cell.tokens, depth + 1));
              if (['left', 'center', 'right'].includes(cell.align)) td.style.textAlign = cell.align;
              tr.append(td);
            }
            return tr;
          };
          head.append(row(token.header, 'th'));
          for (const cells of token.rows) body.append(row(cells, 'td'));
          table.append(head, body); el.append(table); break;
        }
        case 'text':
          if (token.tokens) { fragment.append(children()); continue; }
          el = document.createTextNode(token.escaped ? token.text : decode(token.text)); break;
        case 'escape': el = document.createTextNode(token.text); break;
        case 'html': el = document.createTextNode(token.raw ?? token.text ?? ''); break;
        default: el = document.createTextNode(token.raw ?? token.text ?? '');
      }
      fragment.append(el);
    }
    return fragment;
  }
  window.ClaudiaMarkdown = Object.freeze({
    render(target, content) {
      const text = typeof content === 'string' ? content : '';
      try {
        if (text.length > 200000 || !window.marked?.lexer) throw new Error('Markdown unavailable');
        const tokens = window.marked.lexer(text, { gfm: true, breaks: false, pedantic: false });
        target.replaceChildren(renderTokens(tokens));
        target.classList.add('markdown-body');
      } catch {
        target.textContent = text;
        target.classList.remove('markdown-body');
      }
    }
  });
})();
