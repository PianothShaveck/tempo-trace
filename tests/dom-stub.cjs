'use strict';

// Deliberately small DOM/media double, not a renderer. Actual IDs and controls
// come from index.html so a missing/renamed application control fails at boot.
class Element {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase(); this.attributes = {...attrs};
    this.id = attrs.id || ''; this.dataset = {}; this.style = {}; this.children = [];
    this.listeners = new Map(); this.parentElement = null; this.textContent = '';
    this.className = attrs.class || ''; this.value = attrs.value || '';
    this.hidden = 'hidden' in attrs; this.disabled = 'disabled' in attrs;
    this.checked = 'checked' in attrs; this.open = false;
    this.currentTime = 0; this.paused = true; this.playbackRate = 1; this.readyState = 1;
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    this.classList = {
      add: name => {this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(' ');},
      remove: name => {this.className = this.className.split(/\s+/).filter(c => c !== name).join(' ');}
    };
  }
  addEventListener(type, callback) {if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback);}
  dispatch(type, overrides = {}) {
    const event = {type, target: this, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, ...overrides};
    const results = (this.listeners.get(type) || []).map(fn => fn(event));
    return {event, results};
  }
  append(...nodes) {for (const node of nodes) {node.parentElement = this; this.children.push(node);}}
  replaceChildren(...nodes) {this.children = []; this.append(...nodes);}
  setAttribute(name, value) {this.attributes[name] = String(value); if (name === 'id') this.id = String(value);}
  getAttribute(name) {return this.attributes[name] ?? null;}
  removeAttribute(name) {delete this.attributes[name];}
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(s => this.matches(s.trim()));
    const part = selector.match(/^([\w-]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
    if (!part) throw new Error('Unsupported test selector: ' + selector);
    const [, tag, attr, value] = part;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (!attr) return true;
    if (attr === 'open') return this.open;
    return attr in this.attributes && (value === undefined || this.attributes[attr] === value);
  }
  closest(selector) {for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null;}
  querySelectorAll(selector) {const found = []; const visit = node => {for (const child of node.children) {if (child.matches(selector)) found.push(child); visit(child);}}; visit(this); return found;}
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
  focus() {this.ownerDocument.activeElement = this;}
  blur() {if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;}
  contains(other) {return other === this || this.children.some(node => node.contains(other));}
  getBoundingClientRect() {return {left: 0, top: 0, right: 800, bottom: 300, width: 800, height: 300};}
  showModal() {this.open = true;}
  close() {this.open = false; this.dispatch('close');}
  reportValidity() {return true;}
  click() {if (!this.disabled) this.dispatch('click', {detail: 0});}
  remove() {if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);}
  load() {this.currentTime = 0;}
  pause() {if (!this.paused) {this.paused = true; this.dispatch('pause');}}
  play() {this.paused = false; this.dispatch('play'); return Promise.resolve();}
  get valueAsNumber() {return this.value.trim() === '' ? NaN : Number(this.value);}
}

function createDOM(html) {
  const document = new Element('document'); document.ownerDocument = document;
  const ids = new Map(), stack = [document];
  const voidTags = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'source', 'path', 'stop', 'use', 'circle', 'ellipse']);
  for (const match of html.matchAll(/<\/?([a-zA-Z][\w:-]*)\b([^>]*)>/g)) {
    const [token, tag, attributeText] = match;
    if (token.startsWith('</')) {if (stack.at(-1).tagName === tag.toUpperCase()) stack.pop(); continue;}
    const attrs = {};
    for (const attr of attributeText.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = attr[2] || '';
    const node = new Element(tag, attrs); node.ownerDocument = document;
    stack.at(-1).append(node); if (node.id) ids.set(node.id, node);
    if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(node);
  }
  document.getElementById = id => {if (!ids.has(id)) throw new Error('Missing HTML control #' + id); return ids.get(id);};
  document.createElement = tag => {const node = new Element(tag); node.ownerDocument = document; return node;};
  document.createTextNode = text => Object.assign(document.createElement('text'), {textContent: text});
  document.body = document.querySelector('body'); document.activeElement = document.body;
  for (const select of document.querySelectorAll('select')) select.value = (select.children.find(n => 'selected' in n.attributes) || select.children[0])?.value || '';
  return document;
}

module.exports = {createDOM, Element};
